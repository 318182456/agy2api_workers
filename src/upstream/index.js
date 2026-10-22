import { retryableStatus, clientAborted, fetchGeneration, boundedSeconds } from './timeouts.js';
import { HttpError, operation } from '../core/common.js';
import { accessToken, selectCredential } from '../credentials/index.js';
import { quotaCooldown, putCooldown, recordAttempt } from './reliability.js';
import { loadModelNames, knownModelId, publicModelId } from '../models/names.js';
import { normalizeRequest } from '../protocols/gemini.js';

export function upstreamOrigin(env, mode) {
  const value =
    mode === 'antigravity'
      ? env.ANTIGRAVITY_API_URL || 'https://daily-cloudcode-pa.googleapis.com'
      : env.CODE_ASSIST_ENDPOINT || 'https://cloudcode-pa.googleapis.com';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(503, '上游地址配置错误');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new HttpError(503, '上游地址必须为 HTTPS origin，不能包含路径或密码');
  }
  return url.origin;
}

export function upstreamPayload(request, model, project, mode, prepared = false) {
  const normalized = prepared
    ? { model, request: structuredClone(request) }
    : normalizeRequest(request, model, mode);
  const payload = { model: normalized.model, project, request: normalized.request };
  if (mode === 'antigravity') {
    payload.userAgent = 'antigravity';
    payload.requestType = 'agent';
    payload.requestId = `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`;
    delete payload.request.safetySettings;
    payload.request.sessionId ||= `-${BigInt('0x' + crypto.randomUUID().replaceAll('-', '').slice(0, 15))}`;
  }
  return payload;
}

export async function callUpstream(
  env,
  mode,
  model,
  request,
  stream,
  signal,
  fetcher = fetch,
  meta = {},
) {
  const initialRow = meta.initialRow;
  delete meta.initialRow;
  if (initialRow) meta.row = initialRow;
  meta.mode = mode;
  meta.phase = 'model_catalog';
  await operation('model_catalog', () => loadModelNames(env, mode));
  meta.phase = 'request_prepare';
  const known = knownModelId(env, mode, model);
  const normalized = normalizeRequest(request, model, mode);
  model = known || normalized.model;
  meta.model = publicModelId(env, mode, model);
  request = normalized.request;
  const requestId = meta.requestId || crypto.randomUUID();
  const configured = Number(env.MAX_CREDENTIAL_ATTEMPTS ?? 3);
  const maxAttempts = Number.isFinite(configured)
    ? Math.max(1, Math.min(5, Math.floor(configured)))
    : 3;
  const used = [];
  const origin = upstreamOrigin(env, mode);
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  meta.phase = 'credential_select';
  let row =
    initialRow ||
    (await operation('credential_select', () =>
      selectCredential(env.DB, mode, model, [], env.CREDENTIAL_SELECTION, null, env),
    ));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    used.push(row.id);
    meta.row = row;
    meta.phase = 'request_prepare';
    meta.headersReceived = false;
    const started = Date.now();
    let logged = false;
    try {
      if (!row.data.project_id)
        throw new HttpError(400, '此凭证缺少 project_id，请在管理页校验项目或重新导入');
      const prepared = structuredClone(request);
      if (env.RETURN_THOUGHTS === false)
        prepared.generationConfig = {
          ...prepared.generationConfig,
          thinkingConfig: { ...prepared.generationConfig?.thinkingConfig, includeThoughts: false },
        };
      if (mode === 'antigravity' && env.STABLE_SESSION !== false && !prepared.sessionId) {
        const first = prepared.contents?.find((content) => content.role === 'user');
        const text = (first?.parts || [])
          .filter((part) => typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n');
        if (text) {
          const digest = new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(
                row.data.project_id + '\n' + (env.SESSION_SCOPE || '') + '\n' + text,
              ),
            ),
          );
          prepared.sessionId =
            '-' +
            (BigInt(
              '0x' +
                Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join(
                  '',
                ),
            ) &
              0x7fffffffffffffffn);
        }
      }
      const payload = upstreamPayload(prepared, model, row.data.project_id, mode, true);
      if (mode === 'antigravity') {
        payload.request.labels ||= {
          model_enum: model,
          trajectory_id: payload.request.sessionId,
          last_step_index: '1',
          used_claude: String(model.includes('claude')),
          used_claude_conservative: String(model.includes('claude')),
        };
        if (env.ENABLE_AI_CREDITS === true && row.data.enable_credit === true)
          payload.enabledCreditTypes = ['GOOGLE_ONE_AI'];
      }
      let token = await operation('oauth_refresh', () =>
        accessToken(env.DB, row, fetcher, false, env, signal),
      );
      const send = () =>
        fetchGeneration(
          fetcher,
          `${origin}/v1internal:${action}`,
          {
            method: 'POST',
            redirect: 'manual',
            signal,
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'user-agent':
                mode === 'antigravity'
                  ? 'antigravity/hub/2.23.1 darwin/arm64'
                  : `Mozilla/5.0 (compatible; Google-Gemini-CLI/1.0; +https://github.com/google-gemini/gemini-cli) ${model}`,
            },
            body: JSON.stringify(payload),
          },
          boundedSeconds(env.UPSTREAM_TIMEOUT_SECONDS, 45, 5, 90),
        );
      let response = await send();
      if (response.status === 401 && row.data.refresh_token) {
        await response.body?.cancel();
        token = await operation('oauth_refresh', () =>
          accessToken(env.DB, row, fetcher, true, env, signal),
        );
        response = await send();
      }
      meta.headersReceived = response.ok;
      await recordAttempt(
        env.DB,
        {
          requestId,
          row,
          mode,
          model,
          status: response.status,
          stage: 'response_headers',
          code: response.ok ? null : 'HTTP_' + response.status,
          started,
        },
        meta,
      );
      logged = true;
      if (!retryableStatus(response.status)) return response;
      const seconds = await quotaCooldown(response, signal);
      await operation('credential_cooldown', () =>
        putCooldown(env.DB, row, model, response.status, seconds),
      );
      if (!response.headers.has('retry-after')) {
        response = new Response(response.body, response);
        response.headers.set('retry-after', String(seconds));
      }
      if (attempt + 1 >= maxAttempts || signal?.aborted) return response;
      let next;
      try {
        next = await operation('credential_select', () =>
          selectCredential(env.DB, mode, model, used, env.CREDENTIAL_SELECTION, null, env),
        );
      } catch (error) {
        if (error instanceof HttpError && [429, 503].includes(error.status)) return response;
        throw error;
      }
      // Discard a failed attempt only when another eligible credential is ready.
      await response.body?.cancel();
      row = next;
    } catch (error) {
      if (!logged)
        await recordAttempt(
          env.DB,
          {
            requestId,
            row,
            mode,
            model,
            status: clientAborted(signal) ? 499 : error.status || 500,
            stage: error.operation || 'generation_prepare',
            code: error.errorCode || 'REQUEST_FAILED',
            started,
          },
          meta,
        );
      error.requestId = requestId;
      if (
        !signal?.aborted &&
        attempt + 1 < maxAttempts &&
        ['UPSTREAM_TIMEOUT', 'UPSTREAM_CONNECTION_FAILED', 'OAUTH_REAUTH_REQUIRED'].includes(
          error.errorCode,
        )
      ) {
        let next;
        try {
          next = await operation('credential_select', () =>
            selectCredential(env.DB, mode, model, used, env.CREDENTIAL_SELECTION, null, env),
          );
        } catch (selectionError) {
          if (!(selectionError instanceof HttpError) || ![429, 503].includes(selectionError.status))
            throw selectionError;
        }
        if (next && next.id !== row.id) {
          row = next;
          continue;
        }
      }
      throw error;
    }
  }
}
