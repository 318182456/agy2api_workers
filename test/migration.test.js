import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanToolSchema } from '../src/protocols/schema.js';
import { normalizeRequest } from '../src/protocols/gemini.js';
import { openaiToGemini } from '../src/protocols/openai.js';
import { anthropicToGemini } from '../src/protocols/anthropic.js';
import { collectGoogleStream } from '../src/upstream/stream-collect.js';
import { validateSetting } from '../src/config/settings.js';
const message = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
const stream = (values) =>
  new Response(
    values.map((v) => 'data: ' + (typeof v === 'string' ? v : JSON.stringify(v)) + '\n\n').join(''),
  ).body;
test('schema expands local references, merges allOf, simplifies nullable unions without mutating inputs', () => {
  const input = {
    $defs: {
      'a/b': {
        type: 'object',
        properties: { type: { type: ['string', 'null'], minLength: 2 } },
        required: ['type'],
      },
    },
    allOf: [
      { $ref: '#/$defs/a~1b' },
      { type: 'object', properties: { count: { anyOf: [{ const: 1 }, { const: 2 }] } } },
    ],
  };
  const before = JSON.stringify(input);
  const result = cleanToolSchema(input);
  assert.equal(result.properties.type.type, 'string');
  assert.match(result.properties.type.description, /minLength/);
  assert.deepEqual(result.properties.count.enum, ['1', '2']);
  assert.deepEqual(result.required, ['type']);
  assert.equal(JSON.stringify(input), before);
});
test('schema preserves empty enum choices in descriptions instead of sending invalid Google enum members', () => {
  const input = {
    type: 'object',
    properties: {
      sort: { type: 'string', enum: ['', 'asc', 'desc'], default: '', description: 'Sort order' },
      empty: { type: 'string', enum: [''] },
      emptyConst: { const: '' },
      union: { anyOf: [{ const: '' }, { const: 'name' }] },
      emptyEnum: { type: 'string', enum: [] },
      filteredEnum: { type: 'string', enum: [null, {}] },
      ordinary: { enum: ['asc', 'desc', 'asc'] },
      values: { enum: [0, false, ' '] },
      nested: { type: 'array', items: { type: 'string', enum: ['', 'name'] } },
    },
    required: ['sort'],
  };
  const original = structuredClone(input);
  const result = cleanToolSchema(input);
  for (const name of ['sort', 'empty', 'emptyConst', 'union', 'emptyEnum', 'filteredEnum']) {
    assert.equal(result.properties[name].type, 'string');
    assert.equal(Object.hasOwn(result.properties[name], 'enum'), false, name);
    assert.match(result.properties[name].description, /Original enum/);
  }
  assert.match(result.properties.sort.description, /Sort order/);
  assert.match(result.properties.sort.description, /asc.*desc/);
  assert.match(result.properties.sort.description, /Empty string is an allowed value/);
  assert.match(result.properties.emptyConst.description, /Original constant/);
  assert.equal(result.properties.nested.items.enum, undefined);
  assert.deepEqual(result.properties.ordinary.enum, ['asc', 'desc']);
  assert.deepEqual(result.properties.values.enum, ['0', 'false', ' ']);
  assert.deepEqual(result.required, ['sort']);
  assert.deepEqual(input, original);
});

test('sixth tool sort enum is compatible across OpenAI, Anthropic and native inputs on both channels', () => {
  const schema = {
    $defs: { sort: { type: 'string', enum: ['', 'asc', 'desc'] } },
    type: 'object',
    properties: { sort: { $ref: '#/$defs/sort' } },
    required: ['sort'],
  };
  const tools = Array.from({ length: 6 }, (_, i) => ({ name: 'tool_' + i, parameters: schema }));
  const requests = [
    openaiToGemini({
      model: 'model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: tools.map((tool) => ({ type: 'function', function: tool })),
    }),
    anthropicToGemini({
      model: 'model',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
      tools: tools.map((tool) => ({ name: tool.name, input_schema: schema })),
    }),
    { ...message, tools: [{ function_declarations: tools }] },
  ];
  for (const request of requests) {
    const original = structuredClone(request);
    {
      const mode = 'antigravity';
      const result = normalizeRequest(request, 'model', mode).request;
      assert.equal(result.tools[0].functionDeclarations.length, 6);
      const tool = result.tools[0].functionDeclarations[5];
      const parameters = tool[mode === 'antigravity' ? 'parameters' : 'parametersJsonSchema'];
      assert.equal(parameters.properties.sort.type, 'string');
      assert.equal(parameters.properties.sort.enum, undefined);
      assert.match(parameters.properties.sort.description, /asc.*desc/);
      assert.deepEqual(parameters.required, ['sort']);
    }
    assert.deepEqual(request, original);
  }
});

test('schema bounds expansion, rejects remote/missing refs and preserves special property names', () => {
  const recursive = { type: 'object', properties: { next: { $ref: '#' } } };
  assert.match(JSON.stringify(cleanToolSchema(recursive)), /Recursive reference/);
  for (const schema of [
    false,
    { $ref: 'https://test/schema' },
    { $ref: '#/missing' },
    { $defs: { no: false }, $ref: '#/$defs/no' },
  ])
    assert.throws(() => cleanToolSchema(schema), { status: 400 });
  let deep = { type: 'string' };
  for (let i = 0; i < 30; i++) deep = { type: 'array', items: deep };
  assert.throws(() => cleanToolSchema(deep), { status: 400 });
  const special = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"},"properties":{"type":"boolean"}}}',
  );
  const result = cleanToolSchema(special);
  assert.ok(Object.hasOwn(result.properties, '__proto__'));
  assert.equal(result.properties.properties.type, 'boolean');
});
test('Antigravity aliases are exact and image normalization preserves generation limits', () => {
  assert.equal(
    normalizeRequest(message, 'claude-opus-4-6', 'antigravity').model,
    'claude-opus-4-6-thinking',
  );
  assert.equal(
    normalizeRequest(message, 'gemini-3.1-pro-high', 'antigravity').model,
    'gemini-3.1-pro-high',
  );
  assert.equal(normalizeRequest(message, 'custom-high', 'antigravity').model, 'custom-high');
  assert.equal(normalizeRequest(message, 'constructor', 'antigravity').model, 'constructor');
  assert.equal(
    normalizeRequest(message, 'claude-opus-4-6', 'antigravity').model,
    'claude-opus-4-6-thinking',
  );
  const result = normalizeRequest(
    {
      ...message,
      size: '1024x1536',
      generationConfig: { maxOutputTokens: 123, imageConfig: { aspectRatio: '1:1' } },
      tools: [],
    },
    'gemini-3-pro-image-4k-16x9',
    'antigravity',
  );
  assert.equal(result.model, 'gemini-3.1-flash-image');
  assert.deepEqual(result.request.generationConfig.imageConfig, {
    aspectRatio: '2:3',
    imageSize: '2K',
  });
  assert.equal(result.request.generationConfig.maxOutputTokens, 123);
  assert.equal(result.request.tools, undefined);
});
test('parallel same-name Claude tool responses retain explicitly matched IDs and real signatures', () => {
  const request = openaiToGemini({
    model: 'claude-sonnet-4-6',
    messages: [
      {
        role: 'assistant',
        tool_calls: ['a', 'b'].map((id) => ({
          id,
          function: { name: 'f', arguments: '{}' },
          extra_content: { google: { thought_signature: 'real' } },
        })),
      },
      ...['b', 'a'].map((id) => ({ role: 'tool', tool_call_id: id, content: 'ok' })),
    ],
  });
  const result = normalizeRequest(request, 'claude-sonnet-4-6', 'antigravity').request;
  assert.deepEqual(
    result.contents[1].parts.map((p) => p.functionResponse.id),
    ['b', 'a'],
  );
  assert.equal(result.contents[0].parts[0].thoughtSignature, 'real');
});
test('stream collection preserves part order, signature, tools and latest cumulative usage', async () => {
  const chunk = (parts, extra = {}) => ({
    response: {
      candidates: [{ content: { parts }, ...extra }],
      usageMetadata: { candidatesTokenCount: extra.finishReason ? 5 : 2 },
    },
  });
  const result = await collectGoogleStream(
    stream([
      chunk([{ text: 'think', thought: true }]),
      chunk([{ thoughtSignature: 'actual' }, { text: 'hel' }]),
      chunk([{ text: 'lo' }, { functionCall: { id: 'x', name: 'f', args: {} } }], {
        finishReason: 'STOP',
      }),
    ]),
  );
  assert.deepEqual(result.candidates[0].content.parts, [
    { text: 'think', thought: true },
    { thoughtSignature: 'actual' },
    { text: 'hello' },
    { functionCall: { id: 'x', name: 'f', args: {} } },
  ]);
  assert.equal(result.usageMetadata.candidatesTokenCount, 5);
});
test('stream collection rejects empty/truncated/error/oversize streams and cancels its reader', async () => {
  for (const values of [
    [],
    [{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }],
    [{ error: { message: 'no' } }],
    ['{bad'],
  ])
    await assert.rejects(collectGoogleStream(stream(values)), { status: 502 });
  await assert.rejects(
    collectGoogleStream(stream([{ promptFeedback: { blockReason: 'SAFETY' } }]), 1),
    { status: 502 },
  );
  assert.equal(
    (await collectGoogleStream(stream([{ promptFeedback: { blockReason: 'SAFETY' } }])))
      .promptFeedback.blockReason,
    'SAFETY',
  );
  let cancelled = false;
  const source = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {bad}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(collectGoogleStream(source));
  assert.equal(cancelled, true);
});
test('stream collection setting accepts only booleans or reset', () => {
  assert.equal(validateSetting('ANTIGRAVITY_STREAM2NOSTREAM', true), true);
  assert.equal(validateSetting('ANTIGRAVITY_STREAM2NOSTREAM', null), null);
  assert.throws(() => validateSetting('ANTIGRAVITY_STREAM2NOSTREAM', 'true'), { status: 400 });
});

test('Denova Go any schemas preserve unconstrained values, arrays and local boolean references', () => {
  const input = {
    type: 'object',
    $defs: { value: true },
    properties: {
      value: true,
      values: { type: 'array', items: true },
      ref: { $ref: '#/$defs/value' },
      constrained: { $ref: '#/$defs/value', type: 'number' },
      nested: { type: 'object', properties: { value: true } },
      choice: { anyOf: [false, { type: 'number' }] },
      anything: { anyOf: [true, { type: 'string' }] },
    },
    required: ['value', 'values'],
    additionalProperties: false,
  };
  const before = structuredClone(input);
  const result = cleanToolSchema(input);
  for (const value of [
    result.properties.value,
    result.properties.ref,
    result.properties.values.items,
    result.properties.nested.properties.value,
  ])
    assert.deepEqual(value, {});
  assert.equal(result.properties.constrained.type, 'number');
  assert.equal(result.properties.choice.type, 'number');
  assert.equal(result.properties.anything.type, undefined);
  assert.deepEqual(result.required, ['value', 'values']);
  assert.deepEqual(input, before);
});

test('Denova boolean schemas normalize across OpenAI, Anthropic and native tool formats', () => {
  const schema = {
    type: 'object',
    properties: {
      state_changes: { type: 'array', items: { type: 'object', properties: { value: true } } },
      values: { type: 'array', items: true },
    },
    required: ['state_changes'],
  };
  const requests = [
    openaiToGemini({
      model: 'gemini-3.8-flash-tiered',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'submit_interactive_turn', parameters: schema } },
      ],
    }),
    anthropicToGemini({
      model: 'gemini-3.8-flash-tiered',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'submit_interactive_turn', input_schema: schema }],
    }),
    {
      ...message,
      tools: [{ functionDeclarations: [{ name: 'submit_interactive_turn', parameters: schema }] }],
    },
  ];
  for (const request of requests) {
    const normalized = normalizeRequest(request, 'gemini-3.8-flash-tiered', 'antigravity').request;
    const params = normalized.tools[0].functionDeclarations[0].parameters;
    assert.deepEqual(params.properties.state_changes.items.properties.value, {});
    assert.deepEqual(params.properties.values.items, {});
    assert.deepEqual(params.required, ['state_changes']);
  }
});

test('invalid tool schemas identify the function and nested JSON pointer without exposing data', () => {
  const input = {
    ...message,
    tools: [
      {
        functionDeclarations: [
          {
            name: 'submit_interactive_turn',
            parameters: {
              type: 'object',
              properties: {
                state_changes: {
                  type: 'array',
                  items: { type: 'object', properties: { value: null } },
                },
              },
            },
          },
        ],
      },
    ],
  };
  assert.throws(
    () => normalizeRequest(input, 'gemini-3.8-flash-tiered', 'antigravity'),
    (error) =>
      error.status === 400 &&
      error.message.includes('submit_interactive_turn') &&
      error.message.includes('$/properties/state_changes/items/properties/value'),
  );
  assert.throws(
    () => cleanToolSchema({ type: 'object', properties: { impossible: false } }),
    (error) => error.status === 400 && error.message.includes('$/properties/impossible'),
  );
});
