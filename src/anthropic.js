import { restoreToolNames } from './tool-compat.js';
import { HttpError } from './common.js';
import { sseEvents, unwrap } from './convert.js';

function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new HttpError(400, 'content 必须为字符串或内容块数组');
  return content;
}
function textParts(content) {
  return blocks(content).map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string')
      throw new HttpError(400, '此位置仅支持 text 内容块');
    return { text: block.text };
  });
}
export function anthropicToGemini(body, countOnly = false) {
  if (
    typeof body.model !== 'string' ||
    !body.model ||
    !Array.isArray(body.messages) ||
    !body.messages.length
  )
    throw new HttpError(400, '缺少 model 或非空 messages');
  if (!countOnly && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1))
    throw new HttpError(400, 'max_tokens 必须为正整数');
  if (body.stream != null && typeof body.stream !== 'boolean')
    throw new HttpError(400, 'stream 必须为布尔值');
  const result = { contents: [] };
  if (body.system != null) result.systemInstruction = { parts: textParts(body.system) };
  const calls = new Map();
  for (const message of body.messages) {
    if (!message || !['user', 'assistant'].includes(message.role))
      throw new HttpError(400, 'messages 只支持 user 和 assistant 角色');
    const parts = [];
    for (const block of blocks(message.content)) {
      if (!block || typeof block !== 'object') throw new HttpError(400, '内容块格式无效');
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw new HttpError(400, 'text 必须为字符串');
        parts.push({ text: block.text });
      } else if (block.type === 'image') {
        if (
          block.source?.type !== 'base64' ||
          typeof block.source.data !== 'string' ||
          !block.source.data ||
          !/^image\/[\w.+-]+$/.test(block.source.media_type || '')
        )
          throw new HttpError(400, '图片仅支持 source.type=base64');
        parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
      } else if (block.type === 'tool_use') {
        if (
          message.role !== 'assistant' ||
          typeof block.id !== 'string' ||
          !block.id ||
          typeof block.name !== 'string' ||
          !block.name ||
          !block.input ||
          typeof block.input !== 'object' ||
          Array.isArray(block.input)
        )
          throw new HttpError(400, 'tool_use 必须包含 id、name 和对象 input');
        if (calls.has(block.id)) throw new HttpError(400, 'tool_use id 不能重复');
        calls.set(block.id, block.name);
        const part = { functionCall: { id: block.id, name: block.name, args: block.input } };
        if (block.extra_content?.google?.thought_signature)
          part.thoughtSignature = block.extra_content.google.thought_signature;
        else if (Number(body.model.match(/^gemini-(\d+)(?:[.-]|$)/i)?.[1]) >= 3)
          part.thoughtSignature = 'skip_thought_signature_validator';
        parts.push(part);
      } else if (block.type === 'tool_result') {
        const name = calls.get(block.tool_use_id);
        if (message.role !== 'user' || !name)
          throw new HttpError(400, 'tool_result 必须匹配此前的 tool_use_id');
        const text =
          block.content == null
            ? ''
            : textParts(block.content)
                .map((part) => part.text)
                .join('\n');
        parts.push({
          functionResponse: {
            id: block.tool_use_id,
            name,
            response: { result: text, ...(block.is_error ? { is_error: true } : {}) },
          },
        });
      } else if (block.type === 'thinking') {
        if (
          message.role !== 'assistant' ||
          typeof block.thinking !== 'string' ||
          typeof block.signature !== 'string'
        )
          throw new HttpError(400, 'thinking 历史块必须包含 thinking 和 signature');
        parts.push({
          text: block.thinking,
          thought: true,
          ...(block.signature ? { thoughtSignature: block.signature } : {}),
        });
      } else throw new HttpError(400, `暂不支持内容块类型 ${block.type}`);
    }
    const role = message.role === 'assistant' ? 'model' : 'user';
    if (result.contents.at(-1)?.role === role) result.contents.at(-1).parts.push(...parts);
    else result.contents.push({ role, parts });
  }
  const config = {};
  for (const [from, to] of Object.entries({
    max_tokens: 'maxOutputTokens',
    temperature: 'temperature',
    top_p: 'topP',
    top_k: 'topK',
  }))
    if (body[from] != null) config[to] = body[from];
  if (body.stop_sequences != null) {
    if (
      !Array.isArray(body.stop_sequences) ||
      body.stop_sequences.some((value) => typeof value !== 'string')
    )
      throw new HttpError(400, 'stop_sequences 必须为字符串数组');
    config.stopSequences = body.stop_sequences;
  }
  if (body.thinking) {
    if (body.thinking.type === 'enabled') {
      if (
        !Number.isInteger(body.thinking.budget_tokens) ||
        body.thinking.budget_tokens < 1 ||
        (!countOnly && body.thinking.budget_tokens >= body.max_tokens)
      )
        throw new HttpError(400, 'thinking.budget_tokens 必须为正整数且小于 max_tokens');
      config.thinkingConfig = {
        thinkingBudget: body.thinking.budget_tokens,
        includeThoughts: true,
      };
    } else if (body.thinking.type === 'disabled')
      config.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
    else throw new HttpError(400, '暂不支持此 thinking 类型，请使用 enabled 或 disabled');
  }
  if (body.output_config?.format) {
    if (body.output_config.format.type !== 'json_schema' || !body.output_config.format.schema)
      throw new HttpError(400, '结构化输出只支持 json_schema');
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = body.output_config.format.schema;
  }
  if (Object.keys(config).length) result.generationConfig = config;
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) throw new HttpError(400, 'tools 必须为数组');
    if (body.tools.length)
      result.tools = [
        {
          functionDeclarations: body.tools.map((tool) => {
            if (
              !tool ||
              (tool.type && tool.type !== 'custom') ||
              typeof tool.name !== 'string' ||
              !tool.name ||
              !tool.input_schema ||
              typeof tool.input_schema !== 'object' ||
              Array.isArray(tool.input_schema)
            )
              throw new HttpError(
                400,
                '仅支持包含 name 与 input_schema 的自定义工具，不支持 Anthropic 服务端工具',
              );
            return {
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              parametersJsonSchema: tool.input_schema,
            };
          }),
        },
      ];
  }
  if (body.tool_choice) {
    const choice = body.tool_choice;
    const modes = { auto: 'AUTO', any: 'ANY', none: 'NONE', tool: 'ANY' };
    if (!modes[choice.type] || (choice.type === 'tool' && !choice.name))
      throw new HttpError(400, 'tool_choice 类型或名称无效');
    if (choice.disable_parallel_tool_use) throw new HttpError(400, '暂不支持强制关闭并行工具调用');
    result.toolConfig = {
      functionCallingConfig: {
        mode: modes[choice.type],
        ...(choice.type === 'tool' ? { allowedFunctionNames: [choice.name] } : {}),
      },
    };
  }
  return result;
}
function nonnegative(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
export function anthropicUsage(meta = {}) {
  const cached = Math.min(
    nonnegative(meta.cachedContentTokenCount),
    nonnegative(meta.promptTokenCount),
  );
  return {
    input_tokens: Math.max(0, nonnegative(meta.promptTokenCount) - cached),
    output_tokens: nonnegative(meta.candidatesTokenCount) + nonnegative(meta.thoughtsTokenCount),
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}
function stopReason(reason, tools) {
  return reason === 'MAX_TOKENS' ? 'max_tokens' : tools ? 'tool_use' : 'end_turn';
}
function blocked(value, candidate) {
  return (
    value.promptFeedback?.blockReason ||
    ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(
      candidate?.finishReason,
    )
  );
}
function toolBlock(part) {
  const call = part.functionCall;
  if (
    typeof call.name !== 'string' ||
    !call.name ||
    (call.args != null && (typeof call.args !== 'object' || Array.isArray(call.args)))
  )
    throw new HttpError(502, 'Google 返回了无效的工具调用');
  return {
    type: 'tool_use',
    id:
      (typeof call.id === 'string' && call.id) ||
      'toolu_' + crypto.randomUUID().replaceAll('-', ''),
    name: call.name,
    input: call.args || {},
    ...(part.thoughtSignature
      ? { extra_content: { google: { thought_signature: part.thoughtSignature } } }
      : {}),
  };
}
export function geminiToAnthropic(raw, model) {
  const value = unwrap(raw);
  const candidate = value?.candidates?.[0];
  if (value?.error) throw new HttpError(502, 'Google 返回了生成错误');
  if (blocked(value, candidate)) throw new HttpError(403, 'Google 阻止了此内容的生成');
  if (!candidate) throw new HttpError(502, 'Google 未返回候选结果');
  const content = [];
  for (const part of candidate.content?.parts || []) {
    if (part.functionCall) content.push(toolBlock(part));
    else if (part.text != null)
      content.push(
        part.thought
          ? {
              type: 'thinking',
              thinking: String(part.text),
              signature: part.thoughtSignature || '',
            }
          : { type: 'text', text: String(part.text) },
      );
    else if (part.thoughtSignature && content.at(-1)?.type === 'thinking')
      content.at(-1).signature += part.thoughtSignature;
    else if (part.inlineData)
      throw new HttpError(502, 'Messages 接口暂不支持图片输出，请使用 Gemini 接口');
  }
  return {
    id: 'msg_' + crypto.randomUUID().replaceAll('-', ''),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason(
      candidate.finishReason,
      content.some((block) => block.type === 'tool_use'),
    ),
    stop_sequence: null,
    usage: anthropicUsage(value.usageMetadata),
  };
}

export function anthropicStream(
  upstream,
  model,
  abort = () => {},
  onFinish = () => {},
  onError = async () => {},
  onComplete = async () => {},
  onCancel = async () => {},
  toolNames,
  showThoughts = true,
) {
  const control = {};
  const events = sseEvents(upstream, control);
  const id = 'msg_' + crypto.randomUUID().replaceAll('-', '');
  const encoder = new TextEncoder();
  let index = -1;
  let active = null;
  let tools = false;
  let finish;
  let started = false;
  let meta = {};
  const close = () => {
    const value = { type: 'content_block_stop', index };
    active = null;
    return value;
  };
  async function* output() {
    try {
      for await (const event of events) {
        if (event === '[DONE]') break;
        const value = unwrap(restoreToolNames(JSON.parse(event), toolNames, showThoughts));
        const candidate = value?.candidates?.[0];
        if (value?.error || blocked(value, candidate))
          throw new Error('Google 返回生成错误或内容限制');
        if (value.usageMetadata) meta = { ...meta, ...value.usageMetadata };
        if (!started) {
          yield {
            type: 'message_start',
            message: {
              id,
              type: 'message',
              role: 'assistant',
              content: [],
              model,
              stop_reason: null,
              stop_sequence: null,
              usage: { ...anthropicUsage(meta), output_tokens: 0 },
            },
          };
          started = true;
        }
        for (const part of candidate?.content?.parts || []) {
          if (part.functionCall) {
            if (active) yield close();
            index++;
            const block = toolBlock(part);
            tools = true;
            yield { type: 'content_block_start', index, content_block: { ...block, input: {} } };
            yield {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
            };
            yield { type: 'content_block_stop', index };
          } else if (part.text != null) {
            const type = part.thought ? 'thinking' : 'text';
            if (active !== type) {
              if (active) yield close();
              index++;
              active = type;
              yield {
                type: 'content_block_start',
                index,
                content_block:
                  type === 'thinking' ? { type, thinking: '', signature: '' } : { type, text: '' },
              };
            }
            yield {
              type: 'content_block_delta',
              index,
              delta:
                type === 'thinking'
                  ? { type: 'thinking_delta', thinking: String(part.text) }
                  : { type: 'text_delta', text: String(part.text) },
            };
            if (part.thoughtSignature && active === 'thinking')
              yield {
                type: 'content_block_delta',
                index,
                delta: { type: 'signature_delta', signature: part.thoughtSignature },
              };
          } else if (part.thoughtSignature && active === 'thinking')
            yield {
              type: 'content_block_delta',
              index,
              delta: { type: 'signature_delta', signature: part.thoughtSignature },
            };
          else if (part.inlineData) throw new Error('Messages 接口暂不支持图片输出');
        }
        if (candidate?.finishReason) finish = candidate.finishReason;
      }
      if (!finish) throw new Error('Google 流提前结束，未返回 finishReason');
      await onComplete(meta);
      if (active) yield close();
      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason(finish, tools), stop_sequence: null },
        usage: anthropicUsage(meta),
      };
      yield { type: 'message_stop' };
    } catch (error) {
      await onError(meta);
      yield { type: 'error', error: { type: 'api_error', message: error.message } };
    } finally {
      onFinish();
    }
  }
  const iterator = output();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else
        controller.enqueue(
          encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`),
        );
    },
    async cancel() {
      abort();
      await onCancel(meta);
      if (control.cancel) await control.cancel();
      else await upstream.cancel().catch(() => {});
      await iterator.return();
      onFinish();
    },
  });
}
export function estimateTokens(request) {
  let text = 0;
  let images = 0;
  const stack = [request.contents, request.systemInstruction];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'string') text += value.length;
    else if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else if (value && typeof value === 'object') {
      if (value.inlineData || value.inline_data) {
        images++;
        continue;
      }
      for (const item of Object.values(value)) stack.push(item);
    }
  }
  if (request.tools) text += JSON.stringify(request.tools).length;
  return Math.max(1, Math.ceil(text / 4) + images * 300);
}
export function anthropicErrorType(status) {
  return (
    {
      400: 'invalid_request_error',
      401: 'authentication_error',
      403: 'permission_error',
      404: 'not_found_error',
      413: 'request_too_large',
      429: 'rate_limit_error',
      503: 'overloaded_error',
    }[status] || 'api_error'
  );
}
