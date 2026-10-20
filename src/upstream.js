import { HttpError, googleFetch, operation } from './common.js';
import { accessToken, selectCredential } from './credentials.js';
import { cooldownSeconds, putCooldown, recordAttempt } from './reliability.js';
import { loadModelNames, knownModelId, publicModelId } from './model-names.js';
import { normalizeRequest } from './normalize.js';

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
  await loadModelNames(env, mode);
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
  const initialRow = meta.initialRow;
  delete meta.initialRow;
  let row =
    initialRow ||
    (await operation('credential_select', () =>
      selectCredential(env.DB, mode, model, [], env.CREDENTIAL_SELECTION),
    ));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    used.push(row.id);
    meta.row = row;
    meta.headersReceived = false;
    const started = Date.now();
    let logged = false;
    try {
      if (!row.data.project_id)
        throw new HttpError(400, '此凭证缺少 project_id，请在管理页校验项目或重新导入');
      const payload = upstreamPayload(request, model, row.data.project_id, mode, true);
      let token = await operation('oauth_refresh', () =>
        accessToken(env.DB, row, fetcher, false, env),
      );
      const send = () =>
        googleFetch(
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
          'generation_fetch',
        );
      let response = await send();
      if (response.status === 401 && row.data.refresh_token) {
        await response.body?.cancel();
        token = await operation('oauth_refresh', () =>
          accessToken(env.DB, row, fetcher, true, env),
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
      if (![429, 500, 503].includes(response.status)) return response;
      const seconds = cooldownSeconds(response);
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
          selectCredential(env.DB, mode, model, used, env.CREDENTIAL_SELECTION),
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
            status: signal?.aborted ? 499 : error.status || 500,
            stage: error.operation || 'generation_prepare',
            code: error.errorCode || 'REQUEST_FAILED',
            started,
          },
          meta,
        );
      error.requestId = requestId;
      throw error;
    }
  }
}
