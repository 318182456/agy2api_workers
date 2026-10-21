import { HttpError } from '../core/common.js';
import { sseEvents, unwrap } from '../protocols/openai.js';

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
function collection(allowUnconfirmedText = false) {
  const result = {},
    candidates = new Map();
  let frames = 0,
    textChars = 0,
    thoughtChars = 0,
    toolCalls = 0;
  let lastFrame = '无',
    alternateFinish = false;
  const decorate = (error, ending) => {
    // Only fixed labels and counts leave the collector; never persist response text, arguments,
    // thought signatures, arbitrary upstream keys or credentials in diagnostics.
    const usage = result.usageMetadata;
    if (usage && typeof usage === 'object') {
      const reported = Object.fromEntries(
        ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
          .filter((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
          .map((key) => [key, usage[key]]),
      );
      if (Object.keys(reported).length) error.usageMetadata = reported;
    }
    if (
      !error.collectionDiagnosed &&
      [
        'UPSTREAM_STREAM_INCOMPLETE',
        'UPSTREAM_STREAM_EMPTY',
        'UPSTREAM_STREAM_INTERRUPTED',
      ].includes(error.errorCode)
    ) {
      const finished = [...candidates.values()].filter(
        (candidate) => candidate.finishReason,
      ).length;
      const diagnostic =
        '帧=' +
        frames +
        '，候选=' +
        candidates.size +
        '，已结束=' +
        finished +
        '，正文字符=' +
        textChars +
        '，思考字符=' +
        thoughtChars +
        '，工具调用=' +
        toolCalls +
        '，用量=' +
        (error.usageMetadata ? '已报告' : '未报告') +
        '，末帧=' +
        lastFrame +
        '，结束=' +
        ending +
        (alternateFinish ? '，检测到非标准结束字段' : '');
      error.collectionDiagnosed = true;
      error.diagnosticMessage = error.message + '（' + diagnostic + '）';
      error.message = error.diagnosticMessage;
    }
    return error;
  };
  return {
    decorate,
    add(raw) {
      let value;
      try {
        value = unwrap(raw);
      } catch {
        throw failure('UPSTREAM_STREAM_FORMAT', '上游流式结果结构无效');
      }
      frames++;
      lastFrame = value.candidates?.length ? '候选' : value.usageMetadata ? '用量' : '元数据';
      alternateFinish ||= !!value.finishReason || !!value.finish_reason;
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
        alternateFinish ||= !!candidate.finish_reason;
        const index = candidate.index ?? position;
        const old = candidates.get(index) || { index, content: { role: 'model', parts: [] } };
        const parts = candidate.content?.parts || [];
        if (!Array.isArray(parts)) throw failure('UPSTREAM_STREAM_FORMAT', '上游内容格式无效');
        for (const part of parts) {
          if (!part || typeof part !== 'object' || Array.isArray(part))
            throw failure('UPSTREAM_STREAM_FORMAT', '上游内容格式无效');
          if (typeof part.text === 'string') {
            if (part.thought) thoughtChars += part.text.length;
            else textChars += part.text.length;
          }
          if (part.functionCall) toolCalls++;
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
    finish(ending = 'EOF') {
      if (!candidates.size && !result.promptFeedback?.blockReason)
        throw decorate(failure('UPSTREAM_STREAM_EMPTY', '上游流未返回候选结果'), ending);
      const only = [...candidates.values()][0];
      const unconfirmedText =
        allowUnconfirmedText &&
        ending === 'EOF' &&
        frames === 1 &&
        candidates.size === 1 &&
        !only.finishReason &&
        !alternateFinish &&
        textChars > 0 &&
        only.content.parts.every(
          (part) =>
            typeof part.text === 'string' &&
            Object.keys(part).every((key) => ['text', 'thought'].includes(key)),
        );
      if (unconfirmedText) {
        result.completion_status = 'unconfirmed';
        result.warnings = [
          {
            code: 'UPSTREAM_FINISH_UNCONFIRMED',
            message:
              '上游正常 EOF，但未返回 finishReason；已返回现有正文，结束未确认，内容可能不完整',
          },
        ];
      }
      if (!unconfirmedText && [...candidates.values()].some((candidate) => !candidate.finishReason))
        throw decorate(
          failure('UPSTREAM_STREAM_INCOMPLETE', '上游流提前结束，未返回 finishReason'),
          ending,
        );
      if (candidates.size) result.candidates = [...candidates.values()];
      return result;
    },
  };
}
// Preserve parts, signatures and usage. Compatibility never fabricates a Google finishReason.
export async function collectGoogleStream(stream, limit = 8 * 1024 * 1024, options = {}) {
  const merged = collection(options.allowUnconfirmedText === true);
  let bytes = 0,
    ending = 'EOF';
  try {
    for await (const event of sseEvents(stream)) {
      if (event === '[DONE]') {
        ending = 'DONE';
        break;
      }
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
    return merged.finish(ending);
  } catch (error) {
    if (error instanceof HttpError) throw merged.decorate(error, ending);
    throw merged.decorate(failure('UPSTREAM_STREAM_INTERRUPTED', '上游流式汇总中断'), '读流异常');
  }
}
export async function collectGoogleResponse(response, limit = 8 * 1024 * 1024, options = {}) {
  if (!response.body) throw failure('UPSTREAM_STREAM_EMPTY', '上游未返回响应正文');
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type === 'text/event-stream') return collectGoogleStream(response.body, limit, options);
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
      return await collectGoogleStream(new Response(text).body, limit, options);
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw failure('UPSTREAM_STREAM_JSON_INVALID', '上游流式端点返回了无效 JSON');
    }
    const merged = collection();
    for (const item of Array.isArray(raw) ? raw : [raw]) merged.add(item);
    return merged.finish('JSON');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw failure('UPSTREAM_STREAM_INTERRUPTED', '上游流式汇总中断');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
