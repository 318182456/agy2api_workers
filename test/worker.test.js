import test from 'node:test';
import { dbCache as probeCache } from '../src/cache/db.js';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handleRequest } from '../src/index.js';
import { accessToken, importCredential } from '../src/credentials/index.js';
import {
  convertedStream,
  geminiToOpenai,
  openaiToGemini,
  sseEvents,
} from '../src/protocols/openai.js';
import { upstreamPayload } from '../src/upstream/index.js';
import { readJson } from '../src/core/common.js';
globalThis.crypto ||= webcrypto;
const env = {
  API_PASSWORD: 'api-secret',
  ANTIGRAVITY_STREAM2NOSTREAM: false,
  PANEL_PASSWORD: 'panel-secret',
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

test('models require dynamic discovery, Gemini query keys work and admin has no CORS', async () => {
  const response = await handleRequest(request('/v1/models'), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const native = await handleRequest(
    new Request('https://x/geminicli/v1beta/models?key=api-secret'),
    { ...env, DB: fakeDB() },
    async (url, options) => {
      assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
      assert.deepEqual(JSON.parse(options.body), { project: 'project' });
      return Response.json({ buckets: [{ modelId: 'gemini-dynamic', remainingFraction: 0.5 }] });
    },
  );
  assert.equal(native.status, 200);
  assert.equal((await native.json()).models[0].name, 'models/gemini-dynamic');
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
  const { normalizeQuota } = await import('../src/quota/index.js');
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
        { ...env, DB: quotaDB('unknown') },
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
  const { panel } = await import('../src/panel/index.js');
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
  const { listCredentials } = await import('../src/credentials/index.js');
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
  const { updateCredential } = await import('../src/credentials/index.js');
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
  const { updateCredential } = await import('../src/credentials/index.js');
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
  const { createSession, hasSession, SESSION_SECONDS } = await import('../src/auth/session.js');
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
  const { googleFetch } = await import('../src/core/common.js');
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
  const { completeOAuth } = await import('../src/credentials/oauth.js');
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

test('GeminiCLI verifies its managed project through Code Assist rather than unrelated Cloud projects', async () => {
  const { verifyProject } = await import('../src/credentials/account.js');
  const db = fakeDB();
  const row = {
    id: '1',
    mode: 'geminicli',
    data: { token: 'token', expiry: '2099-01-01T00:00:00Z' },
  };
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
    assert.equal(JSON.parse(options.body).metadata.pluginType, 'GEMINI');
    return Response.json({
      currentTier: { id: 'free-tier' },
      cloudaicompanionProject: 'managed-project',
    });
  };
  assert.equal((await verifyProject({ DB: db }, row, fetcher)).project_id, 'managed-project');
  assert.equal(row.data.project_id, 'managed-project');
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql.startsWith('UPDATE credentials') &&
        JSON.parse(call.args[0]).project_id === 'managed-project',
    ),
  );
});

test('GeminiCLI onboarding keeps free requests projectless and resumes a pending operation', async () => {
  const { verifyProject } = await import('../src/credentials/account.js');
  const db = fakeDB();
  const row = {
    id: '1',
    mode: 'geminicli',
    data: { token: 'token', expiry: '2099-01-01T00:00:00Z' },
  };
  let onboardCalls = 0;
  const fetcher = async (url, options) => {
    if (url.endsWith(':loadCodeAssist'))
      return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] });
    if (url.endsWith(':onboardUser')) {
      onboardCalls++;
      const body = JSON.parse(options.body);
      assert.equal(body.cloudaicompanionProject, undefined);
      assert.equal(body.tierId, 'free-tier');
      return Response.json({ name: 'operations/local-fixture', done: false });
    }
    assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal/operations/local-fixture');
    assert.equal(options.method, 'GET');
    return Response.json({
      done: true,
      response: { cloudaicompanionProject: { id: 'managed-new' } },
    });
  };
  await assert.rejects(verifyProject({ DB: db }, row, fetcher), (error) => error.status === 409);
  assert.equal(row.data.project_verification_operation, 'operations/local-fixture');
  assert.equal((await verifyProject({ DB: db }, row, fetcher)).project_id, 'managed-new');
  assert.equal(row.data.project_verification_operation, null);
  assert.equal(onboardCalls, 1);
});

test('GeminiCLI never claims verification success without a project or ignores account verification', async () => {
  const { verifyProject } = await import('../src/credentials/account.js');
  for (const value of [
    { currentTier: { id: 'standard-tier' } },
    { ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED' }] },
  ]) {
    const db = fakeDB();
    await assert.rejects(
      verifyProject(
        { DB: db },
        { id: '1', mode: 'geminicli', data: { token: 'token', expiry: '2099-01-01T00:00:00Z' } },
        async () => Response.json(value),
      ),
      (error) => error.status === 400,
    );
    assert.equal(
      db.calls.some((call) => call.sql.startsWith('UPDATE credentials')),
      false,
    );
  }
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

test('dynamic model failures are reported without inventing a fallback model list', async () => {
  const response = await handleRequest(
    request('/antigravity/v1/models'),
    { ...env, DB: fakeDB() },
    async () => Response.json({ error: 'permission' }, { status: 403 }),
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-model-list-source'), null);
});

test('a successful empty Google list stays empty rather than inventing available models', async () => {
  const response = await handleRequest(
    request('/antigravity/v1/models'),
    { ...env, DB: fakeDB() },
    async () => Response.json({ models: {} }),
  );
  assert.equal(response.headers.get('x-model-list-source'), 'google');
  assert.deepEqual((await response.json()).data, []);
});

test('admin inspects dynamic model sources and GeminiCLI uses quota model IDs without calling Antigravity', async () => {
  let response = await handleRequest(
    request('/admin/models?mode=antigravity', null, 'panel-secret'),
    { ...env, DB: fakeDB() },
    async () => Response.json({ models: { real: {} } }),
  );
  assert.equal((await response.json()).source, 'google');
  response = await handleRequest(
    request('/admin/models?mode=geminicli', null, 'panel-secret'),
    { ...env, DB: fakeDB() },
    async (url) => {
      assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
      return Response.json({
        buckets: [
          { modelId: 'gemini-b' },
          { modelId: 'gemini-a' },
          { modelId: 'gemini-a' },
          { tokenType: 'REQUESTS' },
        ],
      });
    },
  );
  const value = await response.json();
  assert.equal(value.source, 'quota');
  assert.deepEqual(value.ids, ['gemini-a', 'gemini-b']);
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
  const { normalizeRequest } = await import('../src/protocols/gemini.js');
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
  const { normalizeRequest } = await import('../src/protocols/gemini.js');
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
  const { cooldownSeconds } = await import('../src/upstream/reliability.js');
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
  const { normalizeRequest } = await import('../src/protocols/gemini.js');
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
  const { updateCredential } = await import('../src/credentials/index.js');
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
  const { validateSetting } = await import('../src/config/settings.js');
  assert.throws(() => validateSetting('GEMINICLI_MODELS', 'a'), /不支持/);
  assert.throws(() => validateSetting('ANTIGRAVITY_MODELS', ''), /不支持/);
  assert.equal(validateSetting('MAX_CREDENTIAL_ATTEMPTS', null), null);
  for (const value of [0, 6, 1.5, '3'])
    assert.throws(() => validateSetting('MAX_CREDENTIAL_ATTEMPTS', value), /1–5/);
  assert.throws(() => validateSetting('API_PASSWORD', 'secret'), /不支持/);
  assert.throws(() => validateSetting('GEMINICLI_MODELS', 'bad/model'), /不支持/);
});

test('Anthropic conversion preserves system, images, tool IDs/results and real thinking signatures', async () => {
  const { anthropicToGemini, geminiToAnthropic } = await import('../src/protocols/anthropic.js');
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
  const { anthropicToGemini } = await import('../src/protocols/anthropic.js');
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
  const { anthropicStream } = await import('../src/protocols/anthropic.js');
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
  const { anthropicStream } = await import('../src/protocols/anthropic.js');
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
  const { estimateTokens } = await import('../src/protocols/anthropic.js');
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
    assert.ok(
      html.includes('id="page-' + page + '"') || html.includes('id="section-' + page + '"'),
    );
    assert.match(html, /v0\.20\.1/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.equal((await handleRequest(request('/panel/settings/'), {})).status, 200);
  assert.equal((await handleRequest(request('/panel/not-a-page'), {})).status, 404);
  assert.equal((await handleRequest(request('/admin/credentials'), {})).status, 503);
});

test('OAuth configuration is isolated by environment and missing configuration fails before DB writes', async () => {
  const { startOAuth } = await import('../src/credentials/oauth.js');
  const { detectedMode } = await import('../src/credentials/index.js');
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

test('GeminiCLI quota uses official retrieveUserQuota request without generation and preserves unknown bucket values', async () => {
  const response = await handleRequest(
    request('/admin/credentials/' + quotaId + '/quota', null, 'panel-secret'),
    { ...env, DB: quotaDB('geminicli') },
    async (url, options) => {
      assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
      assert.deepEqual(JSON.parse(options.body), { project: rowData().project_id });
      return Response.json({
        buckets: [
          {
            modelId: 'gemini-model',
            remainingFraction: 0.6,
            remainingAmount: '60',
            tokenType: 'REQUESTS',
            resetTime: '2026-10-20T00:00:00Z',
          },
          { modelId: 'unknown', remainingFraction: null },
          { remainingAmount: '0', tokenType: 'TOKENS' },
        ],
      });
    },
  );
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.mode, 'geminicli');
  assert.equal(value.models[0].remaining, 0.6);
  assert.equal(value.models[0].remainingAmount, '60');
  assert.equal(value.models[1].remaining, null);
  assert.equal(value.models[2].remaining, null);
  assert.equal(value.models[2].remainingAmount, '0');
  assert.equal(value.models[2].id, '共享配额');
});

test('model names derive future versions automatically while preserving variants and collisions', async () => {
  const { modelCatalog } = await import('../src/models/names.js');
  const catalog = modelCatalog([
    ['gemini-future-agent', { displayName: 'Gemini 97.4 Pro' }],
    ['gemini-97.4-flash-preview-0821', { displayName: 'Gemini Flash' }],
    ['gemini-unknown', { displayName: '未来模型' }],
    ['claude-internal', { displayName: 'Gemini 97.4 Pro' }],
  ]);
  assert.equal(catalog.routes['gemini-97.4-pro'], 'gemini-future-agent');
  assert.ok(catalog.ids.includes('gemini-97.4-flash-preview-0821'));
  assert.ok(catalog.ids.includes('gemini-unknown'));
  assert.ok(catalog.ids.includes('claude-internal'));
  const collision = modelCatalog([
    ['gemini-internal-a', { displayName: 'Gemini 99 Pro' }],
    ['gemini-internal-b', { displayName: 'Gemini 99 Pro' }],
    ['gemini-99-flash', {}],
    ['gemini-internal-c', { displayName: 'Gemini 99 Flash' }],
  ]);
  assert.deepEqual(collision.ids, [
    'gemini-99-flash',
    'gemini-internal-a',
    'gemini-internal-b',
    'gemini-internal-c',
  ]);
});

test('automatic model name survives a cold database scope via KV and sends the real channel ID', async () => {
  const { discoverModels } = await import('../src/models/list.js');
  const { callUpstream } = await import('../src/upstream/index.js');
  const entries = new Map();
  let writes = 0;
  const CACHE = {
    async get(key) {
      return entries.has(key) ? JSON.parse(entries.get(key)) : null;
    },
    async put(key, value) {
      writes++;
      entries.set(key, value);
    },
  };
  const local = { ...env, DB: fakeDB(), CACHE };
  const found = await discoverModels(local, 'antigravity', async () =>
    Response.json({
      models: { 'gemini-new-agent': { displayName: 'Gemini 97.4 Flash' } },
    }),
  );
  assert.deepEqual(found.ids, ['gemini-97.4-flash']);
  assert.equal(found.routes['gemini-97.4-flash'], 'gemini-new-agent');
  const before = writes;
  const cold = { ...local, DB: fakeDB() };
  let sends = 0;
  const response = await callUpstream(
    cold,
    'antigravity',
    'gemini-97.4-flash',
    { contents: [{ role: 'user', parts: [{ text: 'test' }] }] },
    false,
    undefined,
    async (url, options) => {
      sends++;
      assert.ok(url.endsWith(':generateContent'));
      assert.equal(JSON.parse(options.body).model, 'gemini-new-agent');
      return Response.json(candidate());
    },
  );
  assert.equal(response.status, 200);
  assert.equal(sends, 1);
  assert.equal(writes, before, 'generation does not write KV');
  const { normalizeQuota } = await import('../src/quota/index.js');
  assert.equal(
    normalizeQuota({ models: { 'gemini-new-agent': { displayName: 'Gemini 97.4 Flash' } } })[0].id,
    'gemini-97.4-flash',
  );
});

test('official model reference extracts future codes, refreshes only for newly discovered models and keeps prior data on failure', async () => {
  const { officialModelIds, refreshOfficialModels, OFFICIAL_MODELS_URL } =
    await import('../src/models/official.js');
  assert.deepEqual(
    officialModelIds(
      '<code>gemini-97.4-flash</code><code>models/gemini-98-pro-preview</code><code>gemini-97.4-flash</code><code>made-up-agent</code>',
    ),
    ['gemini-97.4-flash', 'gemini-98-pro-preview'],
  );
  const entries = new Map();
  const local = {
    ...env,
    CACHE: {
      async get(key) {
        return entries.has(key) ? JSON.parse(entries.get(key)) : null;
      },
      async put(key, value) {
        entries.set(key, value);
      },
    },
  };
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, OFFICIAL_MODELS_URL);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, undefined);
    return new Response('<code>gemini-97.4-flash</code>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  assert.deepEqual((await refreshOfficialModels(local, ['gemini-97.4-flash'], fetcher)).ids, [
    'gemini-97.4-flash',
  ]);
  assert.deepEqual((await refreshOfficialModels(local, ['gemini-97.4-flash'], fetcher)).ids, [
    'gemini-97.4-flash',
  ]);
  assert.equal(calls, 1);
  for (const [key, encoded] of entries) {
    const entry = JSON.parse(encoded);
    entry.created -= 2 * 86400000;
    entries.set(key, JSON.stringify(entry));
  }
  assert.deepEqual(
    (
      await refreshOfficialModels(local, ['gemini-99-new'], async () => {
        throw new Error('offline');
      })
    ).ids,
    ['gemini-97.4-flash'],
  );
  assert.deepEqual(
    (
      await refreshOfficialModels(local, ['gemini-99-new'], () => {
        throw new Error('same failed ID must not retry');
      })
    ).ids,
    ['gemini-97.4-flash'],
  );
  assert.equal(
    await refreshOfficialModels({}, ['gemini-99-new'], () => {
      throw new Error('must not fetch without KV');
    }),
    null,
  );
});

test('GeminiCLI project requirements follow Google tier metadata rather than non-free ID guesses', async () => {
  const { verifyProject } = await import('../src/credentials/account.js');
  for (const requirement of [false, undefined]) {
    const db = fakeDB();
    const row = {
      id: '1',
      mode: 'geminicli',
      data: { token: 'token', expiry: '2099-01-01T00:00:00Z' },
    };
    let onboards = 0;
    const result = await verifyProject({ DB: db }, row, async (url, options) => {
      if (url.endsWith(':loadCodeAssist'))
        return Response.json({
          allowedTiers: [
            {
              id: 'future-managed-tier',
              isDefault: true,
              userDefinedCloudaicompanionProject: requirement,
            },
          ],
        });
      assert.ok(url.endsWith(':onboardUser'));
      onboards++;
      const body = JSON.parse(options.body);
      assert.equal(body.tierId, 'future-managed-tier');
      assert.equal(Object.hasOwn(body, 'cloudaicompanionProject'), false);
      assert.equal(Object.hasOwn(body.metadata, 'duetProject'), false);
      return Response.json({
        done: true,
        response: { cloudaicompanionProject: { id: 'google-managed-project' } },
      });
    });
    assert.equal(result.project_id, 'google-managed-project');
    assert.equal(row.data.project_id, 'google-managed-project');
    assert.equal(onboards, 1);
  }
  const requiring = {
    allowedTiers: [
      { id: 'explicit-custom-tier', isDefault: true, userDefinedCloudaicompanionProject: true },
    ],
  };
  let onboards = 0;
  const fetcher = async (url, options) => {
    if (url.endsWith(':loadCodeAssist')) return Response.json(requiring);
    onboards++;
    assert.equal(JSON.parse(options.body).cloudaicompanionProject, 'my-existing-project');
    return Response.json({
      done: true,
      response: { cloudaicompanionProject: { id: 'my-existing-project' } },
    });
  };
  await assert.rejects(
    verifyProject(
      { DB: fakeDB() },
      { id: '1', mode: 'geminicli', data: rowDataWithoutProject() },
      fetcher,
    ),
    (error) => error.status === 400 && error.message.includes('explicit-custom-tier'),
  );
  assert.equal(onboards, 0);
  assert.equal(
    (
      await verifyProject(
        { DB: fakeDB() },
        {
          id: '1',
          mode: 'geminicli',
          data: { ...rowDataWithoutProject(), project_id: 'my-existing-project' },
        },
        fetcher,
      )
    ).project_id,
    'my-existing-project',
  );
  assert.equal(onboards, 1);
  function rowDataWithoutProject() {
    return { token: 'token', expiry: '2099-01-01T00:00:00Z' };
  }
});

test('GeminiCLI validation-required response blocks onboarding even if a default tier is also returned', async () => {
  const { verifyProject } = await import('../src/credentials/account.js');
  await assert.rejects(
    verifyProject(
      { DB: fakeDB() },
      { id: '1', mode: 'geminicli', data: rowData() },
      async (url) => {
        assert.ok(url.endsWith(':loadCodeAssist'));
        return Response.json({
          allowedTiers: [{ id: 'free-tier', isDefault: true }],
          ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED' }],
        });
      },
    ),
    /账号验证/,
  );
});

test('admin project verification accepts an explicit project only after Google confirms it and rejects invalid input', async () => {
  const data = { token: 'token', expiry: '2099-01-01T00:00:00Z' };
  const db = fakeDB(data);
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.ok(url.endsWith(':loadCodeAssist'));
    const body = JSON.parse(options.body);
    assert.equal(body.cloudaicompanionProject, 'my-cloud-project');
    assert.equal(body.metadata.duetProject, 'my-cloud-project');
    return Response.json({
      currentTier: { id: 'standard-tier', userDefinedCloudaicompanionProject: true },
      cloudaicompanionProject: 'my-cloud-project',
    });
  };
  const path = '/admin/credentials/11111111-1111-4111-8111-111111111111/verify';
  const response = await handleRequest(
    request(path, { project_id: 'my-cloud-project' }, 'panel-secret'),
    { ...env, DB: db },
    fetcher,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).project_id, 'my-cloud-project');
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql.startsWith('UPDATE credentials') &&
        JSON.parse(call.args[0]).project_id === 'my-cloud-project',
    ),
  );
  for (const project_id of ['123456789', 'Project Name', '', '../../operations/bad']) {
    assert.equal(
      (
        await handleRequest(
          request(path, { project_id }, 'panel-secret'),
          { ...env, DB: fakeDB(data) },
          fetcher,
        )
      ).status,
      400,
    );
  }
  assert.equal(calls, 1);
  const rejected = fakeDB(data);
  const failed = await handleRequest(
    request(path, { project_id: 'my-cloud-project' }, 'panel-secret'),
    { ...env, DB: rejected },
    async () => Response.json({}, { status: 403 }),
  );
  assert.equal(failed.status, 403);
  assert.equal(
    rejected.calls.some((call) => call.sql.startsWith('UPDATE credentials')),
    false,
  );
});

test('project-required response has a structured reason for the inline setup form', async () => {
  const path = '/admin/credentials/11111111-1111-4111-8111-111111111111/verify';
  const response = await handleRequest(
    request(path, {}, 'panel-secret'),
    { ...env, DB: fakeDB({ token: 'token', expiry: '2099-01-01T00:00:00Z' }) },
    async () =>
      Response.json({
        allowedTiers: [
          { id: 'standard-tier', isDefault: true, userDefinedCloudaicompanionProject: true },
        ],
      }),
  );
  assert.equal(response.status, 400);
  const error = (await response.json()).error;
  assert.equal(error.reason, 'PROJECT_REQUIRED');
  assert.equal(error.stage, 'project_verify');
});

test('generation header timeout aborts stalled fetches but never times out an already received body', async (t) => {
  const { fetchGeneration, clientAborted } = await import('../src/upstream/timeouts.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = fetchGeneration(
    async (url, options) =>
      new Promise((resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        }),
      ),
    'https://example.test',
    {},
    45,
  );
  const rejected = assert.rejects(
    hanging,
    (error) => error.status === 504 && error.errorCode === 'UPSTREAM_TIMEOUT',
  );
  t.mock.timers.tick(45000);
  await rejected;
  let signal;
  const response = await fetchGeneration(
    async (url, options) => {
      signal = options.signal;
      return new Response('still valid');
    },
    'https://example.test',
    {},
    45,
  );
  t.mock.timers.tick(45000);
  assert.equal(signal.aborted, false);
  assert.equal(await response.text(), 'still valid');
  const deadline = new AbortController();
  deadline.abort(new DOMException('deadline', 'TimeoutError'));
  assert.equal(clientAborted(deadline.signal), false);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(clientAborted(cancelled.signal), true);
});

test('nonstream total timeout aborts a stalled response body and records 504 failure rather than cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = fakeDB();
  db.batch = async () => [{ meta: { changes: 1 } }];
  let ready;
  const received = new Promise((resolve) => {
    ready = resolve;
  });
  const result = handleRequest(
    request('/antigravity/v1/chat/completions', {
      model: 'gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'fixture' }],
    }),
    { ...env, DB: db },
    async (url, options) => {
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => controller.error(options.signal.reason), {
            once: true,
          });
        },
      });
      ready();
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
  );
  await received;
  await new Promise(setImmediate);
  t.mock.timers.tick(100000);
  const response = await result;
  assert.equal(response.status, 504);
  const failure = (await response.json()).error;
  assert.equal(failure.reason, 'UPSTREAM_TIMEOUT');
  assert.equal(failure.stage, 'generation_timeout');
  const saved = db.calls.find((call) => call.sql.includes('INSERT OR IGNORE INTO request_usage'));
  assert.equal(saved.args[5], 504);
  assert.equal(saved.args[6], 'failed');
});

test('generation timeout settings enforce bounded seconds and preserve defaults', async () => {
  const { readSettings, validateSetting } = await import('../src/config/settings.js');
  const { defaults } = await readSettings({});
  assert.equal(defaults.UPSTREAM_TIMEOUT_SECONDS, 45);
  assert.equal(defaults.REQUEST_TIMEOUT_SECONDS, 100);
  assert.equal(defaults.ANTIGRAVITY_STREAM2NOSTREAM, true);
  assert.equal(validateSetting('UPSTREAM_TIMEOUT_SECONDS', 30), 30);
  assert.equal(validateSetting('REQUEST_TIMEOUT_SECONDS', 100), 100);
  for (const [key, value] of [
    ['UPSTREAM_TIMEOUT_SECONDS', 0],
    ['UPSTREAM_TIMEOUT_SECONDS', 91],
    ['REQUEST_TIMEOUT_SECONDS', 111],
    ['REQUEST_TIMEOUT_SECONDS', 10.5],
  ])
    assert.throws(() => validateSetting(key, value), { status: 400 });
});

test('healthy streaming responses outlive the initial generation deadline without being aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = fakeDB();
  db.batch = async () => [{ meta: { changes: 1 } }];
  let controller, signal;
  const response = await handleRequest(
    request('/antigravity/v1/chat/completions', {
      model: 'gemini-3.1-flash-lite',
      stream: true,
      messages: [{ role: 'user', content: 'fixture' }],
    }),
    { ...env, DB: db },
    async (url, options) => {
      signal = options.signal;
      return new Response(
        new ReadableStream({
          start(value) {
            controller = value;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  assert.equal(response.status, 200);
  t.mock.timers.tick(200000);
  assert.equal(signal.aborted, false);
  controller.enqueue(
    new TextEncoder().encode('data: ' + JSON.stringify(candidate('long stream works')) + '\n\n'),
  );
  controller.close();
  const text = await response.text();
  assert.ok(text.includes('long stream works'));
  assert.ok(text.includes('[DONE]'));
});

test('stream collection preserves a completed candidate when later metadata has an empty finish reason', async () => {
  const { collectGoogleStream } = await import('../src/upstream/stream-collect.js');
  const frames = [
    candidate('complete'),
    { candidates: [{ index: 0, finishReason: null }], usageMetadata: { totalTokenCount: 9 } },
  ];
  const result = await collectGoogleStream(
    stream(frames.map((value) => 'data: ' + JSON.stringify(value) + '\n\n').join('')),
  );
  assert.equal(result.candidates[0].finishReason, 'STOP');
  assert.equal(result.candidates[0].content.parts[0].text, 'complete');
  assert.equal(result.usageMetadata.totalTokenCount, 9);
});

test('stream collection accepts complete JSON objects, JSON batches and mislabeled SSE without losing tool signatures', async () => {
  const { collectGoogleResponse } = await import('../src/upstream/stream-collect.js');
  const value = {
    response: {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'echo', args: { text: 'fixture' } },
                thoughtSignature: 'fixture-signature',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    },
  };
  for (const text of [
    JSON.stringify(value),
    JSON.stringify([value]),
    'data: ' + JSON.stringify(value) + '\n\n',
  ]) {
    const result = await collectGoogleResponse(
      new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8' } }),
    );
    assert.equal(result.candidates[0].content.parts[0].functionCall.name, 'echo');
    assert.equal(result.candidates[0].content.parts[0].thoughtSignature, 'fixture-signature');
    assert.equal(geminiToOpenai(result, 'm').choices[0].finish_reason, 'tool_calls');
  }
});

test('collection failures expose stable distinct reasons and never accept truncated or HTML responses as success', async () => {
  const { collectGoogleResponse } = await import('../src/upstream/stream-collect.js');
  for (const [body, type, code, status] of [
    ['<html>private body must not echo</html>', 'text/html', 'UPSTREAM_NOT_SSE', 502],
    ['broken JSON', 'application/json', 'UPSTREAM_STREAM_JSON_INVALID', 502],
    [
      'data: ' +
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }) +
        '\n\n',
      'text/event-stream',
      'UPSTREAM_STREAM_INCOMPLETE',
      502,
    ],
    [
      'data: ' +
        JSON.stringify({ error: { code: 400, message: 'fixture unsupported parameter' } }) +
        '\n\n',
      'text/event-stream',
      'UPSTREAM_STREAM_ERROR',
      400,
    ],
    ['data: {}\n\n', 'text/event-stream', 'UPSTREAM_STREAM_EMPTY', 502],
  ])
    await assert.rejects(
      collectGoogleResponse(new Response(body, { headers: { 'content-type': type } })),
      (error) =>
        error.status === status &&
        error.errorCode === code &&
        error.operation === 'stream_collection' &&
        !error.message.includes('private body must not echo'),
    );
  await assert.rejects(
    collectGoogleResponse(Response.json(candidate('exceeds tiny limit')), 4),
    (error) => error.errorCode === 'UPSTREAM_STREAM_LIMIT',
  );
});

test('malformed OpenAI messages and tools fail as 400 before contacting upstream', async () => {
  const base = { model: 'gemini-2.5-flash-lite', messages: [{ role: 'user', content: 'hello' }] };
  const bad = [
    { messages: [null] },
    { messages: [{ role: 'user', content: [null] }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 123 } }] }] },
    { messages: [{ role: 'assistant', tool_calls: {} }] },
    { messages: [{ role: 'assistant', tool_calls: [null] }] },
    {
      messages: [
        { role: 'assistant', tool_calls: [{ function: { name: 'test', arguments: '[]' } }] },
      ],
    },
    { tools: {} },
    { tools: [null] },
    { tools: [{ type: 'function', function: { name: 123 } }] },
    ...[42, false, 'constructor', [], { function: { name: 'test' } }].map((tool_choice) => ({
      tool_choice,
    })),
  ];
  let fetched = 0;
  for (const input of bad) {
    const response = await handleRequest(
      request('/v1/chat/completions', { ...base, ...input }),
      { ...env, DB: fakeDB() },
      async () => {
        fetched++;
        return Response.json(candidate());
      },
    );
    assert.equal(response.status, 400, JSON.stringify(input));
  }
  assert.equal(fetched, 0);
});

test('Flash-Lite thinking budgets preserve disable/dynamic and clamp the supported range', async () => {
  const { normalizeRequest } = await import('../src/protocols/gemini.js');
  for (const [budget, expected] of [
    [0, 0],
    [-1, -1],
    [1, 512],
    [511, 512],
    [512, 512],
    [99999, 24576],
  ]) {
    const result = normalizeRequest(
      { generationConfig: { thinkingConfig: { thinkingBudget: budget } } },
      'gemini-2.5-flash-lite',
      'geminicli',
    );
    assert.equal(result.request.generationConfig.thinkingConfig.thinkingBudget, expected);
  }
  const converted = openaiToGemini({
    model: 'gemini-2.5-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'low',
  });
  assert.equal(
    normalizeRequest(converted, 'gemini-2.5-flash-lite', 'geminicli').request.generationConfig
      .thinkingConfig.thinkingBudget,
    1024,
  );
});

test('split SSE usage agrees with telemetry and does not reset prompt tokens', async () => {
  let recorded;
  const frames = [
    {
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 11 },
    },
    { usageMetadata: { candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 21 } },
  ];
  const response = convertedStream(
    stream(frames.map((value) => 'data: ' + JSON.stringify(value) + '\n\n').join('')),
    'm',
    true,
    true,
    () => {},
    () => {},
    async () => {},
    async (value) => {
      recorded = value;
    },
  );
  const events = [];
  for await (const event of sseEvents(response))
    if (event !== '[DONE]') events.push(JSON.parse(event));
  assert.deepEqual(events.at(-1).usage, {
    prompt_tokens: 11,
    completion_tokens: 10,
    completion_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 21,
  });
  assert.equal(recorded.promptTokenCount, 11);
  assert.equal(recorded.totalTokenCount, 21);
});

test('partial CLI model lists do not exclude explicitly requested Gemini models', async () => {
  const { dbCache } = await import('../src/cache/db.js');
  const { unifiedRouting } = await import('../src/upstream/unified.js');
  const { knownModelId, publicModelId } = await import('../src/models/names.js');
  const DB = fakeDB();
  const scope = dbCache(DB);
  scope.cliModels = { value: { ids: ['gemini-2.5-pro'], queriedAt: new Date().toISOString() } };
  scope.models = { value: { ids: ['gemini-2.5-flash-lite'], queriedAt: new Date().toISOString() } };
  assert.deepEqual(unifiedRouting({ DB }, 'gemini-2.5-flash-lite').modes, [
    'geminicli',
    'antigravity',
  ]);
  assert.deepEqual(unifiedRouting({ DB }, 'claude-sonnet-4-6').modes, ['antigravity']);
  scope.models = {
    value: {
      ids: ['gemini-2.5-flash'],
      routes: { 'gemini-2.5-flash': 'gemini-raw' },
      queriedAt: 'invalid',
    },
  };
  assert.equal(knownModelId({ DB }, 'antigravity', 'gemini-2.5-flash'), null);
  assert.equal(publicModelId({ DB }, 'antigravity', 'gemini-raw'), 'gemini-raw');
});

test('cancelling a request aborts OAuth refresh without persisting tokens', async () => {
  const db = fakeDB();
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const result = accessToken(
    db,
    { id: '1', mode: 'geminicli', data: { refresh_token: 'local-refresh' } },
    async (_url, options) => {
      started();
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        }),
      );
    },
    false,
    {},
    controller.signal,
  );
  await ready;
  controller.abort(new DOMException('deadline', 'TimeoutError'));
  await assert.rejects(
    result,
    (error) => error.status === 504 && error.operation === 'oauth_refresh',
  );
  assert.equal(db.calls.length, 0);
});

test('shared quota families count once per account and keep unknown windows unknown', async () => {
  const { groupQuotaModels } = await import('../src/quota/groups.js');
  const groups = groupQuotaModels([
    { id: 'gemini-2.5-flash', remaining: 0.6, resetTime: '2026-10-20T08:00:00Z' },
    { id: 'gemini-2.5-pro', remaining: 0.6, resetTime: '2026-10-20T08:00:00Z' },
    { id: 'claude-sonnet-4-6', remaining: 0.2, resetTime: '2026-10-22T08:00:00Z' },
    { id: 'claude-opus-4-6', remaining: 0, resetTime: '2026-10-23T08:00:00Z' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].remaining, 0.6);
  assert.equal(groups[0].members.length, 2);
  assert.equal(groups[0].inconsistent, false);
  assert.equal(groups[1].remaining, 0);
  assert.equal(groups[1].inconsistent, true);
  assert.equal(groups[1].resetTime, '2026-10-23T08:00:00Z');
  assert.equal(groups[1].weekly, undefined);
  assert.equal(
    groupQuotaModels(
      [
        { id: 'gemini-x', tokenType: 'INPUT' },
        { id: 'gemini-x', tokenType: 'OUTPUT' },
      ],
      'geminicli',
    ).length,
    2,
  );
});

test('incomplete streams report safe shape diagnostics and retain reported token counts', async () => {
  const { collectGoogleResponse } = await import('../src/upstream/stream-collect.js');
  const privateText = 'PRIVATE_RESPONSE_TEXT';
  const privateArgs = 'PRIVATE_TOOL_ARGUMENT';
  const frames = [
    {
      response: {
        candidates: [
          {
            content: {
              parts: [
                { text: privateText },
                { text: 'private-thought', thought: true },
                {
                  functionCall: { name: 'private-function', args: { secret: privateArgs } },
                  thoughtSignature: 'private-signature',
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, secret: privateArgs },
      },
    },
    { response: { usageMetadata: { totalTokenCount: 16 } } },
  ];
  for (const ending of ['EOF', 'DONE', 'JSON']) {
    const response = new Response(
      ending === 'JSON'
        ? JSON.stringify(frames)
        : frames.map((value) => 'data: ' + JSON.stringify(value) + '\n\n').join('') +
            (ending === 'DONE' ? 'data: [DONE]\n\n' : ''),
      { headers: { 'content-type': ending === 'JSON' ? 'application/json' : 'text/event-stream' } },
    );
    await assert.rejects(collectGoogleResponse(response), (error) => {
      assert.equal(error.errorCode, 'UPSTREAM_STREAM_INCOMPLETE');
      assert.match(error.diagnosticMessage, /帧=2，候选=1，已结束=0/);
      assert.match(error.diagnosticMessage, /工具调用=1，用量=已报告，末帧=用量/);
      assert.ok(error.diagnosticMessage.includes('结束=' + ending));
      assert.ok(!error.message.includes(privateText));
      assert.ok(!error.message.includes(privateArgs));
      assert.ok(!JSON.stringify(error).includes('private-signature'));
      assert.deepEqual(error.usageMetadata, {
        promptTokenCount: 12,
        candidatesTokenCount: 4,
        totalTokenCount: 16,
      });
      return true;
    });
  }
});

test('OpenAI Gemini tool history preserves real signatures and supplies the documented fallback only when missing', async () => {
  const history = {
    model: 'gemini-3.1-flash-lite',
    messages: [
      { role: 'user', content: 'search for earlier observations' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_unsigned',
            type: 'function',
            function: { name: 'search_observations', arguments: '{"query":"fixture"}' },
          },
          {
            id: 'call_signed',
            type: 'function',
            function: { name: 'second_search', arguments: '{}' },
            extra_content: { google: { thought_signature: 'original-real-signature' } },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_unsigned', content: '{"result":[]}' },
      { role: 'tool', tool_call_id: 'call_signed', content: '{"result":[]}' },
    ],
  };
  for (const model of [
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-4-future',
    'gemini-2.5-flash',
    'claude-sonnet-4-6',
    'custom-model',
  ]) {
    const converted = openaiToGemini({ ...history, model });
    assert.equal(
      converted.contents[1].parts[0].thoughtSignature,
      /^gemini-[34]/.test(model) ? 'skip_thought_signature_validator' : undefined,
    );
    assert.equal(converted.contents[1].parts[1].thoughtSignature, 'original-real-signature');
    assert.equal(converted.contents[1].parts[0].functionCall.id, 'call_unsigned');
    assert.equal(converted.contents[2].parts[0].functionResponse.id, 'call_unsigned');
    assert.deepEqual(converted.contents[1].parts[0].functionCall.args, { query: 'fixture' });
  }
  let calls = 0;
  for (const mode of ['geminicli', 'antigravity'])
    for (const streaming of [false, true]) {
      const db = fakeDB();
      const prepare = db.prepare;
      db.prepare = (sql) => {
        const stmt = prepare(sql),
          first = stmt.first;
        stmt.first = async () => ({ ...(await first()), mode });
        return stmt;
      };
      const response = await handleRequest(
        request('/' + mode + '/v1/chat/completions', { ...history, stream: streaming }),
        { ...env, DB: db },
        async (_url, options) => {
          calls++;
          const payload = JSON.parse(options.body);
          assert.equal(
            payload.request.contents[1].parts[0].thoughtSignature,
            'skip_thought_signature_validator',
          );
          assert.equal(
            payload.request.contents[1].parts[1].thoughtSignature,
            'original-real-signature',
          );
          return streaming
            ? new Response('data: ' + JSON.stringify(candidate('tool loop completed')) + '\n\n', {
                headers: { 'content-type': 'text/event-stream' },
              })
            : Response.json(candidate('tool loop completed'));
        },
      );
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes('tool loop completed'));
    }
  assert.equal(calls, 4);
  const signed = geminiToOpenai(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { id: 'call_roundtrip', name: 'search_observations', args: {} },
                thoughtSignature: 'server-signature',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    },
    history.model,
  ).choices[0].message;
  const roundtrip = openaiToGemini({
    ...history,
    messages: [
      history.messages[0],
      signed,
      { role: 'tool', tool_call_id: 'call_roundtrip', content: '{}' },
    ],
  });
  assert.equal(roundtrip.contents[1].parts[0].thoughtSignature, 'server-signature');
});

test('quota cooldown reads structured weekly resets without consuming the original error response', async () => {
  const { cooldownSeconds, quotaCooldown } = await import('../src/upstream/reliability.js');
  const now = Date.parse('2026-10-20T00:00:00Z');
  const body = {
    error: {
      code: 429,
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          metadata: { quotaResetTimeStamp: '2026-10-26T00:00:00Z', quotaResetDelay: '5h30m0.2s' },
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '60.5s' },
      ],
    },
  };
  const response = Response.json(body, { status: 429, headers: { 'retry-after': '90' } });
  assert.equal(await quotaCooldown(response, undefined, now), 6 * 86400);
  assert.deepEqual(await response.json(), body);
  const quota = (value) => ({
    error: {
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          metadata: { quotaResetDelay: value },
        },
      ],
    },
  });
  assert.equal(cooldownSeconds(new Response('', { status: 429 }), now, quota('5h30m0.2s')), 19801);
  assert.equal(cooldownSeconds(new Response('', { status: 429 }), now, quota('999d')), 7 * 86400);
  assert.equal(cooldownSeconds(new Response('', { status: 429 }), now, quota('garbage 10s')), 60);
  assert.equal(
    await quotaCooldown(
      new Response('not-json', { status: 429, headers: { 'content-type': 'application/json' } }),
    ),
    60,
  );
  assert.equal(
    await quotaCooldown(Response.json({ data: 'x'.repeat(70000) }, { status: 429 })),
    60,
  );
});

test('quota error inspection is bounded when a JSON response body stalls', async (t) => {
  const { quotaCooldown } = await import('../src/upstream/reliability.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let original;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        original = controller;
      },
    }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );
  const result = quotaCooldown(response);
  t.mock.timers.tick(1000);
  assert.equal(await result, 60);
  original.close();
  assert.equal(await response.text(), '');
});

test('OpenAI usage reports cached and reasoning token details without subtracting them twice', async () => {
  const { usage } = await import('../src/protocols/openai.js');
  assert.deepEqual(
    usage({
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 10,
        totalTokenCount: 130,
      },
    }),
    {
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  );
});

test('single-frame text EOF compatibility is explicit and never accepts tools, broken streams or fabricated completion', async () => {
  const { collectGoogleResponse } = await import('../src/upstream/stream-collect.js');
  const value = { response: { candidates: [{ content: { parts: [{ text: 'existing text' }] } }] } };
  const event = (raw) => 'data: ' + JSON.stringify(raw) + '\n\n';
  const response = (text) =>
    new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  const read = (r) => collectGoogleResponse(r, undefined, { allowUnconfirmedText: true });
  await assert.rejects(collectGoogleResponse(response(event(value))), {
    errorCode: 'UPSTREAM_STREAM_INCOMPLETE',
  });
  const result = await read(response(event(value)));
  assert.equal(result.candidates[0].content.parts[0].text, 'existing text');
  assert.equal(result.candidates[0].finishReason, undefined);
  assert.equal(result.usageMetadata, undefined);
  assert.equal(result.completion_status, 'unconfirmed');
  assert.equal(result.warnings[0].code, 'UPSTREAM_FINISH_UNCONFIRMED');
  assert.match(result.warnings[0].message, /结束未确认/);
  for (const mutate of [
    (v) => v.response.candidates[0].content.parts.push({ functionCall: { name: 'f', args: {} } }),
    (v) =>
      v.response.candidates[0].content.parts.push({
        inlineData: { mimeType: 'image/png', data: 'AA==' },
      }),
    (v) => v.response.candidates.push(structuredClone(v.response.candidates[0])),
    (v) => {
      v.response.candidates[0].content.parts = [{ text: 'thinking', thought: true }];
    },
    (v) => {
      v.response.candidates[0].content.parts = [{ text: '' }];
    },
    (v) => {
      v.response.finish_reason = 'stop';
    },
  ]) {
    const altered = structuredClone(value);
    mutate(altered);
    await assert.rejects(read(response(event(altered))), {
      errorCode: 'UPSTREAM_STREAM_INCOMPLETE',
    });
  }
  for (const text of [
    event(value) + event({ response: { usageMetadata: { totalTokenCount: 7 } } }),
    event(value) + 'data: [DONE]\n\n',
  ])
    await assert.rejects(read(response(text)), { errorCode: 'UPSTREAM_STREAM_INCOMPLETE' });
  await assert.rejects(read(Response.json(value)), { errorCode: 'UPSTREAM_STREAM_INCOMPLETE' });
  let step = 0;
  const broken = new ReadableStream({
    pull(controller) {
      if (step++ === 0) controller.enqueue(new TextEncoder().encode(event(value)));
      else controller.error(new Error('connection lost'));
    },
  });
  await assert.rejects(read(response(broken)), { errorCode: 'UPSTREAM_STREAM_INTERRUPTED' });
  const completed = structuredClone(value);
  completed.response.candidates[0].finishReason = 'STOP';
  assert.equal((await read(response(event(completed)))).completion_status, undefined);
});

test('active runtime probe uses a fixed endpoint without credentials or D1, caches and coalesces concurrent requests', async () => {
  const { runtimeLocation } = await import('../src/core/runtime-location.js');
  const env = {
    DB: {
      prepare() {
        throw new Error('D1 must not be used');
      },
    },
  };
  const request = new Request('https://test/admin/runtime-location', {
    headers: {
      authorization: 'Bearer private-panel-password',
      'x-api-key': 'private-key',
      cookie: 'private-cookie',
    },
  });
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, 'https://www.cloudflare.com/cdn-cgi/trace');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers['x-api-key'], undefined);
    await new Promise((resolve) => setImmediate(resolve));
    return new Response('ip=PRIVATE_IP\nua=PRIVATE_UA\nloc=JP\ncolo=NRT\n');
  };
  const values = await Promise.all(
    Array.from({ length: 10 }, () => runtimeLocation(request, env, fetcher)),
  );
  assert.equal(calls, 1);
  const value = await runtimeLocation(request, env, fetcher);
  assert.equal(value.cached, true);
  assert.equal(value.country, 'JP');
  assert.equal(value.probe_colo, 'NRT');
  assert.equal(value.execution_colo, null);
  assert.equal(value.cache_seconds, 60);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(values).includes('PRIVATE'));
  const placed = new Request('https://test/admin/runtime-location', {
    headers: { 'cf-placement': 'remote-IAD' },
  });
  const separate = await runtimeLocation(placed, env, fetcher);
  assert.equal(separate.execution_colo, 'IAD');
  assert.equal(separate.probe_colo, 'NRT'); // Never substitute probe colo for execution.
  assert.equal(separate.country, 'JP');
  assert.equal(calls, 2);
});

test('active runtime probe rejects unavailable, malformed and oversized trace without caching failure', async () => {
  const { runtimeLocation } = await import('../src/core/runtime-location.js');
  const request = new Request('https://test/admin/runtime-location');
  for (const fetcher of [
    async () => new Response('loc=JP\ncolo=NRT', { status: 503 }),
    async () => new Response('loc=JP\ncolo=bad private output'),
    async () => new Response('loc=JP\ncolo=NRT\n' + 'x'.repeat(8192)),
    async () => {
      throw new Error('PRIVATE_NETWORK_ERROR');
    },
  ]) {
    const env = {},
      messages = [];
    for (let n = 0; n < 2; n++)
      await assert.rejects(runtimeLocation(request, env, fetcher), (error) => {
        messages.push(error.message);
        return error.status === 503 && !error.message.includes('PRIVATE');
      });
    assert.equal(messages.length, 2);
    assert.equal(probeCache(env).runtimeLocations.size, 0);
  }
});

test('runtime location endpoint requires panel authentication and works without D1', async () => {
  const { adminRoute } = await import('../src/routes/admin.js');
  let calls = 0;
  const env = { PANEL_PASSWORD: 'local-panel-fixture' };
  const fetcher = async () => {
    calls++;
    return new Response('loc=US\ncolo=IAD');
  };
  const path = 'https://test/admin/runtime-location';
  await assert.rejects(adminRoute(new Request(path), env, fetcher), { status: 401 });
  assert.equal(calls, 0);
  const response = await adminRoute(
    new Request(path, { headers: { authorization: 'Bearer local-panel-fixture' } }),
    env,
    fetcher,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).country, 'US');
  assert.equal(calls, 1);
  await assert.rejects(
    adminRoute(
      new Request(path, {
        method: 'POST',
        headers: { authorization: 'Bearer local-panel-fixture' },
      }),
      env,
      fetcher,
    ),
    { status: 405 },
  );
  assert.equal(calls, 1);
});
