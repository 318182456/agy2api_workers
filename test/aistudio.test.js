import { summarizeRows } from '../src/telemetry/rollup.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, Log, LogLevel } from 'miniflare';
import worker, { handleRequest } from '../src/index.js';
import {
  renderOrigin,
  aistudioConfig,
  publicAistudio,
  saveAistudio,
  probeAistudio,
} from '../src/aistudio/config.js';
import { createSession } from '../src/auth/session.js';
import { effectiveEnv } from '../src/config/settings.js';
let mf, env;
before(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2025-09-01',
    d1Databases: { DB: 'aistudio-test' },
    log: new Log(LogLevel.NONE),
  });
  const DB = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter((x) => x.endsWith('.sql')).sort())
    await DB.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
  env = {
    DB,
    PANEL_PASSWORD: 'test-panel-password',
    API_PASSWORD: 'test-client-key',
    USAGE_STORAGE_MODE: 'detailed',
  };
});
after(async () => {
  await mf?.dispose();
});
const base = 'https://panel.example.test';
const provider = 'test-provider-key';
const configure = async (extra = {}) =>
  saveAistudio(env, {
    revision: (await publicAistudio(env)).revision,
    url: 'https://test-instance.onrender.com',
    api_key: provider,
    enabled: true,
    keepalive: true,
    routing: 'explicit',
    ...extra,
  });
const request = (path, method = 'GET', body, headers = {}) =>
  new Request(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

test('Render origins reject SSRF, credentials, redirect targets and non-standard ports', () => {
  assert.equal(
    renderOrigin('https://test-instance.onrender.com:2048/v1'),
    'https://test-instance.onrender.com',
  );
  for (const value of [
    'http://test.onrender.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://test.onrender.com.evil.test',
    'https://x@y.onrender.com',
    'https://test.onrender.com/a',
    'https://test.onrender.com?token=secret',
    'https://test.onrender.com:8443',
  ])
    assert.throws(() => renderOrigin(value));
});

test('admin contracts require authentication, browser origin, JSON and session-bound CSRF', async () => {
  const nope = () => {
    throw new Error('external fetch should not run');
  };
  let response = await handleRequest(request('/admin/aistudio'), env, nope);
  assert.equal(response.status, 401);
  const cookie = (await createSession(request('/panel/aistudio'), env.PANEL_PASSWORD)).split(
    ';',
  )[0];
  const headers = { cookie, origin: base };
  response = await handleRequest(request('/admin/aistudio', 'GET', undefined, headers), env, nope);
  assert.equal(response.status, 200);
  const read = await response.json();
  assert.ok(read.csrf_token);
  const body = {
    revision: read.revision,
    url: 'https://test-instance.onrender.com',
    api_key: provider,
    enabled: true,
    keepalive: true,
    routing: 'explicit',
  };
  for (const h of [
    { ...headers, origin: 'https://evil.test' },
    { ...headers, 'sec-fetch-site': 'cross-site' },
    headers,
  ]) {
    response = await handleRequest(request('/admin/aistudio', 'PATCH', body, h), env, nope);
    assert.equal(response.status, 403);
  }
  response = await handleRequest(
    request('/admin/aistudio', 'PATCH', body, { ...headers, 'x-csrf-token': read.csrf_token }),
    env,
    nope,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).has_key, true);
  response = await handleRequest(
    request('/admin/aistudio', 'DELETE', undefined, headers),
    env,
    nope,
  );
  assert.equal(response.status, 405);
});

test('config retains blank provider key, hides secrets and rejects stale revision without changing routing', async () => {
  const previous = await publicAistudio(env);
  const result = await configure({ api_key: '', routing: 'default' });
  assert.equal((await aistudioConfig(env, true)).api_key, provider);
  assert.ok(!JSON.stringify(result).includes(provider));
  assert.equal((await effectiveEnv(env)).AISTUDIO_ROUTING, 'default');
  await assert.rejects(
    () =>
      saveAistudio(env, {
        ...previous,
        url: 'https://test-instance.onrender.com',
        enabled: false,
        keepalive: false,
        routing: 'explicit',
      }),
    /配置已被修改/,
  );
  assert.equal((await effectiveEnv(env)).AISTUDIO_ENABLED, true);
  await configure();
});

test('keepalive only GETs root without provider key; model test authenticates and stores no credentials', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return url.endsWith('/v1/models')
      ? Response.json({ data: [{ id: 'model-one' }] })
      : new Response('<html>ok</html>');
  };
  const result = await probeAistudio(env, fetcher);
  assert.equal(result.ok, true);
  assert.equal(requests[0].url, 'https://test-instance.onrender.com/');
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.equal(requests[0].options.redirect, 'manual');
  const models = await probeAistudio(env, fetcher, true);
  assert.equal(models.model_count, 1);
  assert.equal(requests[1].options.headers.authorization, 'Bearer ' + provider);
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?')
    .bind('aistudio_probe')
    .first();
  assert.ok(!row.value.includes(provider));
  assert.ok(!row.value.includes('model-one'));
});

test('proxy authenticates local key, preserves tools and counts JSON usage by API key', async () => {
  await configure();
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return Response.json(
      {
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
      { headers: { 'set-cookie': 'must-not-leak=1' } },
    );
  };
  const body = {
    model: 'model-one',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'any', parameters: true } }],
  };
  let response = await handleRequest(
    request('/aistudio/v1/chat/completions', 'POST', body, { authorization: 'Bearer invalid' }),
    env,
    fetcher,
  );
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
  response = await handleRequest(
    request('/aistudio/v1/chat/completions', 'POST', body, {
      authorization: 'Bearer test-client-key',
      cookie: 'must-not-forward=1',
    }),
    env,
    fetcher,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await response.json()).choices[0].message.content, 'OK');
  assert.equal(calls[0].options.headers.authorization, 'Bearer ' + provider);
  assert.equal(calls[0].options.headers.cookie, undefined);
  assert.equal(JSON.parse(calls[0].options.body).tools[0].function.parameters, true);
  const usage = await env.DB.prepare(
    "SELECT * FROM request_usage WHERE mode='aistudio' ORDER BY id DESC LIMIT 1",
  ).first();
  assert.equal(usage.total_tokens, 9);
  assert.equal(usage.api_key_name, '总密钥（兼容）');
  assert.equal(usage.outcome, 'success');
});

test('default routing and native protocol stream preserve byte framing and record reported usage', async () => {
  await configure({ routing: 'default' });
  const frames =
    'data: {"response":{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":3,"totalTokenCount":7},"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n';
  let target;
  const response = await handleRequest(
    request('/v1beta/models/model-one:streamGenerateContent?key=test-client-key&alt=sse', 'POST', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
    env,
    async (url) => {
      target = url;
      return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), frames);
  assert.equal(
    target,
    'https://test-instance.onrender.com/v1beta/models/model-one:streamGenerateContent?alt=sse',
  );
  assert.ok(!target.includes('test-client-key'));
  const row = await env.DB.prepare(
    "SELECT * FROM request_usage WHERE mode='aistudio' ORDER BY id DESC LIMIT 1",
  ).first();
  assert.equal(row.total_tokens, 7);
  await configure();
});

test('stream cancellation and in-band errors are recorded as cancellation or failure; redirects are blocked', async () => {
  const auth = { authorization: 'Bearer test-client-key' };
  const body = { model: 'model-one', messages: [{ role: 'user', content: 'hi' }] };
  let response = await handleRequest(
    request('/aistudio/v1/chat/completions', 'POST', body, auth),
    env,
    async () =>
      new Response('data: {"error":{"message":"upstream unavailable"}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  await response.text();
  let row = await env.DB.prepare(
    "SELECT * FROM request_usage WHERE mode='aistudio' ORDER BY id DESC LIMIT 1",
  ).first();
  assert.equal(row.outcome, 'failed');
  let cancelled = false;
  response = await handleRequest(
    request('/aistudio/v1/chat/completions', 'POST', body, auth),
    env,
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  await response.body.cancel();
  assert.equal(cancelled, true);
  row = await env.DB.prepare(
    "SELECT * FROM request_usage WHERE mode='aistudio' ORDER BY id DESC LIMIT 1",
  ).first();
  assert.equal(row.outcome, 'cancelled');
  response = await handleRequest(
    request('/aistudio/v1/chat/completions', 'POST', body, auth),
    env,
    async () =>
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } }),
  );
  assert.equal(response.status, 502);
});

test('ten-minute cron probes when enabled and stops when keepalive or upstream is disabled', async () => {
  await configure();
  const original = globalThis.fetch;
  const tasks = [];
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.ok(url.endsWith('.onrender.com/'));
    return new Response('ok');
  };
  try {
    worker.scheduled({ cron: '*/10 * * * *' }, env, { waitUntil: (p) => tasks.push(p) });
    await Promise.all(tasks);
    assert.equal(calls, 1);
    await configure({ keepalive: false });
    tasks.length = 0;
    worker.scheduled({ cron: '*/10 * * * *' }, env, { waitUntil: (p) => tasks.push(p) });
    await Promise.all(tasks);
    assert.equal(calls, 1);
    await configure({ enabled: false });
    tasks.length = 0;
    worker.scheduled({ cron: '*/10 * * * *' }, env, { waitUntil: (p) => tasks.push(p) });
    await Promise.all(tasks);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('Render warmup HTML is not reported as a successful JSON model catalog', async () => {
  await configure();
  const response = await handleRequest(
    request('/aistudio/v1/models', 'GET', undefined, { authorization: 'Bearer test-client-key' }),
    env,
    async () =>
      new Response('<html>Starting service</html>', { headers: { 'content-type': 'text/html' } }),
  );
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /模型目录尚未就绪/);
});

test('account rollups isolate AI Studio from unassigned native failures, including existing rows', () => {
  const base = {
    credential_id: null,
    requests: 1,
    total_duration_ms: 20,
    day: '2026-11-05',
    model: 'test',
  };
  const result = summarizeRows(
    [
      { ...base, mode: 'antigravity', display_name: '未选中凭证', failures: 1 },
      {
        ...base,
        mode: 'aistudio',
        display_name: 'AI Studio · old.onrender.com',
        successes: 1,
        total_tokens: 50,
      },
      {
        ...base,
        mode: 'aistudio',
        display_name: 'AI Studio · new.onrender.com',
        successes: 1,
        total_tokens: 70,
      },
    ],
    new Map(),
  );
  assert.equal(result.summary.requests, 3);
  assert.equal(result.summary.total_tokens, 120);
  assert.equal(result.credentials.length, 2);
  const external = result.credentials.find((row) => row.mode === 'aistudio');
  assert.equal(external.display_name, 'AIStudio2API');
  assert.equal(external.external, true);
  assert.equal(external.requests, 2);
  assert.equal(external.total_tokens, 120);
  assert.equal(external.failures, 0);
  assert.equal(result.credentials.find((row) => row.mode === 'antigravity').failures, 1);
});
