import { HttpError } from './common.js';
import { sseEvents, unwrap } from './convert.js';

function failure(code, message, status = 502) {
  const error = new HttpError(status, message);
  error.operation = 'stream_collection';
  error.errorCode = code;
  error.diagnosticMessage =
    code === 'UPSTREAM_STREAM_ERROR'
      ? '上游在流内返回 HTTP ' + status + ' 错误，具体消息随接口响应返回'
      : message;
  return error;
}
function collection() {
  const result = {},
    candidates = new Map();
  return {
    add(raw) {
      let value;
      try {
        value = unwrap(raw);
      } catch {
        throw failure('UPSTREAM_STREAM_FORMAT', '上游流式结果结构无效');
      }
      if (value.error) {
        const status =
          Number.isInteger(value.error.code) && value.error.code >= 400 && value.error.code <= 599
            ? value.error.code
            : 502;
        const detail =
          typeof value.error.message === 'string' ? value.error.message.slice(0, 2000) : '';
        throw failure(
          'UPSTREAM_STREAM_ERROR',
          '上游流返回错误' + (detail ? '：' + detail : ''),
          status,
        );
      }
      const { candidates: incoming, ...metadata } = value;
      if (metadata.usageMetadata)
        metadata.usageMetadata = { ...result.usageMetadata, ...metadata.usageMetadata };
      Object.assign(result, metadata);
      if (incoming !== undefined && !Array.isArray(incoming))
        throw failure('UPSTREAM_STREAM_FORMAT', '上游候选结果格式无效');
      for (const [position, candidate] of (incoming || []).entries()) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
          throw failure('UPSTREAM_STREAM_FORMAT', '上游候选结果格式无效');
        const index = candidate.index ?? position;
        const old = candidates.get(index) || { index, content: { role: 'model', parts: [] } };
        const parts = candidate.content?.parts || [];
        if (!Array.isArray(parts)) throw failure('UPSTREAM_STREAM_FORMAT', '上游内容格式无效');
        for (const part of parts) {
          if (!part || typeof part !== 'object' || Array.isArray(part))
            throw failure('UPSTREAM_STREAM_FORMAT', '上游内容格式无效');
          const previous = old.content.parts.at(-1);
          const plain = (p) =>
            p &&
            typeof p.text === 'string' &&
            Object.keys(p).every((key) => ['text', 'thought'].includes(key));
          if (plain(part) && plain(previous) && !!part.thought === !!previous.thought)
            previous.text += part.text;
          else old.content.parts.push(structuredClone(part));
        }
        // Trailing metadata frames can repeat a candidate with an empty finishReason.
        const { content, finishReason, ...other } = candidate;
        Object.assign(old, other);
        if (typeof finishReason === 'string' && finishReason) old.finishReason = finishReason;
        if (content?.role) old.content.role = content.role;
        candidates.set(index, old);
      }
    },
    finish() {
      if (!candidates.size && !result.promptFeedback?.blockReason)
        throw failure('UPSTREAM_STREAM_EMPTY', '上游流未返回候选结果');
      if ([...candidates.values()].some((candidate) => !candidate.finishReason))
        throw failure('UPSTREAM_STREAM_INCOMPLETE', '上游流提前结束，未返回 finishReason');
      if (candidates.size) result.candidates = [...candidates.values()];
      return result;
    },
  };
}
// Preserve part order, tool signatures and cumulative usage; never invent a completion.
export async function collectGoogleStream(stream, limit = 8 * 1024 * 1024) {
  const merged = collection();
  let bytes = 0;
  try {
    for await (const event of sseEvents(stream)) {
      if (event === '[DONE]') break;
      bytes += new TextEncoder().encode(event).byteLength;
      if (bytes > limit) throw failure('UPSTREAM_STREAM_LIMIT', '上游流式汇总超过缓存上限');
      let raw;
      try {
        raw = JSON.parse(event);
      } catch {
        throw failure('UPSTREAM_STREAM_JSON_INVALID', '上游 SSE 返回无效 JSON');
      }
      for (const item of Array.isArray(raw) ? raw : [raw]) merged.add(item);
    }
    return merged.finish();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw failure('UPSTREAM_STREAM_INTERRUPTED', '上游流式汇总中断');
  }
}
export async function collectGoogleResponse(response, limit = 8 * 1024 * 1024) {
  if (!response.body) throw failure('UPSTREAM_STREAM_EMPTY', '上游未返回响应正文');
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type === 'text/event-stream') return collectGoogleStream(response.body, limit);
  if (type !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(type)) {
    await response.body.cancel();
    throw failure(
      'UPSTREAM_NOT_SSE',
      '上游未返回 SSE 或 JSON 响应（Content-Type: ' + (type.slice(0, 100) || '未提供') + '）',
    );
  }
  // Some compatible upstreams return a complete JSON object/array even on the stream endpoint.
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let bytes = 0,
    text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw failure('UPSTREAM_STREAM_LIMIT', '上游流式汇总超过缓存上限');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    // A proxy can also preserve SSE bytes while labeling the response application/json.
    if (/^(?::|data:|event:|id:|retry:)/.test(text.trimStart()))
      return await collectGoogleStream(new Response(text).body, limit);
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw failure('UPSTREAM_STREAM_JSON_INVALID', '上游流式端点返回了无效 JSON');
    }
    const merged = collection();
    for (const item of Array.isArray(raw) ? raw : [raw]) merged.add(item);
    return merged.finish();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw failure('UPSTREAM_STREAM_INTERRUPTED', '上游流式汇总中断');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
