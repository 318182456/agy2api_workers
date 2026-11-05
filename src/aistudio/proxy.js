import { HttpError, readJson } from '../core/common.js';
import { recordTelemetry } from '../telemetry/index.js';
export function externalUsage(data) {
  const u = data?.usageMetadata || data?.response?.usageMetadata;
  if (u) return u;
  const usage = data?.usage || data?.message?.usage || data?.response?.usage;
  if (!usage) return null;
  return {
    promptTokenCount: usage.prompt_tokens ?? usage.input_tokens,
    candidatesTokenCount: usage.completion_tokens ?? usage.output_tokens,
    thoughtsTokenCount:
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens,
    totalTokenCount: usage.total_tokens,
  };
}
export async function proxyAistudio(request, env, fetcher, context, config, apiKey, path) {
  if (!config?.enabled || !config.api_key)
    throw new HttpError(503, '请先在系统设置启用 AI Studio 上游');
  const catalog = ['/v1/models', '/v1beta/models'].includes(path);
  const count = /:countTokens$|\/count_tokens$/.test(path);
  const allowed =
    [
      '/v1/chat/completions',
      '/v1/messages',
      '/v1/messages/count_tokens',
      '/v1/responses',
      '/v1/images/generations',
    ].includes(path) ||
    /^\/v1(?:beta)?\/models\/[a-zA-Z0-9._-]{1,200}:(?:generateContent|streamGenerateContent|countTokens)$/.test(
      path,
    );
  if (!catalog && !allowed) throw new HttpError(404, 'AI Studio 暂不代理此接口');
  if (request.method !== (catalog ? 'GET' : 'POST')) throw new HttpError(405, '请求方法不支持');
  const body = catalog ? null : await readJson(request);
  const model = body?.model || path.match(/\/models\/([^/:]+):/)?.[1] || '';
  if (!catalog && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model)))
    throw new HttpError(400, '模型名称无效');
  const started = Date.now(),
    requestId = crypto.randomUUID();
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const timer = setTimeout(() => abort.abort(), 90000);
  let saved = false,
    usage = null;
  const save = async (status, outcome, code) => {
    if (saved || catalog || count) return;
    saved = true;
    const task = recordTelemetry(env, {
      requestId,
      apiKey,
      row: { id: null, name: 'AI Studio · ' + new URL(config.url).hostname },
      mode: 'aistudio',
      model,
      status,
      outcome,
      usage,
      started,
      attempts: [],
      failure: code
        ? { stage: 'external_upstream', code, message: 'AI Studio 上游请求未完成，请检查外部服务' }
        : undefined,
    });
    context?.waitUntil?.(task);
    await task;
  };
  let response;
  try {
    // Only the configured provider key is forwarded. Never forward browser/session headers.
    response = await fetcher(
      config.url +
        path +
        (new URL(request.url).searchParams.get('alt') === 'sse' ? '?alt=sse' : ''),
      {
        method: request.method,
        headers: {
          authorization: 'Bearer ' + config.api_key,
          accept: '*/*',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
        redirect: 'manual',
      },
    );
  } catch {
    clearTimeout(timer);
    await save(
      request.signal.aborted ? 499 : 504,
      request.signal.aborted ? 'cancelled' : 'failed',
      'AISTUDIO_CONNECTION_FAILED',
    );
    throw new HttpError(504, 'AI Studio 上游连接失败或等待响应头超过 90 秒');
  }
  clearTimeout(timer);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    await save(502, 'failed', 'AISTUDIO_REDIRECT');
    throw new HttpError(502, 'AI Studio 上游返回重定向，请检查地址');
  }
  const headers = new Headers({
    'content-type': response.headers.get('content-type') || 'application/json',
    'cache-control': 'no-store',
    'x-request-id': requestId,
    'x-upstream-mode': 'aistudio',
  });
  if (response.headers.has('retry-after'))
    headers.set('retry-after', response.headers.get('retry-after'));
  if (catalog && response.ok) {
    let data;
    try {
      data = await readJson({ headers: response.headers, body: response.body });
    } catch {
      throw new HttpError(503, 'AI Studio 模型目录尚未就绪，服务可能正在启动，请稍后重试');
    }
    if (!Array.isArray(data.data) && !Array.isArray(data.models))
      throw new HttpError(502, 'AI Studio 返回了无效模型目录');
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), { status: response.status, headers });
  }
  if (catalog || count) return new Response(response.body, { status: response.status, headers });
  if (!response.body) {
    await save(
      response.status,
      response.ok ? 'success' : 'failed',
      response.ok ? undefined : 'AISTUDIO_HTTP_' + response.status,
    );
    return new Response(null, { status: response.status, headers });
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const sse = /text\/event-stream/i.test(headers.get('content-type'));
  let text = '',
    observedError = false,
    cancelled = false;
  const observe = (value) => {
    const next = externalUsage(value);
    if (next)
      usage = {
        ...usage,
        ...Object.fromEntries(Object.entries(next).filter(([, v]) => v != null)),
      };
    if (value?.error || value?.type === 'error' || value?.type === 'response.failed')
      observedError = true;
  };
  const parse = (line) => {
    const raw = line.replace(/^data:\s?/, '').trim();
    if (!raw || raw === '[DONE]') return;
    try {
      observe(JSON.parse(raw));
    } catch {}
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (cancelled) return;
          text += decoder.decode();
          if (text) parse(text);
          await save(
            observedError ? 502 : response.status,
            observedError || !response.ok ? 'failed' : 'success',
            observedError
              ? 'AISTUDIO_STREAM_ERROR'
              : response.ok
                ? undefined
                : 'AISTUDIO_HTTP_' + response.status,
          );
          reader.releaseLock();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
        text += decoder.decode(next.value, { stream: true });
        if (sse) {
          const lines = text.split(/\r?\n/);
          text = lines.pop();
          for (const line of lines) if (line.startsWith('data:')) parse(line);
        }
        if (text.length > 1024 * 1024) text = '';
      } catch {
        if (cancelled) return;
        await save(
          request.signal.aborted ? 499 : 502,
          request.signal.aborted ? 'cancelled' : 'failed',
          'AISTUDIO_STREAM_INTERRUPTED',
        );
        controller.error(new Error('AI Studio 响应中断'));
      }
    },
    async cancel(reason) {
      cancelled = true;
      abort.abort();
      const recorded = save(499, 'cancelled', 'CLIENT_CANCELLED');
      await reader.cancel(reason).catch(() => {});
      await recorded;
    },
  });
  return new Response(stream, { status: response.status, headers });
}
