import { authenticate, HttpError, json, readJson } from '../common.js';
import { convertedStream, geminiToOpenai, openaiToGemini, unwrap } from '../convert.js';
import { collectGoogleStream } from '../stream-collect.js';
import { callUpstream } from '../upstream.js';
import { discoverModels } from '../model-list.js';
import { recordAttempt } from '../reliability.js';
import { recordTelemetry } from '../metrics.js';
import { effectiveEnv } from '../settings.js';
import {
  anthropicToGemini,
  geminiToAnthropic,
  anthropicStream,
  estimateTokens,
  anthropicErrorType,
} from '../anthropic.js';

function validateModel(model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model)) {
    throw new HttpError(
      400,
      'model 只能包含字母、数字、点、下划线和短横线；Workers 版不支持功能前缀',
    );
  }
}

export async function generationRoute(request, env, fetcher, context) {
  const url = new URL(request.url);
  const mode = url.pathname.startsWith('/antigravity/') ? 'antigravity' : 'geminicli';
  const path = mode === 'antigravity' ? url.pathname.slice('/antigravity'.length) : url.pathname;
  const nativeMatch = path.match(
    /^\/v1(?:beta)?\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/,
  );
  const isOpenai = path === '/v1/chat/completions';
  const isAnthropic = path === '/v1/messages';
  const isCount = path === '/v1/messages/count_tokens' || nativeMatch?.[2] === 'countTokens';
  const isModelList = ['/v1/models', '/v1beta/models'].includes(path);
  if (!nativeMatch && !isOpenai && !isAnthropic && !isCount && !isModelList)
    throw new HttpError(
      404,
      '接口不存在；支持 OpenAI Chat Completions、Anthropic Messages 和 Gemini generateContent',
    );
  if (request.method !== (isModelList ? 'GET' : 'POST')) throw new HttpError(405, '请求方法不支持');
  await authenticate(request, env.API_PASSWORD, !!nativeMatch || path === '/v1beta/models');
  env = await effectiveEnv(env);
  if (isModelList) {
    const result = await discoverModels(env, mode, fetcher);
    const response =
      path === '/v1beta/models'
        ? json({
            models: result.ids.map((id) => ({
              name: `models/${id}`,
              displayName: id,
              supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
            })),
          })
        : json({
            object: 'list',
            data: result.ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'google' })),
          });
    response.headers.set('x-model-list-source', result.source);
    if (result.source === 'fallback')
      response.headers.set('x-model-list-warning', 'dynamic-discovery-failed');
    return response;
  }
  const body = await readJson(request);
  const model =
    isOpenai || isAnthropic || path === '/v1/messages/count_tokens' ? body.model : nativeMatch[1];
  validateModel(model);
  if ((isOpenai || isAnthropic) && body.stream != null && typeof body.stream !== 'boolean')
    throw new HttpError(400, 'stream 必须为布尔值');
  const geminiRequest = isOpenai
    ? openaiToGemini(body)
    : isAnthropic || path === '/v1/messages/count_tokens'
      ? anthropicToGemini(body, isCount)
      : body;
  if (!Array.isArray(geminiRequest.contents) || !geminiRequest.contents.length)
    throw new HttpError(400, 'contents 不能为空');
  if (isCount) {
    const count = estimateTokens(geminiRequest);
    const result = json(
      path === '/v1/messages/count_tokens' ? { input_tokens: count } : { totalTokens: count },
    );
    result.headers.set('x-token-count-estimated', 'true');
    return result;
  }
  if (!env.DB) throw new HttpError(503, '未绑定 D1 数据库');
  const stream =
    isOpenai || isAnthropic ? body.stream === true : nativeMatch[2] === 'streamGenerateContent';
  const collect = mode === 'antigravity' && !stream && env.ANTIGRAVITY_STREAM2NOSTREAM;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const incomingSignal = request.signal;
  if (incomingSignal?.aborted) cancel();
  incomingSignal?.addEventListener('abort', cancel, { once: true });
  let handedOff = false;
  const requestId = crypto.randomUUID();
  const attemptMeta = { requestId, attempts: [] };
  const started = Date.now();
  let usageSaved = false;
  let latestUsage;
  const persist = (task) => {
    context?.waitUntil?.(task);
    return task;
  };
  const finishUsage = async (status, outcome, usage) => {
    if (usageSaved) return;
    usageSaved = true;
    await persist(
      recordTelemetry(env, {
        requestId,
        row: attemptMeta.row,
        mode,
        model: attemptMeta.model || model,
        status,
        outcome,
        usage,
        started,
        attempts: attemptMeta.attempts,
      }),
    );
  };
  const completed = (usage) => finishUsage(200, 'success', usage);
  try {
    const response = await callUpstream(
      env,
      mode,
      model,
      geminiRequest,
      stream || collect,
      abort.signal,
      fetcher,
      attemptMeta,
    );
    if (!response.ok) {
      await finishUsage(response.status, 'failed');
      if (isAnthropic) {
        let message = `Google 返回 HTTP ${response.status}`;
        try {
          const value = await response.json();
          if (typeof value.error?.message === 'string')
            message = value.error.message.slice(0, 2000);
        } catch {}
        const result = json(
          {
            type: 'error',
            error: { type: anthropicErrorType(response.status), message },
            request_id: requestId,
          },
          response.status,
        );
        result.headers.set('x-request-id', requestId);
        if (response.headers.has('retry-after'))
          result.headers.set('retry-after', response.headers.get('retry-after'));
        return result;
      }
      // Keep Google's error and status so location/eligibility issues remain diagnosable.
      const result = new Response(response.body, {
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
          'x-request-id': requestId,
          ...(response.headers.has('retry-after')
            ? { 'retry-after': response.headers.get('retry-after') }
            : {}),
        },
      });
      return result;
    }
    if (stream) {
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new HttpError(502, '上游未返回 SSE 流');
      }
      const finish = () => incomingSignal?.removeEventListener('abort', cancel);
      const streamFailure = (usage, cancelled = false) =>
        persist(
          (async () => {
            if (usageSaved) return;
            const status = cancelled || abort.signal.aborted ? 499 : 502;
            if (attemptMeta.row)
              await recordAttempt(
                env.DB,
                {
                  requestId,
                  row: attemptMeta.row,
                  mode,
                  model: attemptMeta.model || model,
                  status,
                  stage: status === 499 ? 'client_cancelled' : 'stream_error',
                  code: status === 499 ? 'CLIENT_CANCELLED' : 'STREAM_INTERRUPTED',
                  started,
                },
                attemptMeta,
              );
            await finishUsage(status, status === 499 ? 'cancelled' : 'failed', usage);
          })(),
        );
      const converted = isAnthropic
        ? anthropicStream(response.body, model, cancel, finish, streamFailure, completed, (usage) =>
            streamFailure(usage, true),
          )
        : convertedStream(
            response.body,
            model,
            isOpenai,
            body.stream_options?.include_usage === true,
            cancel,
            finish,
            streamFailure,
            completed,
            (usage) => streamFailure(usage, true),
          );
      handedOff = true;
      return new Response(converted, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-request-id': requestId,
        },
      });
    }
    let value;
    if (collect) {
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new HttpError(502, '上游未返回 SSE 流');
      }
      value = await collectGoogleStream(response.body);
    } else {
      try {
        value = await response.json();
      } catch {
        throw new HttpError(502, '上游返回了无效 JSON');
      }
    }
    const unwrapped = unwrap(value);
    latestUsage = unwrapped.usageMetadata;
    if (
      unwrapped.error ||
      (!unwrapped.candidates?.length && !unwrapped.promptFeedback?.blockReason)
    )
      throw new HttpError(502, '上游未返回有效的生成结果');
    const result = json(
      isOpenai
        ? geminiToOpenai(value, model)
        : isAnthropic
          ? geminiToAnthropic(value, model)
          : unwrap(value),
    );
    result.headers.set('x-request-id', requestId);
    if (collect) result.headers.set('x-upstream-mode', 'stream-collected');
    await completed(latestUsage);
    return result;
  } catch (error) {
    if (attemptMeta.row && attemptMeta.headersReceived && !handedOff) {
      error.operation ||= collect ? 'stream_collection' : 'response_processing';
      await recordAttempt(
        env.DB,
        {
          requestId,
          row: attemptMeta.row,
          mode,
          model: attemptMeta.model || model,
          status: error.status || 500,
          stage: error.operation,
          code: 'UPSTREAM_RESPONSE_INVALID',
          started,
        },
        attemptMeta,
      );
    }
    await finishUsage(
      abort.signal.aborted ? 499 : error.status || 500,
      abort.signal.aborted ? 'cancelled' : 'failed',
      latestUsage,
    );
    error.requestId = requestId;
    throw error;
  } finally {
    if (!handedOff) incomingSignal?.removeEventListener('abort', cancel);
  }
}
