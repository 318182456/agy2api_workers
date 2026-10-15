import { HttpError } from './common.js';
import { sseEvents, unwrap } from './convert.js';

// Preserve the original part order, signatures and latest cumulative usage.
export async function collectGoogleStream(stream, limit = 8 * 1024 * 1024) {
  const result = {};
  const candidates = new Map();
  let bytes = 0;
  try {
    for await (const event of sseEvents(stream)) {
      if (event === '[DONE]') break;
      bytes += new TextEncoder().encode(event).byteLength;
      if (bytes > limit) throw new HttpError(502, '上游流式汇总超过缓存上限');
      let value;
      try {
        value = unwrap(JSON.parse(event));
      } catch {
        throw new HttpError(502, '上游 SSE 返回无效 JSON');
      }
      if (value.error) throw new HttpError(502, '上游流返回错误');
      const { candidates: incoming, ...metadata } = value;
      if (metadata.usageMetadata)
        metadata.usageMetadata = { ...result.usageMetadata, ...metadata.usageMetadata };
      Object.assign(result, metadata);
      if (incoming !== undefined && !Array.isArray(incoming))
        throw new HttpError(502, '上游候选结果格式无效');
      for (const [position, candidate] of (incoming || []).entries()) {
        if (!candidate || typeof candidate !== 'object')
          throw new HttpError(502, '上游候选结果格式无效');
        const index = candidate.index ?? position;
        const old = candidates.get(index) || { index, content: { role: 'model', parts: [] } };
        const parts = candidate.content?.parts || [];
        if (!Array.isArray(parts)) throw new HttpError(502, '上游内容格式无效');
        for (const part of parts) {
          if (!part || typeof part !== 'object') throw new HttpError(502, '上游内容格式无效');
          const previous = old.content.parts.at(-1);
          const plain = (p) =>
            p &&
            typeof p.text === 'string' &&
            Object.keys(p).every((key) => ['text', 'thought'].includes(key));
          if (plain(part) && plain(previous) && !!part.thought === !!previous.thought)
            previous.text += part.text;
          else old.content.parts.push(structuredClone(part));
        }
        const { content, ...other } = candidate;
        Object.assign(old, other);
        if (content?.role) old.content.role = content.role;
        candidates.set(index, old);
      }
    }
    if (
      (!candidates.size && !result.promptFeedback?.blockReason) ||
      [...candidates.values()].some((c) => !c.finishReason)
    )
      throw new HttpError(502, '上游流提前结束，未返回 finishReason');
    if (candidates.size) result.candidates = [...candidates.values()];
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '上游流式汇总中断');
  }
}
