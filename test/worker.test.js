import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handleRequest } from '../src/index.js';
import { accessToken, importCredential } from '../src/credentials.js';
import { convertedStream, geminiToOpenai, openaiToGemini, sseEvents } from '../src/convert.js';
import { upstreamPayload } from '../src/upstream.js';
import { readJson } from '../src/common.js';
globalThis.crypto ||= webcrypto;
const env = {
  API_PASSWORD: 'api-secret',
  PANEL_PASSWORD: 'panel-secret',
  GEMINICLI_MODELS: 'model-a,model-b',
  ANTIGRAVITY_CLIENT_ID: 'test-antigravity-client',
  ANTIGRAVITY_CLIENT_SECRET: 'test-antigravity-secret',
};
const request = (path, body, key = 'api-secret', method = body ? 'POST' : 'GET') =>
  new Request('https://example.com' + path, {
    method,
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
const candidate = (text = '你好') => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
});
const rowData = () => ({ token: 'token', project_id: 'project', expiry: '2099-01-01T00:00:00Z' });
function fakeDB(data = rowData()) {
  const calls = [];
  const row = { id: '1', mode: 'geminicli', data: JSON.stringify(data) };
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return this;
        },
        async first() {
          return row;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
}
const stream = (text) =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

test('health and management page work without passwords or D1', async () => {
  assert.equal((await handleRequest(request('/health'), {})).status, 200);
  const response = await handleRequest(request('/'), {});
  assert.match(await response.text(), /GCLI2API Workers/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('missing passwords fail closed, API and panel passwords are isolated', async () => {
  assert.equal((await handleRequest(request('/v1/models'), {})).status, 503);
  assert.equal((await handleRequest(request('/v1/models', null, 'panel-secret'), env)).status, 401);
  assert.equal((await handleRequest(request('/admin/credentials'), env)).status, 401);
  assert.equal(
    (await handleRequest(request('/auth/login', { password: 'wrong' }), env)).status,
    401,
  );
  assert.equal(
    (await handleRequest(request('/auth/login', { password: 'panel-secret' }), env)).status,
    200,
  );
});

test('models are configurable, Gemini query keys work, admin has no CORS', async () => {
  const response = await handleRequest(request('/v1/models'), env);
  assert.deepEqual(
    (await response.json()).data.map((m) => m.id),
    ['model-a', 'model-b'],
  );
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const native = await handleRequest(new Request('https://x/v1beta/models?key=api-secret'), env);
  assert.equal((await native.json()).models[0].name, 'models/model-a');
  const admin = await handleRequest(request('/admin/credentials', null, 'panel-secret'), {
    ...env,
    DB: fakeDB(),
  });
  assert.equal(admin.headers.get('access-control-allow-origin'), null);
});

test('OpenAI conversion preserves system, tools, inline images and signatures', () => {
  const result = openaiToGemini({
    model: 'm',
    messages: [
      { role: 'system', content: 'Be concise' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'a',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Shanghai"}' },
            extra_content: { google: { thought_signature: 'signature' } },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: '{"temp":20}' },
    ],
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }],
    tool_choice: 'required',
    max_tokens: 100,
  });
  assert.equal(result.systemInstruction.parts[0].text, 'Be concise');
  assert.equal(result.contents[0].parts[0].inlineData.data, 'YQ==');
  assert.equal(result.contents[1].parts[0].thoughtSignature, 'signature');
  assert.equal(result.contents[2].parts[0].functionResponse.name, 'weather');
  assert.equal(result.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.equal(result.generationConfig.maxOutputTokens, 100);
  assert.throws(
    () =>
      openaiToGemini({
        model: 'm',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://remote/image' } }],
          },
        ],
      }),
    /base64/,
  );
});

test('non-stream conversion unwraps, maps thoughts, tool calls, usage and blocking', () => {
  const value = candidate();
  value.candidates[0].content.parts.push(
    { text: 'think', thought: true },
    { functionCall: { name: 'f', args: { x: 1 } }, thoughtSignature: 'sig' },
  );
  const response = geminiToOpenai({ response: value }, 'm');
  assert.equal(response.choices[0].message.content, '你好');
  assert.equal(response.choices[0].message.reasoning_content, 'think');
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(
    response.choices[0].message.tool_calls[0].extra_content.google.thought_signature,
    'sig',
  );
  assert.equal(response.usage.total_tokens, 5);
  assert.equal(
    geminiToOpenai({ promptFeedback: { blockReason: 'SAFETY' } }, 'm').choices[0].finish_reason,
    'content_filter',
  );
});

test('SSE parsing handles split UTF-8, CRLF, comments and multiline data', async () => {
  const bytes = new TextEncoder().encode(
    ': ping\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: [DONE]\n\n',
  );
  const input = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i++) c.enqueue(bytes.slice(i, i + 1));
      c.close();
    },
  });
  const events = [];
  for await (const event of sseEvents(input)) events.push(event);
  assert.equal(JSON.parse(events[0]).text, '你好');
  assert.equal(events[1], '[DONE]');
});

test('OpenAI streaming returns usage, stable IDs and exactly one finish event', async () => {
  const input = stream(
    'data: ' +
      JSON.stringify({ response: candidate() }) +
      '\n\ndata: ' +
      JSON.stringify({ response: { usageMetadata: { totalTokenCount: 5 } } }) +
      '\n\n',
  );
  const text = await new Response(convertedStream(input, 'm', true, true)).text();
  const events = text
    .trim()
    .split('\n\n')
    .map((x) => x.slice(6));
  assert.equal(events.at(-1), '[DONE]');
  const values = events.slice(0, -1).map(JSON.parse);
  assert.equal(values.filter((v) => v.choices[0]?.finish_reason).length, 1);
  assert.equal(new Set(values.map((v) => v.id)).size, 1);
  assert.equal(values.at(-1).usage.total_tokens, 5);
});

test('truncated or malformed upstream SSE reports an error without success marker', async () => {
  const input = stream(
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
  );
  const text = await new Response(convertedStream(input, 'm', true)).text();
  assert.match(text, /upstream_error/);
  assert.doesNotMatch(text, /\[DONE\]/);
});

test('downstream cancellation stops an upstream read that is waiting for data', async () => {
  let cancelled = false;
  let aborted = false;
  const upstream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const reader = convertedStream(upstream, 'm', true, false, () => {
    aborted = true;
  }).getReader();
  const pending = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await reader.cancel();
  await pending;
  assert.equal(cancelled, true);
  assert.equal(aborted, true);
});

test('import stores only known credential fields and never exposes token_uri', async () => {
  const db = fakeDB();
  await importCredential(
    db,
    {
      name: 'test',
      credential: { project_id: 'p', refresh_token: 'r', token_uri: 'https://evil.example' },
    },
    { GEMINICLI_CLIENT_ID: 'test-client', GEMINICLI_CLIENT_SECRET: 'test-secret' },
  );
  const saved = JSON.parse(db.calls[0].args[3]);
  assert.equal(saved.refresh_token, 'r');
  assert.equal(saved.token_uri, undefined);
  assert.equal(saved.client_id, 'test-client');
  assert.equal(saved.client_secret, 'test-secret');
  await assert.rejects(importCredential(db, { credential: { token: 't' } }), /project_id/);
});

test('refresh posts only to Google and persists rotated refresh tokens', async () => {
  const db = fakeDB();
  const data = {
    project_id: 'p',
    refresh_token: 'r',
    client_id: 'client',
    client_secret: 'secret',
    token_uri: 'https://evil.example',
  };
  const token = await accessToken(db, { id: '1', data }, async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    return Response.json({
      access_token: 'new-token',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    });
  });
  assert.equal(token, 'new-token');
  assert.equal(JSON.parse(db.calls[0].args[0]).refresh_token, 'new-refresh');
  assert.match(db.calls[0].sql, /AND data=\?/);
});

test('full OpenAI and native routes use stored credentials and correct upstream envelopes', async () => {
  const db = fakeDB();
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal:generateContent');
    assert.equal(options.headers.authorization, 'Bearer token');
    const payload = JSON.parse(options.body);
    assert.equal(payload.project, 'project');
    assert.equal(payload.request.contents[0].parts[0].text, 'hello');
    return Response.json({ response: candidate() });
  };
  const a = await handleRequest(
    request('/v1/chat/completions', {
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
    }),
    { ...env, DB: db },
    fetcher,
  );
  assert.equal(a.status, 200);
  assert.equal((await a.json()).choices[0].message.content, '你好');
  const b = await handleRequest(
    request('/v1beta/models/model-a:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    }),
    { ...env, DB: db },
    fetcher,
  );
  assert.equal((await b.json()).candidates[0].content.parts[0].text, '你好');
});

test('upstream region errors and retry-after are preserved', async () => {
  const response = await handleRequest(
    request('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    { ...env, DB: fakeDB() },
    async () =>
      Response.json(
        { error: { message: 'unsupported region' } },
        { status: 403, headers: { 'retry-after': '30' } },
      ),
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal((await response.json()).error.message, 'unsupported region');
});

test('expired access token refreshes once after an upstream 401', async () => {
  let count = 0;
  let refresh = 0;
  const db = fakeDB({ ...rowData(), refresh_token: 'refresh', client_id: 'c', client_secret: 's' });
  const fetcher = async (url, options) => {
    if (url.endsWith('/token')) {
      refresh++;
      return Response.json({ access_token: 'new' });
    }
    count++;
    if (count === 1) return Response.json({ error: 'expired' }, { status: 401 });
    assert.equal(options.headers.authorization, 'Bearer new');
    return Response.json(candidate());
  };
  const response = await handleRequest(
    request('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    { ...env, DB: db },
    fetcher,
  );
  assert.equal(response.status, 200);
  assert.equal(count, 2);
  assert.equal(refresh, 1);
});

test('Antigravity uses its own endpoint and envelope', async () => {
  const response = await handleRequest(
    request('/antigravity/v1/chat/completions', {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    { ...env, DB: fakeDB() },
    async (url, options) => {
      assert.match(url, /daily-cloudcode-pa/);
      const body = JSON.parse(options.body);
      assert.equal(body.userAgent, 'antigravity');
      assert.equal(body.requestType, 'agent');
      assert.ok(body.request.sessionId);
      return Response.json(candidate());
    },
  );
  assert.equal(response.status, 200);
  const original = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], safetySettings: [] };
  assert.equal(
    upstreamPayload(original, 'm', 'p', 'antigravity').request.safetySettings,
    undefined,
  );
  assert.ok(original.safetySettings);
});

test('invalid request bodies and unsupported prefixes fail before upstream calls', async () => {
  const local = { ...env, DB: fakeDB() };
  const bad = request('/v1/chat/completions', { model: '抗截断/model', messages: [] });
  assert.equal((await handleRequest(bad, local)).status, 400);
  const raw = new Request('https://x/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer api-secret' },
    body: '[]',
  });
  assert.equal((await handleRequest(raw, local)).status, 400);
  const huge = new Request('https://x', { method: 'POST', body: 'x'.repeat(4 * 1024 * 1024 + 1) });
  await assert.rejects(readJson(huge), /4 MiB/);
});

const quotaId = '11111111-1111-4111-8111-111111111111';
function quotaDB(mode = 'antigravity', data = rowData(), exists = true) {
  const db = fakeDB(data);
  const original = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = original(sql);
    statement.first = async () =>
      exists
        ? { id: quotaId, name: 'quota-test', mode, disabled: 1, data: JSON.stringify(data) }
        : null;
    return statement;
  };
  return db;
}

test('quota normalization distinguishes zero, missing, invalid and full quota', async () => {
  const { normalizeQuota } = await import('../src/quota.js');
  const result = normalizeQuota({
    models: {
      empty: { quotaInfo: { remainingFraction: 0, resetTime: '2026-10-15T03:08:36Z' } },
      full: { quotaInfo: { remainingFraction: 1 } },
      missing: {},
      nullValue: { quotaInfo: { remainingFraction: null } },
      stringValue: { quotaInfo: { remainingFraction: '0.5' } },
      bad: { quotaInfo: { remainingFraction: 1.5, resetTime: 'invalid' } },
    },
  });
  assert.equal(result[0].remaining, 0);
  assert.equal(result[0].resetTime, '2026-10-15T03:08:36Z');
  assert.equal(result[1].remaining, 1);
  for (const item of result.slice(2)) assert.equal(item.remaining, null);
  assert.equal(result.at(-1).resetTime, null);
  assert.deepEqual(normalizeQuota({ models: {} }), []);
  assert.throws(() => normalizeQuota({}), /未返回有效/);
});

test('quota uses requested disabled Antigravity credential without rotation or generation', async () => {
  const db = quotaDB();
  let calls = 0;
  const response = await handleRequest(
    request('/admin/credentials/' + quotaId + '/quota', null, 'panel-secret'),
    { ...env, DB: db },
    async (url, options) => {
      calls++;
      assert.equal(
        url,
        'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      );
      assert.equal(options.body, '{}');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer token');
      return Response.json({
        models: {
          'test-model': {
            quotaInfo: { remainingFraction: 0.75, resetTime: '2026-10-16T00:00:00Z' },
          },
        },
      });
    },
  );
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.models[0].remaining, 0.75);
  assert.equal(value.credentialId, quotaId);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(
    db.calls.some((call) => call.sql.includes('last_used')),
    false,
  );
  assert.equal(JSON.stringify(value).includes('token'), false);
});

test('quota requires panel authentication, GET, existing credential and correct channel', async () => {
  const path = '/admin/credentials/' + quotaId + '/quota';
  const noNetwork = async () => {
    assert.fail('should not call upstream');
  };
  assert.equal(
    (await handleRequest(request(path), { ...env, DB: quotaDB() }, noNetwork)).status,
    401,
  );
  assert.equal(
    (await handleRequest(request(path, {}, 'panel-secret'), { ...env, DB: quotaDB() }, noNetwork))
      .status,
    405,
  );
  assert.equal(
    (
      await handleRequest(
        request(path, null, 'panel-secret'),
        { ...env, DB: quotaDB('geminicli') },
        noNetwork,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleRequest(
        request(path, null, 'panel-secret'),
        { ...env, DB: quotaDB('antigravity', rowData(), false) },
        noNetwork,
      )
    ).status,
    404,
  );
});

test('quota refreshes after 401 and returns refreshed token only to Google', async () => {
  const data = { ...rowData(), refresh_token: 'r', client_id: 'client', client_secret: 'secret' };
  let calls = 0;
  let refreshed = 0;
  const db = quotaDB('antigravity', data);
  const response = await handleRequest(
    request('/admin/credentials/' + quotaId + '/quota', null, 'panel-secret'),
    { ...env, DB: db },
    async (url, options) => {
      if (url.endsWith('/token')) {
        refreshed++;
        return Response.json({ access_token: 'updated-token' });
      }
      calls++;
      if (calls === 1) return new Response('', { status: 401 });
      assert.equal(options.headers.authorization, 'Bearer updated-token');
      return Response.json({ models: {} });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(refreshed, 1);
  assert.deepEqual((await response.json()).models, []);
  assert.equal(db.calls.filter((call) => call.sql.startsWith('UPDATE')).length, 1);
});

test('quota errors preserve region status and distinguish invalid responses', async () => {
  const path = '/admin/credentials/' + quotaId + '/quota';
  const cases = [
    [async () => new Response('sensitive upstream details', { status: 403 }), 403, /地区/],
    [async () => new Response('invalid JSON'), 502, /无效 JSON/],
    [async () => Response.json({}), 502, /未返回有效/],
    [
      async () => {
        throw new Error('network secret');
      },
      502,
      /连接失败/,
    ],
  ];
  for (const [fetcher, status, pattern] of cases) {
    const response = await handleRequest(
      request(path, null, 'panel-secret'),
      { ...env, DB: quotaDB() },
      fetcher,
    );
    assert.equal(response.status, status);
    const text = await response.text();
    assert.match(text, pattern);
    assert.doesNotMatch(text, /sensitive|network secret/);
  }
});

test('management page embeds valid JavaScript with quota controls and fixed timezone', async () => {
  const { panel } = await import('../src/panel.js');
  const script = panel.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /查看额度/);
  assert.match(script, /Asia\/Shanghai/);
  assert.match(script, /model.remaining == null/);
});

test('known OAuth client prevents import into the wrong channel', async () => {
  const db = fakeDB();
  await assert.rejects(
    importCredential(
      db,
      {
        mode: 'geminicli',
        credential: {
          project_id: 'p',
          refresh_token: 'r',
          client_id: 'test-antigravity-client',
        },
      },
      env,
    ),
    /属于 antigravity/,
  );
  assert.equal(db.calls.length, 0);
});

test('credential metadata reports detected mode without exposing stored tokens', async () => {
  const { listCredentials } = await import('../src/credentials.js');
  const data = { ...rowData(), client_id: 'test-antigravity-client' };
  const db = {
    prepare() {
      return {
        async all() {
          return {
            results: [
              {
                id: quotaId,
                name: 'a',
                mode: 'geminicli',
                disabled: 0,
                data: JSON.stringify(data),
              },
            ],
          };
        },
      };
    },
  };
  const result = await listCredentials(db, env);
  assert.equal(result[0].detected_mode, 'antigravity');
  assert.equal(result[0].mode, 'geminicli');
  assert.equal(result[0].data, undefined);
  assert.equal(JSON.stringify(result).includes('client_id'), false);
  assert.equal(JSON.stringify(result).includes('token'), false);
});

test('repair mode via admin endpoint preserves enabled state without changing token data', async () => {
  const data = { ...rowData(), client_id: 'test-antigravity-client' };
  const db = quotaDB('geminicli', data);
  const response = await handleRequest(
    request('/admin/credentials/' + quotaId, { mode: 'antigravity' }, 'panel-secret', 'PATCH'),
    { ...env, DB: db },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'antigravity');
  const update = db.calls.find((call) => call.sql.startsWith('UPDATE'));
  assert.deepEqual(update.args, ['antigravity', 1, quotaId]);
  assert.equal(update.sql.includes('data='), false);
});

test('mode repair rejects known incompatible target, missing row, and duplicate name', async () => {
  const { updateCredential } = await import('../src/credentials.js');
  const data = { ...rowData(), client_id: 'test-antigravity-client' };
  await assert.rejects(
    updateCredential(quotaDB('antigravity', data), quotaId, { mode: 'geminicli' }, env),
    /不能改为/,
  );
  await assert.rejects(
    updateCredential(quotaDB('antigravity', data, false), quotaId, { mode: 'antigravity' }),
    /不存在/,
  );
  const db = quotaDB('geminicli', data);
  const original = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = original(sql);
    if (sql.startsWith('UPDATE'))
      statement.run = async () => {
        throw new Error('D1_ERROR: UNIQUE constraint failed: credentials.mode, credentials.name');
      };
    return statement;
  };
  await assert.rejects(
    updateCredential(db, quotaId, { mode: 'antigravity' }),
    (error) => error.status === 409,
  );
});

test('disabled PATCH still works for incorrectly categorized old credentials', async () => {
  const { updateCredential } = await import('../src/credentials.js');
  const db = quotaDB('geminicli', { ...rowData(), client_id: 'test-antigravity-client' });
  await updateCredential(db, quotaId, { disabled: false });
  assert.deepEqual(db.calls.find((call) => call.sql.startsWith('UPDATE')).args, [
    'geminicli',
    0,
    quotaId,
  ]);
});

test('503 identifies the selected mode and its Base URL', async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
  const response = await handleRequest(
    request('/antigravity/v1/chat/completions', {
      model: 'm',
      messages: [{ role: 'user', content: 'hello' }],
    }),
    { ...env, DB: db },
  );
  assert.equal(response.status, 503);
  const value = await response.json();
  assert.match(value.error.message, /antigravity 渠道/);
  assert.match(value.error.message, /已启用/);
  assert.match(value.error.message, /\/antigravity\/v1/);
});

test('OAuth network failure and malformed token responses return 502 rather than database error', async () => {
  const data = {
    ...rowData(),
    expiry: '2000-01-01T00:00:00Z',
    refresh_token: 'private-refresh',
    client_id: 'c',
    client_secret: 'private-secret',
  };
  const path = '/admin/credentials/' + quotaId + '/quota';
  for (const fetcher of [
    async () => {
      throw new TypeError('private-network-detail');
    },
    async () => new Response('not JSON'),
    async () => Response.json(null),
    async () => Response.json({ access_token: 't', expires_in: 'nonsense' }),
  ]) {
    const response = await handleRequest(
      request(path, null, 'panel-secret'),
      { ...env, DB: quotaDB('antigravity', data) },
      fetcher,
    );
    assert.equal(response.status, 502);
    const value = await response.json();
    assert.match(value.error.message, /OAuth/);
    assert.equal(value.error.stage, 'oauth_refresh');
    assert.ok(value.error.request_id);
    assert.doesNotMatch(
      JSON.stringify(value),
      /private-refresh|private-secret|private-network-detail/,
    );
  }
});

test('database schema errors identify migration separately from corrupt credential data', async () => {
  const badDB = {
    prepare() {
      throw new Error('D1_ERROR: no such table: credentials');
    },
  };
  let response = await handleRequest(
    request('/admin/credentials/' + quotaId + '/quota', null, 'panel-secret'),
    { ...env, DB: badDB },
  );
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.reason, 'DB_SCHEMA_ERROR');
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return { id: quotaId, mode: 'antigravity', data: 'bad json' };
        },
      };
    },
  };
  response = await handleRequest(
    request('/admin/credentials/' + quotaId + '/quota', null, 'panel-secret'),
    { ...env, DB: db },
  );
  assert.equal(response.status, 500);
  const value = await response.json();
  assert.equal(value.error.reason, 'CREDENTIAL_DATA_INVALID');
  assert.match(value.error.message, /重新导入/);
});

test('signed session survives new page requests without sending the management password', async () => {
  const response = await handleRequest(request('/auth/login', { password: 'panel-secret' }), env);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=604800/);
  assert.doesNotMatch(setCookie, /panel-secret/);
  const cookie = setCookie.split(';')[0];
  const session = await handleRequest(
    new Request('https://example.com/auth/session', { headers: { cookie } }),
    env,
  );
  assert.equal((await session.json()).authenticated, true);
  const admin = await handleRequest(
    new Request('https://example.com/admin/credentials', { headers: { cookie } }),
    { ...env, DB: fakeDB() },
  );
  assert.equal(admin.status, 200);
  const chat = await handleRequest(
    new Request('https://example.com/v1/models', { headers: { cookie } }),
    env,
  );
  assert.equal(chat.status, 401);
});

test('session signature, expiration, password rotation and origin binding are enforced', async () => {
  const { createSession, hasSession, SESSION_SECONDS } = await import('../src/session.js');
  const base = new Request('https://example.com/');
  const cookie = (await createSession(base, 'password')).split(';')[0];
  const withCookie = (origin = 'https://example.com', value = cookie) =>
    new Request(origin, { headers: { cookie: value } });
  assert.equal(await hasSession(withCookie(), 'password'), true);
  assert.equal(await hasSession(withCookie(), 'changed-password'), false);
  assert.equal(await hasSession(withCookie('https://other.example'), 'password'), false);
  assert.equal(
    await hasSession(withCookie('https://example.com', cookie + 'tampered'), 'password'),
    false,
  );
  assert.equal(
    await hasSession(withCookie(), 'password', Date.now() + (SESSION_SECONDS + 1) * 1000),
    false,
  );
  assert.equal(await hasSession(new Request('https://example.com'), 'password'), false);
});

test('cookie-authenticated management writes require a same-origin request', async () => {
  const login = await handleRequest(request('/auth/login', { password: 'panel-secret' }), env);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const path = 'https://example.com/admin/credentials';
  const body = {
    name: 'new',
    mode: 'geminicli',
    credential: { project_id: 'p', refresh_token: 'r' },
  };
  const send = (origin) =>
    handleRequest(
      new Request(path, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      }),
      { ...env, DB: fakeDB() },
    );
  assert.equal((await send('https://evil.example')).status, 403);
  assert.equal((await send()).status, 403);
  assert.equal((await send('https://example.com')).status, 201);
  const badKey = await handleRequest(
    new Request(path, { headers: { cookie, authorization: 'Bearer incorrect' } }),
    { ...env, DB: fakeDB() },
  );
  assert.equal(badKey.status, 401);
});

test('logout expires cookie and cross-origin login is rejected', async () => {
  const response = await handleRequest(request('/auth/logout', {}, 'unused'), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  const attempt = new Request('https://example.com/auth/login', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'panel-secret' }),
  });
  assert.equal((await handleRequest(attempt, env)).status, 403);
  const html = await (await handleRequest(request('/'), env)).text();
  assert.doesNotMatch(html, /let secret|localStorage|sessionStorage/);
  assert.match(html, /auth\/session/);
});

test('Google redirects are not followed and are classified separately from network failure', async () => {
  const { googleFetch } = await import('../src/common.js');
  let calls = 0;
  await assert.rejects(
    googleFetch(
      async (url, options) => {
        calls++;
        assert.equal(options.redirect, 'manual');
        return new Response('', {
          status: 302,
          headers: { location: 'https://elsewhere.example' },
        });
      },
      'https://google.example',
      {},
      'quota_fetch',
    ),
    (error) => error.errorCode === 'UPSTREAM_REDIRECT',
  );
  assert.equal(calls, 1);
});

test('OAuth endpoints reject unauthenticated callers, forged and malformed callbacks', async () => {
  const local = { ...env, DB: fakeDB() };
  assert.equal(
    (await handleRequest(request('/admin/oauth/start', { mode: 'antigravity' }), local)).status,
    401,
  );
  const { completeOAuth } = await import('../src/oauth.js');
  for (const url of [
    'https://evil.example/?code=x&state=s',
    'http://localhost:11451/?code=x',
    'http://localhost:11451/?code=x&state=s&state=other',
  ]) {
    await assert.rejects(
      completeOAuth(
        request('/admin/oauth/complete', {}),
        local,
        { callback_url: url },
        async () => {
          assert.fail('must not call Google');
        },
      ),
      (error) => error.status === 400,
    );
  }
});

test('GeminiCLI project verification preserves selected project and avoids choosing among several', async () => {
  const { verifyProject } = await import('../src/account.js');
  const db = fakeDB();
  const row = { id: '1', mode: 'geminicli', data: rowData() };
  const fetcher = async (url) => {
    assert.match(url, /cloudresourcemanager.googleapis.com/);
    return Response.json({
      projects: [
        { projectId: 'other', lifecycleState: 'ACTIVE' },
        { projectId: 'project', lifecycleState: 'ACTIVE' },
      ],
    });
  };
  assert.equal((await verifyProject({ DB: db }, row, fetcher)).project_id, 'project');
  const unknown = { id: '1', mode: 'geminicli', data: { ...rowData(), project_id: 'unknown' } };
  await assert.rejects(verifyProject({ DB: db }, unknown, fetcher), /多个项目/);
});

test('Antigravity OpenAI and Gemini model lists come from Google without vars or exposing quotas', async () => {
  const local = { ...env, DB: fakeDB() };
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, '{}');
    assert.equal(options.redirect, 'manual');
    return Response.json({
      models: { 'claude-example': { quotaInfo: { remainingFraction: 0.9 } }, 'gemini-example': {} },
    });
  };
  let response = await handleRequest(request('/antigravity/v1/models'), local, fetcher);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-model-list-source'), 'google');
  const value = await response.json();
  assert.deepEqual(
    value.data.map((model) => model.id),
    ['claude-example', 'gemini-example'],
  );
  assert.equal(JSON.stringify(value).includes('remainingFraction'), false);
  response = await handleRequest(
    new Request('https://example.com/antigravity/v1beta/models?key=api-secret'),
    local,
    fetcher,
  );
  assert.equal((await response.json()).models[0].name, 'models/claude-example');
  assert.equal(
    local.DB.calls.some((call) => call.sql.startsWith('UPDATE')),
    false,
  );
});

test('dynamic model failure only falls back when configured and marks its source', async () => {
  const local = { ...env, DB: fakeDB(), ANTIGRAVITY_MODELS: 'backup-model' };
  const fetcher = async () => Response.json({ error: 'permission' }, { status: 403 });
  let response = await handleRequest(request('/antigravity/v1/models'), local, fetcher);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-model-list-source'), 'fallback');
  assert.equal(response.headers.get('x-model-list-warning'), 'dynamic-discovery-failed');
  assert.equal((await response.json()).data[0].id, 'backup-model');
  response = await handleRequest(
    request('/antigravity/v1/models'),
    { ...local, ANTIGRAVITY_MODELS: '' },
    fetcher,
  );
  assert.equal(response.status, 403);
});

test('a successful empty Google list stays empty rather than inventing available models', async () => {
  const response = await handleRequest(
    request('/antigravity/v1/models'),
    { ...env, DB: fakeDB(), ANTIGRAVITY_MODELS: 'backup' },
    async () => Response.json({ models: {} }),
  );
  assert.equal(response.headers.get('x-model-list-source'), 'google');
  assert.deepEqual((await response.json()).data, []);
});

test('admin can inspect model source with session/Bearer; GeminiCLI does not call the Antigravity endpoint', async () => {
  let response = await handleRequest(
    request('/admin/models?mode=antigravity', null, 'panel-secret'),
    { ...env, DB: fakeDB() },
    async () => Response.json({ models: { real: {} } }),
  );
  assert.equal((await response.json()).source, 'google');
  response = await handleRequest(
    request('/admin/models?mode=geminicli', null, 'panel-secret'),
    env,
    async () => {
      assert.fail('GeminiCLI must not call Antigravity');
    },
  );
  const value = await response.json();
  assert.equal(value.source, 'vars');
  assert.deepEqual(value.ids, ['model-a', 'model-b']);
});

test('dynamic discovery refreshes an expired credential and retries an upstream 401 once', async () => {
  let count = 0;
  let refreshes = 0;
  const db = fakeDB({ ...rowData(), refresh_token: 'r', client_id: 'c', client_secret: 's' });
  const response = await handleRequest(
    request('/antigravity/v1/models'),
    { ...env, DB: db },
    async (url, options) => {
      if (url.endsWith('/token')) {
        refreshes++;
        return Response.json({ access_token: 'updated' });
      }
      count++;
      if (count === 1) return new Response('', { status: 401 });
      assert.equal(options.headers.authorization, 'Bearer updated');
      return Response.json({ models: { dynamic: {} } });
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].id, 'dynamic');
  assert.equal(refreshes, 1);
  assert.equal(count, 2);
});

test('known Gemini thinking profiles translate effort, budget and suffixes without mutating inputs', async () => {
  const { normalizeRequest } = await import('../src/normalize.js');
  const original = {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: {
      maxOutputTokens: 10,
      thinkingConfig: { thinkingBudget: 999999, includeThoughts: true },
    },
  };
  let result = normalizeRequest(original, 'gemini-2.5-flash', 'geminicli');
  assert.equal(result.request.generationConfig.thinkingConfig.thinkingBudget, 24576);
  assert.equal(result.request.generationConfig.maxOutputTokens, 10);
  assert.equal(original.generationConfig.thinkingConfig.thinkingBudget, 999999);
  result = normalizeRequest(original, 'gemini-3-pro-preview-low-search', 'geminicli');
  assert.equal(result.model, 'gemini-3-pro-preview');
  assert.equal(result.request.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(result.request.generationConfig.thinkingConfig.thinkingBudget, undefined);
  assert.deepEqual(result.request.tools, [{ googleSearch: {} }]);
  const converted = openaiToGemini({
    model: 'gemini-2.5-pro',
    reasoning_effort: 'none',
    messages: [{ role: 'user', content: 'hi' }],
  });
  result = normalizeRequest(converted, 'gemini-2.5-pro', 'geminicli');
  assert.equal(result.request.generationConfig.thinkingConfig.thinkingBudget, 128);
  assert.equal(result.request._reasoningEffort, undefined);
  assert.equal(normalizeRequest(original, 'custom-high', 'geminicli').model, 'custom-high');
});

test('message cleanup preserves tool signatures and drops only model-specific trailing prefill', async () => {
  const { normalizeRequest } = await import('../src/normalize.js');
  const input = {
    contents: [
      { role: 'user', parts: [{ text: '' }, { text: 'hi' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'sig' }],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'f', response: { x: 1 } } }] },
      { role: 'model', parts: [{ text: 'prefill' }] },
    ],
  };
  const result = normalizeRequest(input, 'gemini-2.5-flash', 'geminicli');
  assert.equal(result.request.contents.length, 3);
  assert.equal(result.request.contents[1].parts[0].thoughtSignature, 'sig');
  assert.equal(input.contents.length, 4);
  assert.equal(result.request.contents[0].parts.length, 1);
});

test('Retry-After seconds and HTTP dates determine bounded cooldowns', async () => {
  const { cooldownSeconds } = await import('../src/reliability.js');
  assert.equal(
    cooldownSeconds(new Response('', { status: 429, headers: { 'retry-after': '90' } })),
    90,
  );
  assert.equal(cooldownSeconds(new Response('', { status: 429 })), 60);
  assert.equal(cooldownSeconds(new Response('', { status: 503 })), 10);
  const now = Date.parse('2026-10-15T00:00:00Z');
  assert.equal(
    cooldownSeconds(
      new Response('', {
        status: 429,
        headers: { 'retry-after': 'Thu, 15 Oct 2026 00:02:00 GMT' },
      }),
      now,
    ),
    120,
  );
});

test('call log API is management-only and rejects invalid pagination', async () => {
  assert.equal(
    (await handleRequest(request('/admin/calls'), { ...env, DB: fakeDB() })).status,
    401,
  );
  assert.equal(
    (
      await handleRequest(request('/admin/calls?before=bad', null, 'panel-secret'), {
        ...env,
        DB: fakeDB(),
      })
    ).status,
    400,
  );
});

test('native Gemini role omission is accepted and Antigravity tool schema fields do not conflict', async () => {
  const { normalizeRequest } = await import('../src/normalize.js');
  const result = normalizeRequest(
    {
      contents: [{ parts: [{ text: 'hello' }] }],
      tools: [
        {
          function_declarations: [
            {
              name: 'a',
              parametersJsonSchema: { type: 'object', properties: { x: { type: 'string' } } },
            },
            { name: 'b' },
          ],
        },
      ],
    },
    'gemini-2.5-flash',
    'antigravity',
  );
  assert.equal(result.request.contents[0].role, 'user');
  const declarations = result.request.tools[0].functionDeclarations;
  assert.equal(declarations.length, 2);
  assert.equal(declarations[0].parameters.properties.x.type, 'string');
  assert.equal(declarations[0].parametersJsonSchema, undefined);
  assert.deepEqual(declarations[1].parameters, { type: 'object', properties: {} });
});

test('rename accepts trimmed display names and rejects empty, long or control-character names', async () => {
  const { updateCredential } = await import('../src/credentials.js');
  for (const name of ['', '   ', 'x'.repeat(201), 'bad\nname', 123]) {
    await assert.rejects(
      updateCredential(fakeDB(), quotaId, { name }),
      (error) => error.status === 400,
    );
  }
  const db = quotaDB();
  const result = await updateCredential(db, quotaId, { name: '  工作账号  ' });
  assert.equal(result.name, '工作账号');
  assert.deepEqual(db.calls.find((call) => call.sql.startsWith('UPDATE')).args, [
    'antigravity',
    1,
    '工作账号',
    quotaId,
  ]);
});

test('settings validate allowed keys, attempt bounds and model IDs', async () => {
  const { validateSetting } = await import('../src/settings.js');
  assert.equal(validateSetting('GEMINICLI_MODELS', 'a, b,a'), 'a,b');
  assert.equal(validateSetting('ANTIGRAVITY_MODELS', ''), '');
  assert.equal(validateSetting('MAX_CREDENTIAL_ATTEMPTS', null), null);
  for (const value of [0, 6, 1.5, '3'])
    assert.throws(() => validateSetting('MAX_CREDENTIAL_ATTEMPTS', value), /1–5/);
  assert.throws(() => validateSetting('API_PASSWORD', 'secret'), /不支持/);
  assert.throws(() => validateSetting('GEMINICLI_MODELS', 'bad/model'), /格式/);
});

test('Anthropic conversion preserves system, images, tool IDs/results and real thinking signatures', async () => {
  const { anthropicToGemini, geminiToAnthropic } = await import('../src/anthropic.js');
  const converted = anthropicToGemini({
    model: 'gemini-2.5-flash',
    max_tokens: 1000,
    system: [{ type: 'text', text: 'Be brief', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan', signature: 'signed' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'weather',
            input: { city: 'Shanghai' },
            extra_content: { google: { thought_signature: 'tool-signature' } },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '20C' }] },
        ],
      },
    ],
    tools: [{ name: 'weather', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'weather' },
    thinking: { type: 'enabled', budget_tokens: 100 },
  });
  assert.equal(converted.systemInstruction.parts[0].text, 'Be brief');
  assert.equal(converted.contents[0].parts[0].inlineData.data, 'YQ==');
  assert.equal(converted.contents[1].parts[0].thoughtSignature, 'signed');
  assert.equal(converted.contents[1].parts[1].functionCall.id, 'toolu_1');
  assert.equal(converted.contents[2].parts[0].functionResponse.name, 'weather');
  assert.equal(converted.contents[2].parts[0].functionResponse.id, 'toolu_1');
  assert.equal(converted.generationConfig.maxOutputTokens, 1000);
  const response = geminiToAnthropic(
    {
      response: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'plan', thought: true, thoughtSignature: 'signed' },
                {
                  functionCall: { id: 'toolu_a', name: 'weather', args: { city: 'Shanghai' } },
                  thoughtSignature: 'tool-sig',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          cachedContentTokenCount: 5,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 2,
        },
      },
    },
    'model',
  );
  assert.equal(response.type, 'message');
  assert.equal(response.stop_reason, 'tool_use');
  assert.equal(response.content[0].signature, 'signed');
  assert.equal(response.content[1].id, 'toolu_a');
  assert.equal(response.content[1].extra_content.google.thought_signature, 'tool-sig');
  assert.deepEqual(response.usage, {
    input_tokens: 15,
    output_tokens: 5,
    cache_read_input_tokens: 5,
  });
});

test('Anthropic unsupported content/tools and unmatched tool results fail clearly', async () => {
  const { anthropicToGemini } = await import('../src/anthropic.js');
  const base = { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] };
  assert.throws(() => anthropicToGemini({ ...base, max_tokens: 0 }), /正整数/);
  assert.throws(
    () =>
      anthropicToGemini({
        ...base,
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }],
          },
        ],
      }),
    /匹配/,
  );
  assert.throws(
    () =>
      anthropicToGemini({ ...base, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }),
    /服务端工具/,
  );
  assert.throws(() => anthropicToGemini({ ...base, thinking: { type: 'adaptive' } }), /thinking/);
});

test('Anthropic SSE uses ordered content blocks and tool JSON/signature events without DONE', async () => {
  const { anthropicStream } = await import('../src/anthropic.js');
  const data = [
    {
      candidates: [
        { content: { parts: [{ text: 'plan', thought: true, thoughtSignature: 'sig' }] } },
      ],
      usageMetadata: { promptTokenCount: 20 },
    },
    { candidates: [{ content: { parts: [{ text: 'hello' }] } }] },
    {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'f', args: { x: 1 } } }] },
          finishReason: 'STOP',
        },
      ],
    },
    { usageMetadata: { candidatesTokenCount: 3, thoughtsTokenCount: 2 } },
  ]
    .map((value) => 'data: ' + JSON.stringify({ response: value }) + '\n\n')
    .join('');
  const text = await new Response(anthropicStream(stream(data), 'm')).text();
  const values = text
    .trim()
    .split('\n\n')
    .map((event) =>
      JSON.parse(
        event
          .split('\n')
          .find((line) => line.startsWith('data: '))
          .slice(6),
      ),
    );
  assert.equal(values[0].type, 'message_start');
  assert.equal(values.at(-1).type, 'message_stop');
  assert.deepEqual(
    values
      .filter((value) => value.type === 'content_block_start')
      .map((value) => value.content_block.type),
    ['thinking', 'text', 'tool_use'],
  );
  assert.deepEqual(
    values.filter((value) => value.type === 'content_block_stop').map((value) => value.index),
    [0, 1, 2],
  );
  assert.ok(values.some((value) => value.delta?.type === 'signature_delta'));
  assert.ok(values.some((value) => value.delta?.partial_json === '{"x":1}'));
  assert.equal(values.at(-2).delta.stop_reason, 'tool_use');
  assert.equal(values.at(-2).usage.input_tokens, 20);
  assert.equal(values.at(-2).usage.output_tokens, 5);
  assert.doesNotMatch(text, /\[DONE\]/);
});

test('Anthropic truncated stream produces an error event without message_stop and cancels pending reads', async () => {
  const { anthropicStream } = await import('../src/anthropic.js');
  let logged = 0;
  const data = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n';
  const text = await new Response(
    anthropicStream(stream(data), 'm', undefined, undefined, async () => {
      logged++;
    }),
  ).text();
  assert.match(text, /event: error/);
  assert.doesNotMatch(text, /message_stop/);
  assert.equal(logged, 1);
  let cancelled = false;
  const reader = anthropicStream(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    'm',
  ).getReader();
  const pending = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reader.cancel();
  await pending;
  assert.equal(cancelled, true);
});

test('Messages and Gemini token counting is local, estimated and ignores base64 payload size', async () => {
  const { estimateTokens } = await import('../src/anthropic.js');
  const count = (size) =>
    estimateTokens({
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: 'x'.repeat(size) } }],
        },
      ],
    });
  assert.equal(count(10), count(100000));
  for (const [path, body, field] of [
    [
      '/v1/messages/count_tokens',
      { model: 'm', messages: [{ role: 'user', content: 'hello' }] },
      'input_tokens',
    ],
    ['/v1beta/models/m:countTokens', { contents: [{ parts: [{ text: 'hello' }] }] }, 'totalTokens'],
  ]) {
    const response = await handleRequest(
      new Request('https://example.com' + path, {
        method: 'POST',
        headers: { 'x-api-key': 'api-secret', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      async () => {
        assert.fail('must not call Google');
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-token-count-estimated'), 'true');
    assert.ok((await response.json())[field] > 0);
  }
  const denied = await handleRequest(
    request(
      '/v1/messages',
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] },
      'wrong',
    ),
    env,
  );
  assert.equal(denied.status, 401);
  const failure = await denied.json();
  assert.equal(failure.type, 'error');
  assert.equal(failure.error.type, 'authentication_error');
});

test('management page deep links survive refresh and unknown paths remain 404', async () => {
  for (const page of [
    'overview',
    'credentials',
    'import',
    'oauth',
    'quota',
    'logs',
    'models',
    'settings',
    'api',
  ]) {
    const response = await handleRequest(request('/panel/' + page), {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('id="page-' + page + '"'));
    assert.match(html, /v0\.15\.0/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.equal((await handleRequest(request('/panel/settings/'), {})).status, 200);
  assert.equal((await handleRequest(request('/panel/not-a-page'), {})).status, 404);
  assert.equal((await handleRequest(request('/admin/credentials'), {})).status, 503);
});

test('OAuth configuration is isolated by environment and missing configuration fails before DB writes', async () => {
  const { startOAuth } = await import('../src/oauth.js');
  const { detectedMode } = await import('../src/credentials.js');
  const db = fakeDB();
  await assert.rejects(
    startOAuth(request('/admin/oauth/start', {}), { DB: db }, { mode: 'antigravity' }),
    (error) => error.status === 503 && error.message.includes('ANTIGRAVITY_CLIENT_ID'),
  );
  assert.equal(db.calls.length, 0);
  assert.equal(detectedMode({ client_id: 'test-antigravity-client' }, env), 'antigravity');
  assert.equal(detectedMode({ client_id: 'test-antigravity-client' }, {}), null);
  const response = await handleRequest(request('/admin/credentials', null, 'panel-secret'), {
    ...env,
    DB: db,
  });
  const metadata = await response.json();
  assert.equal(metadata.oauth_clients['test-antigravity-client'], 'antigravity');
  assert.equal(JSON.stringify(metadata).includes(env.ANTIGRAVITY_CLIENT_SECRET), false);
});

test('refresh uses channel environment defaults and preserves imported custom clients', async () => {
  for (const custom of [false, true]) {
    const data = {
      refresh_token: 'test-refresh',
      ...(custom ? { client_id: 'custom-id', client_secret: 'custom-secret' } : {}),
    };
    await accessToken(
      fakeDB(),
      { id: '1', mode: 'antigravity', data },
      async (url, options) => {
        assert.equal(
          options.body.get('client_id'),
          custom ? 'custom-id' : env.ANTIGRAVITY_CLIENT_ID,
        );
        assert.equal(
          options.body.get('client_secret'),
          custom ? 'custom-secret' : env.ANTIGRAVITY_CLIENT_SECRET,
        );
        return Response.json({ access_token: 'new-token', expires_in: 3600 });
      },
      false,
      env,
    );
  }
});
