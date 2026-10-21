import { HttpError } from '../core/common.js';

function nameHash(name) {
  let hash = 2166136261;
  for (const ch of name) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}
function fixArgs(value, schema, depth = 0) {
  if (depth > 16 || !schema || typeof schema !== 'object') return value;
  if (schema.type === 'integer' || schema.type === 'number') {
    if (
      typeof value === 'string' &&
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())
    ) {
      const number = Number(value);
      if (Number.isFinite(number) && (schema.type !== 'integer' || Number.isSafeInteger(number)))
        return number;
    }
  } else if (
    schema.type === 'boolean' &&
    typeof value === 'string' &&
    /^(true|false)$/i.test(value)
  )
    return value.toLowerCase() === 'true';
  else if (schema.type === 'string' && ['boolean', 'number'].includes(typeof value))
    return String(value);
  else if (schema.type === 'array' && Array.isArray(value))
    return value.map((item) => fixArgs(item, schema.items, depth + 1));
  else if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        fixArgs(item, schema.properties[key], depth + 1),
      ]),
    );
  return value;
}
// No shared state: mappings are rebuilt from this request and restored on its response.
export function prepareClientTools(input, anthropic = false) {
  const body = structuredClone(input),
    original = new Map(),
    reverse = new Map(),
    used = new Set();
  const declarations = Array.isArray(body.tools)
    ? body.tools.map((tool) => (anthropic ? tool : tool?.function)).filter(Boolean)
    : [];
  const names = declarations.map((tool) => tool.name).filter((name) => typeof name === 'string');
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (Array.isArray(message?.tool_calls))
      for (const call of message.tool_calls)
        if (typeof call?.function?.name === 'string') names.push(call.function.name);
    if (anthropic && Array.isArray(message?.content))
      for (const block of message.content)
        if (block?.type === 'tool_use' && typeof block.name === 'string') names.push(block.name);
  }
  if (names.length > 1000) throw new HttpError(400, '工具名称数量过多');
  for (const name of names) if (/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)) used.add(name);
  for (const name of names) {
    if (original.has(name)) continue;
    let mapped = name;
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      const prefix = ('tool_' + name.replace(/[^A-Za-z0-9_.-]/g, '_')).slice(0, 46);
      mapped = prefix + '_' + nameHash(name);
      let suffix = 0;
      while (used.has(mapped)) mapped = prefix + '_' + nameHash(name) + '_' + ++suffix;
    }
    used.add(mapped);
    original.set(name, mapped);
    reverse.set(mapped, name);
  }
  const schemas = new Map(
    declarations.map((tool) => [tool.name, anthropic ? tool.input_schema : tool.parameters]),
  );
  for (const tool of declarations) if (original.has(tool.name)) tool.name = original.get(tool.name);
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      const fn = call?.function;
      if (!fn) continue;
      if (!call.extra_content?.google?.thought_signature && typeof fn.arguments === 'string') {
        try {
          fn.arguments = JSON.stringify(fixArgs(JSON.parse(fn.arguments), schemas.get(fn.name)));
        } catch {}
      }
      fn.name = original.get(fn.name) || fn.name;
    }
    if (message?.role === 'tool' && message.name)
      message.name = original.get(message.name) || message.name;
    if (anthropic && Array.isArray(message?.content))
      for (const block of message.content)
        if (block?.type === 'tool_use') {
          if (!block.extra_content?.google?.thought_signature)
            block.input = fixArgs(block.input, schemas.get(block.name));
          block.name = original.get(block.name) || block.name;
        }
  }
  const choice = body.tool_choice;
  if (anthropic && choice?.type === 'tool') choice.name = original.get(choice.name) || choice.name;
  else if (choice?.type === 'function' && choice.function)
    choice.function.name = original.get(choice.function.name) || choice.function.name;
  return { body, names: reverse };
}
export function normalizeToolHistory(contents, reorderResults = true) {
  const result = [],
    responded = new Set(),
    calls = new Map(),
    ranks = new Map();
  let rank = 0;
  for (const content of contents) {
    const previous = result.at(-1);
    if (previous?.role === content.role) previous.parts.push(...content.parts);
    else result.push({ ...content, parts: [...content.parts] });
  }
  for (const content of result) {
    for (const part of content.parts) {
      const call = part.functionCall;
      if (call?.id) {
        if (calls.has(call.id)) throw new HttpError(400, '工具调用 ID 重复');
        responded.delete(call.id);
        calls.set(call.id, call.name);
        ranks.set(call.id, rank++);
      }
      const response = part.functionResponse;
      if (response?.id) {
        if (responded.has(response.id)) throw new HttpError(400, '工具结果 ID 重复');
        responded.add(response.id);
      }
      if (response?.id && (!calls.has(response.id) || calls.get(response.id) !== response.name))
        throw new HttpError(400, '工具结果没有匹配的调用 ID 或函数名');
      if (response?.id) calls.delete(response.id);
    }
    if (
      reorderResults &&
      content.role === 'user' &&
      content.parts.some((part) => part.functionResponse)
    ) {
      const responses = content.parts.filter((part) => part.functionResponse);
      responses.sort(
        (a, b) =>
          (ranks.get(a.functionResponse.id) ?? Infinity) -
          (ranks.get(b.functionResponse.id) ?? Infinity),
      );
      content.parts = [...responses, ...content.parts.filter((part) => !part.functionResponse)];
    }
  }
  return result;
}
export function restoreToolNames(value, names, showThoughts = true) {
  if (!names?.size && showThoughts) return value;
  const copy = structuredClone(value),
    inner = copy.response || copy;
  for (const candidate of inner.candidates || []) {
    if (!showThoughts && candidate.content?.parts)
      candidate.content.parts = candidate.content.parts.filter(
        (part) => !part.thought || part.functionCall || part.functionResponse,
      );
    for (const part of candidate.content?.parts || [])
      if (part.functionCall && names?.has(part.functionCall.name))
        part.functionCall.name = names.get(part.functionCall.name);
  }
  return copy;
}
