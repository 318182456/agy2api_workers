import { HttpError } from './common.js';

function contentParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (content == null) return [];
  if (!Array.isArray(content)) throw new HttpError(400, '消息 content 必须为字符串或数组');
  return content.map((part) => {
    if (part.type === 'text') return { text: String(part.text || '') };
    if (part.type === 'image_url') {
      const match = part.image_url?.url?.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
      if (!match) throw new HttpError(400, 'Workers 版图片仅支持 base64 data URL');
      return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    throw new HttpError(400, `暂不支持消息内容类型 ${part.type}`);
  });
}

export function openaiToGemini(body) {
  if (typeof body.model !== 'string' || !body.model.trim()) throw new HttpError(400, '缺少 model');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'messages 不能为空');
  if (body.n != null && body.n !== 1) throw new HttpError(400, 'Workers 版只支持 n=1');
  const request = { contents: [] };
  if (body.reasoning_effort != null) {
    const efforts = { none: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max' };
    if (!efforts[body.reasoning_effort]) throw new HttpError(400, '未知 reasoning_effort');
    request._reasoningEffort = efforts[body.reasoning_effort];
  }
  const system = [];
  const callNames = new Map();
  for (const message of body.messages) {
    if (['system', 'developer'].includes(message.role)) { system.push(...contentParts(message.content)); continue; }
    let role = message.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (message.role === 'tool') {
      const name = callNames.get(message.tool_call_id) || message.name;
      if (!name) throw new HttpError(400, 'tool 消息必须匹配之前的 tool_call_id');
      let result;
      try { result = JSON.parse(message.content); } catch { result = { result: message.content }; }
      if (!result || typeof result !== 'object' || Array.isArray(result)) result = { result };
      parts = [{ functionResponse: { name, response: result, ...(message.tool_call_id ? { id: message.tool_call_id } : {}) } }];
    } else {
      if (!['user', 'assistant'].includes(message.role)) throw new HttpError(400, `未知消息角色 ${message.role}`);
      parts = contentParts(message.content);
      for (const call of message.tool_calls || []) {
        const fn = call.function;
        if (!fn?.name) throw new HttpError(400, '工具调用缺少 function.name');
        let args;
        try { args = JSON.parse(fn.arguments || '{}'); } catch { throw new HttpError(400, '工具参数不是有效 JSON'); }
        callNames.set(call.id, fn.name);
        const part = { functionCall: { name: fn.name, args, ...(call.id ? { id: call.id } : {}) } };
        const signature = call.extra_content?.google?.thought_signature;
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
    }
    if (!parts.length) continue;
    const last = request.contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else request.contents.push({ role, parts });
  }
  if (!request.contents.length) throw new HttpError(400, '至少需要一条非空 user 或 assistant 消息');
  if (system.length) request.systemInstruction = { parts: system };
  const generationConfig = {};
  for (const [source, target] of Object.entries({ temperature: 'temperature', top_p: 'topP', top_k: 'topK', max_tokens: 'maxOutputTokens', max_completion_tokens: 'maxOutputTokens', seed: 'seed' })) {
    if (body[source] != null) generationConfig[target] = body[source];
  }
  if (body.stop != null) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.response_format?.type === 'json_object') generationConfig.responseMimeType = 'application/json';
  if (body.response_format?.type === 'json_schema') {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = body.response_format.json_schema?.schema;
  }
  if (body.thinking_config) generationConfig.thinkingConfig = body.thinking_config;
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  if (body.tools?.length) {
    request.tools = [{ functionDeclarations: body.tools.map((tool) => {
      if (tool.type !== 'function' || !tool.function?.name) throw new HttpError(400, '仅支持 function 类型工具');
      const { name, description, parameters } = tool.function;
      return { name, ...(description ? { description } : {}), ...(parameters ? { parametersJsonSchema: parameters } : {}) };
    }) }];
  }
  if (body.tool_choice) {
    const choice = body.tool_choice;
    const modes = { auto: 'AUTO', none: 'NONE', required: 'ANY' };
    if (typeof choice === 'string' && !modes[choice]) throw new HttpError(400, '未知 tool_choice');
    if (typeof choice === 'object' && !choice.function?.name) throw new HttpError(400, 'tool_choice 缺少函数名');
    request.toolConfig = { functionCallingConfig: typeof choice === 'string'
      ? { mode: modes[choice] } : { mode: 'ANY', allowedFunctionNames: [choice.function.name] } };
  }
  return request;
}

export function unwrap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, '上游返回格式不正确');
  return value.response || value;
}

export function finishReason(reason, tools = false) {
  if (reason === 'MAX_TOKENS') return 'length';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(reason)) return 'content_filter';
  return tools ? 'tool_calls' : 'stop';
}

export function usage(value) {
  const meta = value.usageMetadata || {};
  const prompt = meta.promptTokenCount || 0;
  const completion = (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: meta.totalTokenCount ?? prompt + completion };
}

export function partsDelta(parts, toolStart = 0) {
  const delta = {};
  const tools = [];
  for (const part of parts || []) {
    if (part.text != null) {
      const field = part.thought ? 'reasoning_content' : 'content';
      delta[field] = (delta[field] || '') + part.text;
    }
    if (part.functionCall) {
      const call = { index: toolStart + tools.length, id: part.functionCall.id || `call_${crypto.randomUUID().replaceAll('-', '')}`, type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } };
      if (part.thoughtSignature) call.extra_content = { google: { thought_signature: part.thoughtSignature } };
      tools.push(call);
    }
    if (part.inlineData) throw new HttpError(400, 'OpenAI 接口暂不支持图片输出，请使用 Gemini 原生接口');
  }
  if (tools.length) delta.tool_calls = tools;
  return delta;
}

export function geminiToOpenai(raw, model, id = `chatcmpl-${crypto.randomUUID()}`) {
  const value = unwrap(raw);
  if (value.error) throw new HttpError(502, String(value.error.message || '上游返回错误'));
  const candidate = value.candidates?.[0];
  if (!candidate && !value.promptFeedback) throw new HttpError(502, '上游未返回候选结果');
  const delta = partsDelta(candidate?.content?.parts);
  if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map(({ index, ...call }) => call);
  return {
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: delta.content ?? null, ...delta },
      finish_reason: value.promptFeedback?.blockReason ? 'content_filter' : finishReason(candidate?.finishReason, !!delta.tool_calls) }],
    usage: usage(value),
  };
}

// SSE events may span arbitrary TCP chunks, use CRLF, or contain several data lines.
export async function* sseEvents(stream, control = {}) {
  const reader = stream.getReader();
  control.cancel = () => reader.cancel().catch(() => {});
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let eventSize = 0;
  function line(value) {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (value === '') { const event = data.join('\n'); data = []; eventSize = 0; return event || null; }
    if (value.startsWith('data:')) {
      data.push(value.slice(5).replace(/^ /, ''));
      eventSize += data.at(-1).length + 1;
      if (eventSize > 4 * 1024 * 1024) throw new HttpError(502, '上游 SSE 事件过大');
    }
    return null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let pos;
      while ((pos = buffer.indexOf('\n')) !== -1) {
        const event = line(buffer.slice(0, pos));
        buffer = buffer.slice(pos + 1);
        if (event) yield event;
      }
      if (buffer.length > 4 * 1024 * 1024 || data.join('\n').length > 4 * 1024 * 1024) throw new HttpError(502, '上游 SSE 事件过大');
      if (done) break;
    }
    if (buffer) { const event = line(buffer); if (event) yield event; }
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function convertedStream(upstream, model, openai, includeUsage = false, abort = () => {}, onFinish = () => {}, onError = async () => {}, onComplete = async () => {}, onCancel = async () => {}) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const control = {};
  const events = sseEvents(upstream, control);
  let toolCount = 0;
  let sentRole = false;
  let sentFinish = false;
  let latestUsage;
  let rawUsage;
  const seen = new Map();
  let blocked = false;
  const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }] });
  // The generator plus pull() keep downstream backpressure and cancellation intact.
  async function* output() {
    try {
      for await (const event of events) {
        if (event === '[DONE]') break;
        const value = unwrap(JSON.parse(event));
        if (value.error) throw new Error(value.error.message || '上游流式错误');
        if (value.usageMetadata) rawUsage = { ...rawUsage, ...value.usageMetadata };
        for (const [index, candidate] of (value.candidates || []).entries()) seen.set(candidate.index ?? index, candidate.finishReason || seen.get(candidate.index ?? index));
        blocked ||= !!value.promptFeedback?.blockReason;
        if (!openai) { yield value; continue; }
        if (!sentRole) { yield chunk({ role: 'assistant', content: '' }); sentRole = true; }
        if (value.usageMetadata) latestUsage = usage(value);
        const candidate = value.candidates?.[0];
        const delta = partsDelta(candidate?.content?.parts, toolCount);
        toolCount += delta.tool_calls?.length || 0;
        if (Object.keys(delta).length) yield chunk(delta);
        if (candidate?.finishReason || value.promptFeedback?.blockReason) {
          if (!sentFinish) yield chunk({}, value.promptFeedback?.blockReason ? 'content_filter' : finishReason(candidate?.finishReason, toolCount > 0));
          sentFinish = true;
        }
      }
      if ((!seen.size && !blocked) || [...seen.values()].some(finish => !finish)) throw new Error('上游流提前结束，未返回 finishReason');
      await onComplete(rawUsage);
      if (openai) {
        // Do not turn an abruptly terminated upstream into a successful completion.
        if (!sentFinish) throw new Error('上游流提前结束，未返回 finishReason');
        if (includeUsage && latestUsage) yield { id, object: 'chat.completion.chunk', created, model, choices: [], usage: latestUsage };
        yield '[DONE]';
      }
    } catch (error) {
      await onError(rawUsage);
      yield { error: { message: error.message, type: 'upstream_error' } };
    } finally { onFinish(); }
  }
  const iterator = output();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(`data: ${value === '[DONE]' ? value : JSON.stringify(value)}\n\n`));
    },
    async cancel() {
      // Cancel the reader first to unblock any pending read in iterator.next().
      abort();
      await onCancel(rawUsage);
      if (control.cancel) await control.cancel();
      else await upstream.cancel().catch(() => {});
      await iterator.return();
      onFinish();
    },
  });
}
