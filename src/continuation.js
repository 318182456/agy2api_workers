import { HttpError } from './common.js';
import { unwrap } from './convert.js';
const usageKeys = [
  'promptTokenCount',
  'candidatesTokenCount',
  'thoughtsTokenCount',
  'totalTokenCount',
  'cachedContentTokenCount',
];
function addUsage(target, source) {
  for (const key of usageKeys)
    if (Number.isSafeInteger(source?.[key]) && source[key] >= 0)
      target[key] = (target[key] || 0) + source[key];
}
// Continue only an explicitly token-limited text result. Never replay a tool call or a broken stream.
export async function collectContinuations(response, request, read, send, limit = 0, signal) {
  let merged,
    history = structuredClone(request);
  const usage = {};
  try {
    for (let round = 0; ; round++) {
      if (!response.ok) {
        await response.body?.cancel();
        const error = new HttpError(response.status, '续写请求失败 (HTTP ' + response.status + ')');
        error.operation = 'generation_continuation';
        error.errorCode = 'CONTINUATION_FAILED';
        throw error;
      }
      const value = unwrap(await read(response));
      if (value.error || (!value.candidates?.length && !value.promptFeedback?.blockReason))
        throw new HttpError(502, '上游未返回有效的生成结果');
      addUsage(usage, value.usageMetadata);
      const candidate = value.candidates?.[0];
      if (!merged) merged = structuredClone(value);
      else {
        const parts = merged.candidates[0].content?.parts || [];
        merged = {
          ...value,
          candidates: [
            {
              ...candidate,
              content: {
                ...candidate.content,
                parts: [...parts, ...(candidate.content?.parts || [])],
              },
            },
          ],
        };
      }
      if (Object.keys(usage).length) merged.usageMetadata = { ...merged.usageMetadata, ...usage };
      const parts = candidate?.content?.parts;
      const canContinue =
        candidate?.finishReason === 'MAX_TOKENS' &&
        value.candidates.length === 1 &&
        parts?.some((part) => typeof part.text === 'string' && part.text && !part.thought) &&
        parts.every(
          (part) => typeof part.text === 'string' && !part.functionCall && !part.functionResponse,
        );
      if (signal?.aborted) throw signal.reason;
      if (round >= limit || !canContinue) return merged;
      history = {
        ...history,
        contents: [
          ...history.contents,
          { role: 'model', parts: structuredClone(parts) },
          {
            role: 'user',
            parts: [
              {
                text: 'Continue exactly where the preceding response was cut off. Do not repeat already returned content.',
              },
            ],
          },
        ],
      };
      response = await send(history);
    }
  } catch (error) {
    const reported = { ...usage };
    addUsage(reported, error.usageMetadata);
    if (Object.keys(reported).length) error.usageMetadata = reported;
    throw error;
  }
}
