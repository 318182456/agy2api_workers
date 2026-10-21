// Optional compatibility stream: send heartbeats while one ordinary request is running.
// No additional generation requests are made by this transport adapter.
export function fakeStream(action, kind, model, includeUsage = false, signal, requestId) {
  const encoder = new TextEncoder(),
    abort = new AbortController();
  let stopped = false,
    timer,
    controllerRef;
  const cancel = () => {
    stopped = true;
    abort.abort();
    clearInterval(timer);
    try {
      controllerRef?.close();
    } catch {}
  };
  const body = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      const emit = (value, event) => {
        if (!stopped)
          controller.enqueue(
            encoder.encode(
              (event ? 'event: ' + event + '\n' : '') +
                'data: ' +
                (typeof value === 'string' ? value : JSON.stringify(value)) +
                '\n\n',
            ),
          );
      };
      const heartbeat = () => {
        if (!stopped) controller.enqueue(encoder.encode(': heartbeat\n\n'));
      };
      heartbeat();
      timer = setInterval(heartbeat, 10000);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      Promise.resolve()
        .then(() => (stopped ? null : action(abort.signal)))
        .then(async (response) => {
          if (stopped) return;
          const value = await response.json();
          if (stopped) return;
          if (!response.ok || value.error) {
            emit(
              {
                type: 'error',
                error: value.error || { message: '生成请求失败' },
                request_id: response.headers.get('x-request-id'),
              },
              kind === 'anthropic' ? 'error' : undefined,
            );
            return;
          }
          if (kind === 'gemini') emit(value);
          else if (kind === 'openai') {
            const choice = value.choices?.[0],
              message = choice?.message || {};
            const base = {
              id: value.id,
              object: 'chat.completion.chunk',
              created: value.created,
              model: value.model || model,
              ...(value.completion_status === 'unconfirmed'
                ? { completion_status: 'unconfirmed', warnings: value.warnings }
                : {}),
            };
            const { tool_calls, ...delta } = message;
            emit({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...delta,
                    ...(tool_calls
                      ? { tool_calls: tool_calls.map((call, index) => ({ index, ...call })) }
                      : {}),
                  },
                  finish_reason: null,
                },
              ],
            });
            emit({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason || 'stop' }],
            });
            if (includeUsage && value.usage) emit({ ...base, choices: [], usage: value.usage });
            emit('[DONE]');
          } else {
            emit(
              {
                type: 'message_start',
                message: {
                  ...value,
                  content: [],
                  stop_reason: null,
                  usage: { ...value.usage, output_tokens: 0 },
                },
              },
              'message_start',
            );
            for (const [index, block] of (value.content || []).entries()) {
              const initial =
                block.type === 'text'
                  ? { type: 'text', text: '' }
                  : block.type === 'thinking'
                    ? { type: 'thinking', thinking: '', signature: '' }
                    : block.type === 'tool_use'
                      ? { ...block, input: {} }
                      : block;
              emit(
                { type: 'content_block_start', index, content_block: initial },
                'content_block_start',
              );
              if (block.type === 'text')
                emit(
                  {
                    type: 'content_block_delta',
                    index,
                    delta: { type: 'text_delta', text: block.text },
                  },
                  'content_block_delta',
                );
              if (block.type === 'thinking') {
                emit(
                  {
                    type: 'content_block_delta',
                    index,
                    delta: { type: 'thinking_delta', thinking: block.thinking },
                  },
                  'content_block_delta',
                );
                if (block.signature)
                  emit(
                    {
                      type: 'content_block_delta',
                      index,
                      delta: { type: 'signature_delta', signature: block.signature },
                    },
                    'content_block_delta',
                  );
              }
              if (block.type === 'tool_use')
                emit(
                  {
                    type: 'content_block_delta',
                    index,
                    delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
                  },
                  'content_block_delta',
                );
              emit({ type: 'content_block_stop', index }, 'content_block_stop');
            }
            emit(
              {
                type: 'message_delta',
                delta: { stop_reason: value.stop_reason, stop_sequence: value.stop_sequence },
                usage: { output_tokens: value.usage?.output_tokens || 0 },
              },
              'message_delta',
            );
            emit({ type: 'message_stop' }, 'message_stop');
          }
        })
        .catch((error) => {
          if (!stopped)
            emit(
              {
                type: 'error',
                error: {
                  message: error.status ? error.message : '兼容流请求失败',
                  code: error.status || 500,
                  ...(error.errorCode ? { reason: error.errorCode } : {}),
                  ...(error.operation ? { stage: error.operation } : {}),
                },
                ...(requestId ? { request_id: requestId } : {}),
              },
              kind === 'anthropic' ? 'error' : undefined,
            );
        })
        .finally(() => {
          clearInterval(timer);
          signal?.removeEventListener('abort', cancel);
          if (!stopped) {
            stopped = true;
            controller.close();
          }
        });
    },
    cancel,
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-stream-mode': 'buffered-heartbeat',
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
  });
}
