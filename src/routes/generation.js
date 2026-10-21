import { prepareClientTools, restoreToolNames } from '../protocols/tool-compat.js';
import { fakeStream } from '../upstream/fake-stream.js';
import { collectContinuations } from '../upstream/continuation.js';
import { boundedSeconds, clientAborted } from '../upstream/timeouts.js';
import { HttpError, json, readJson } from '../core/common.js';
import { authenticateApi } from '../auth/api-keys.js';
import { convertedStream, geminiToOpenai, openaiToGemini, unwrap } from '../protocols/openai.js';
import { collectGoogleResponse } from '../upstream/stream-collect.js';
import { callUpstream } from '../upstream/index.js';
import { discoverModels } from '../models/list.js';
import { callUnifiedUpstream, discoverUnifiedModels } from '../upstream/unified.js';
import { recordAttempt } from '../upstream/reliability.js';
import { recordTelemetry } from '../telemetry/index.js';
import { effectiveEnv } from '../config/settings.js';
import {
  anthropicToGemini,
  geminiToAnthropic,
  anthropicStream,
  estimateTokens,
  anthropicErrorType,
} from '../protocols/anthropic.js';

function validateModel(model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model)) {
    throw new HttpError(
      400,
      'model 只能包含字母、数字、点、下划线和短横线；Workers 版不支持功能前缀',
    );
  }
}

export async function generationRoute(request, env, fetcher, context, internal) {
  const url = new URL(request.url);
  const fixed = url.pathname.match(/^\/(antigravity|geminicli)\//)?.[1];
  let mode = fixed || 'geminicli';
  const path = fixed ? url.pathname.slice(('/' + fixed).length) : url.pathname;
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
  const apiKey =
    internal?.apiKey ||
    (await authenticateApi(request, env, !!nativeMatch || path === '/v1beta/models'));
  env = internal?.env || { ...(await effectiveEnv(env)), SESSION_SCOPE: apiKey.id };
  if (isModelList) {
    const result = fixed
      ? await discoverModels(env, mode, fetcher)
      : await discoverUnifiedModels(env, fetcher);
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
    if (result.source === 'cache')
      response.headers.set('x-model-list-warning', 'dynamic-discovery-failed');
    return response;
  }
  const body = internal?.body || (await readJson(request));
  const nativeBody = { ...body };
  const model =
    isOpenai || isAnthropic || path === '/v1/messages/count_tokens' ? body.model : nativeMatch[1];
  validateModel(model);
  if ((isOpenai || isAnthropic) && body.stream != null && typeof body.stream !== 'boolean')
    throw new HttpError(400, 'stream 必须为布尔值');
  const tools = isOpenai || isAnthropic ? prepareClientTools(body, isAnthropic) : null;
  const clientBody = tools?.body || body;
  const geminiRequest = isOpenai
    ? openaiToGemini(clientBody)
    : isAnthropic || path === '/v1/messages/count_tokens'
      ? anthropicToGemini(clientBody, isCount)
      : nativeBody;
  if (!isOpenai && !isAnthropic)
    for (const key of ['stream', 'fake_stream', 'anti_truncation']) delete geminiRequest[key];
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
  for (const key of ['fake_stream', 'anti_truncation'])
    if (body[key] != null && typeof body[key] !== 'boolean')
      throw new HttpError(400, key + ' 必须为布尔值');
  const continuationLimit = body.anti_truncation === false ? 0 : env.CONTINUATION_ATTEMPTS || 0;
  if (body.anti_truncation === true && !continuationLimit)
    throw new HttpError(400, '请先在管理页开启抗截断续写');
  if (
    stream &&
    !env.INTERNAL_BUFFERED_STREAM &&
    (body.fake_stream === true || env.FAKE_STREAMING || continuationLimit > 0)
  ) {
    const target = new URL(request.url);
    if (nativeMatch)
      target.pathname = target.pathname.replace(':streamGenerateContent', ':generateContent');
    const bufferedRequestId = crypto.randomUUID();
    const bufferedHeaders = new Headers(request.headers);
    bufferedHeaders.delete('content-length');
    bufferedHeaders.delete('content-encoding');
    return fakeStream(
      (signal) =>
        generationRoute(
          new Request(target, {
            method: 'POST',
            headers: bufferedHeaders,
            signal: AbortSignal.any([request.signal, signal]),
          }),
          { ...env, INTERNAL_BUFFERED_STREAM: true, FAKE_STREAMING: false },
          fetcher,
          context,
          {
            apiKey,
            env: { ...env, INTERNAL_BUFFERED_STREAM: true, FAKE_STREAMING: false },
            body: { ...body, stream: false, fake_stream: false },
            requestId: bufferedRequestId,
          },
        ),
      isOpenai ? 'openai' : isAnthropic ? 'anthropic' : 'gemini',
      model,
      body.stream_options?.include_usage === true,
      request.signal,
      bufferedRequestId,
    );
  }
  let collect = mode === 'antigravity' && !stream && env.ANTIGRAVITY_STREAM2NOSTREAM;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const incomingSignal = request.signal;
  if (incomingSignal?.aborted) cancel();
  incomingSignal?.addEventListener('abort', cancel, { once: true });
  let handedOff = false;
  const requestId = internal?.requestId || crypto.randomUUID();
  const attemptMeta = { requestId, attempts: [] };
  const started = Date.now();
  const deadline = setTimeout(
    () => abort.abort(new DOMException('Generation deadline exceeded', 'TimeoutError')),
    boundedSeconds(env.REQUEST_TIMEOUT_SECONDS, 100, 10, 110) * 1000,
  );
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
        apiKey,
        row: attemptMeta.row,
        mode: attemptMeta.mode || mode,
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
    const send = async (payload) => {
      let response;
      if (!fixed) {
        const selected = await callUnifiedUpstream(
          env,
          model,
          payload,
          stream,
          abort.signal,
          fetcher,
          attemptMeta,
        );
        response = selected.response;
        mode = selected.mode;
        collect = selected.collect;
      } else
        response = await callUpstream(
          env,
          mode,
          model,
          payload,
          stream || collect,
          abort.signal,
          fetcher,
          attemptMeta,
        );
      return response;
    };
    let response = await send(geminiRequest);
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
        result.headers.set('x-upstream-channel', attemptMeta.mode || mode);
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
          'x-upstream-channel': attemptMeta.mode || mode,
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
            const status = cancelled || clientAborted(abort.signal) ? 499 : 502;
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
        ? anthropicStream(
            response.body,
            model,
            cancel,
            finish,
            streamFailure,
            completed,
            (usage) => streamFailure(usage, true),
            tools?.names,
            env.RETURN_THOUGHTS !== false,
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
            tools?.names,
            env.RETURN_THOUGHTS !== false,
          );
      clearTimeout(deadline);
      handedOff = true;
      return new Response(converted, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-request-id': requestId,
          'x-upstream-channel': attemptMeta.mode || mode,
        },
      });
    }
    const read = async (response) => {
      if (collect)
        return collectGoogleResponse(response, undefined, { allowUnconfirmedText: true });
      try {
        return await response.json();
      } catch {
        throw new HttpError(502, '上游返回了无效 JSON');
      }
    };
    const continueSameCredential = async (payload) => {
      attemptMeta.initialRow = attemptMeta.row;
      return callUpstream(
        { ...env, MAX_CREDENTIAL_ATTEMPTS: 1 },
        mode,
        model,
        payload,
        collect,
        abort.signal,
        fetcher,
        attemptMeta,
      );
    };
    let value = await collectContinuations(
      response,
      geminiRequest,
      read,
      continueSameCredential,
      continuationLimit,
      abort.signal,
    );
    value = restoreToolNames(value, tools?.names, env.RETURN_THOUGHTS !== false);
    const unwrapped = unwrap(value);
    latestUsage = unwrapped.usageMetadata;
    if (
      unwrapped.error ||
      (!unwrapped.candidates?.length && !unwrapped.promptFeedback?.blockReason)
    )
      throw new HttpError(502, '上游未返回有效的生成结果');
    const payload = isOpenai
      ? geminiToOpenai(value, model)
      : isAnthropic
        ? geminiToAnthropic(value, model)
        : unwrapped;
    const unconfirmed = unwrapped.completion_status === 'unconfirmed';
    if (unconfirmed) {
      payload.completion_status = 'unconfirmed';
      payload.warnings = unwrapped.warnings;
      // No response text, credentials or additional D1 writes in this diagnostic.
      console.warn(JSON.stringify({ event: 'upstream_finish_unconfirmed', requestId }));
    }
    const result = json(payload);
    if (unconfirmed) {
      result.headers.set('x-completion-status', 'unconfirmed');
      result.headers.set('x-upstream-warning', 'UPSTREAM_FINISH_UNCONFIRMED');
    }
    result.headers.set('x-request-id', requestId);
    result.headers.set('x-upstream-channel', attemptMeta.mode || mode);
    if (collect) result.headers.set('x-upstream-mode', 'stream-collected');
    await completed(latestUsage);
    return result;
  } catch (error) {
    latestUsage ||= error.usageMetadata;
    if (abort.signal.aborted && abort.signal.reason?.name === 'TimeoutError') {
      error = new HttpError(
        504,
        '模型请求超过总等待时限，请缩短输入或输出、使用流式请求，或稍后重试',
      );
      error.operation = 'generation_timeout';
      error.errorCode = 'UPSTREAM_TIMEOUT';
    }
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
          code: error.errorCode || 'UPSTREAM_RESPONSE_INVALID',
          detailMessage: error.diagnosticMessage,
          started,
        },
        attemptMeta,
      );
    }
    await finishUsage(
      clientAborted(abort.signal) ? 499 : error.status || 500,
      clientAborted(abort.signal) ? 'cancelled' : 'failed',
      latestUsage,
    );
    error.requestId = requestId;
    throw error;
  } finally {
    clearTimeout(deadline);
    if (!handedOff) incomingSignal?.removeEventListener('abort', cancel);
  }
}
