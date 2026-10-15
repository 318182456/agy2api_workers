import { pruneTelemetry } from '../src/maintenance.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, Response as OutboundResponse } from 'miniflare';
import { recordTelemetry, recordUsage, usageStats } from '../src/metrics.js';
import { telemetryPayload } from '../src/telemetry/client.js';
import { readShared, publishShared } from '../src/shared-cache.js';
import { queryCallLogs, clearCallLogs } from '../src/reliability.js';
import { prepareKv } from '../scripts/prepare-kv.mjs';
globalThis.crypto ||= webcrypto;
const quiet = new Log(LogLevel.NONE);
const id = '11111111-1111-4111-8111-111111111111';
const row = { id, name: 'original', data: { user_email: 'account@example.test' } };
const record = (extra = {}) => ({
  requestId: randomUUID(),
  row,
  mode: 'antigravity',
  model: 'm',
  status: 200,
  outcome: 'success',
  started: Date.now() - 10,
  usage: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
  ...extra,
});
let bundle;
async function runtime(persist) {
  bundle ||= (
    await build({
      entryPoints: ['test/telemetry.fixture.js'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    })
  ).outputFiles[0].text;
  return new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate: '2025-09-01',
    d1Databases: { DB: 'telemetry-test' },
    compatibilityFlags: ['enable_request_signal'],
    bindings: { API_PASSWORD: 'api', PANEL_PASSWORD: 'panel' },
    outboundService: async () =>
      new OutboundResponse(
        JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { totalTokenCount: 5 },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    durableObjects: { TELEMETRY: { className: 'TelemetryBuffer', useSQLite: true } },
    ...(persist ? { durableObjectsPersist: persist + '/do', d1Persist: persist + '/d1' } : {}),
    log: quiet,
  });
}
async function setup(mf) {
  const DB = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter((file) => file.endsWith('.sql')).sort())
    await DB.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
  await DB.prepare('INSERT INTO credentials(id,mode,name,data,created_at)VALUES(?,?,?,?,?)')
    .bind(
      id,
      'antigravity',
      'renamed',
      JSON.stringify({ user_email: 'current@example.test' }),
      Date.now(),
    )
    .run();
  return {
    DB,
    TELEMETRY: await mf.getDurableObjectNamespace('TELEMETRY'),
    USAGE_STORAGE_MODE: 'aggregate',
  };
}
const snapshot = (env) =>
  env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'))
    .fetch('https://test/snapshot')
    .then((r) => r.json());
const flush = (env) =>
  env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api')).fetch('https://test/flush', {
    method: 'POST',
  });
const stats = (env, params = '') =>
  usageStats(env.DB, new URLSearchParams('fresh=1&' + params), env);
const count = (env, table) => env.DB.prepare('SELECT COUNT(*) AS n FROM ' + table).first('n');

test('persistent aggregation: clean successes skip D1 details, retry diagnostics retain filters, flush is idempotent', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf);
    const first = record();
    await recordTelemetry(env, first);
    await recordTelemetry(env, first);
    const failed = record({
      status: 502,
      outcome: 'failed',
      attempts: [
        {
          credential_id: id,
          credential_name: 'old',
          mode: 'antigravity',
          model: 'm',
          status: 502,
          stage: 'generation_fetch',
          duration_ms: 1,
          created_at: Date.now(),
          detail_code: 'CONNECTION_FAILED',
        },
      ],
    });
    await recordTelemetry(env, failed);
    await recordTelemetry(env, record({ status: 499, outcome: 'cancelled', usage: null }));
    assert.equal(await count(env, 'request_usage'), 2);
    assert.equal(await count(env, 'call_logs'), 0);
    let value = await stats(env);
    assert.equal(value.summary.requests, 3);
    assert.equal(value.summary.successes, 1);
    assert.equal(value.summary.failures, 1);
    assert.equal(value.summary.cancellations, 1);
    assert.equal(value.summary.total_tokens, 10);
    assert.equal(value.summary.token_reports, 2);
    assert.equal(value.credentials[0].display_name, 'current@example.test');
    assert.equal((await stats(env, 'status=5xx')).summary.requests, 1);
    assert.equal((await stats(env, 'email=current%40example.test')).summary.requests, 3);
    assert.equal((await stats(env, 'email=absent')).summary.requests, 0);
    assert.equal((await stats(env, 'request_id=' + failed.requestId)).summary.requests, 0);
    const logs = await queryCallLogs(env.DB, new URLSearchParams());
    assert.equal(logs.records.length, 3);
    assert.equal(logs.records.filter((r) => r.stage === 'generation_fetch').length, 1);
    assert.equal((await flush(env)).status, 200);
    value = await stats(env);
    assert.equal(value.summary.requests, 3);
    assert.equal(value.summary.total_tokens, 10);
    assert.equal(value.pending_requests, 0);
    assert.equal(await count(env, 'usage_aggregates'), 3);
    assert.equal((await flush(env)).status, 200);
    assert.equal((await stats(env)).summary.requests, 3);
    await recordTelemetry(env, record({ started: first.started }));
    assert.equal((await stats(env)).summary.requests, 4);
    assert.equal((await flush(env)).status, 200);
    assert.equal((await stats(env)).summary.requests, 4);
    await clearCallLogs(env.DB, new URLSearchParams('stage=generation_fetch'), {
      confirm: 'delete-matching-logs',
    });
    assert.equal(
      (await queryCallLogs(env.DB, new URLSearchParams('stage=generation_fetch'))).records.length,
      0,
    );
    assert.equal((await queryCallLogs(env.DB, new URLSearchParams())).records.length, 2);
    assert.equal((await stats(env)).summary.requests, 4);
  } finally {
    await mf.dispose();
  }
});

test('D1 unavailable during flush retains durable data; uncertain acknowledgements and fallback details do not double count', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf),
      namespace = env.TELEMETRY;
    const lostAck = {
      ...env,
      TELEMETRY: {
        idFromName: (name) => namespace.idFromName(name),
        get: (key) => ({
          fetch: async (...args) => {
            await namespace.get(key).fetch(...args);
            throw new Error('lost acknowledgement');
          },
        }),
      },
    };
    await recordTelemetry(lostAck, record());
    assert.equal(await count(env, 'request_usage'), 1);
    assert.equal((await stats(env)).summary.requests, 1);
    await env.DB.exec('ALTER TABLE usage_aggregates RENAME TO unavailable_aggregates');
    assert.equal((await flush(env)).status, 503);
    assert.equal((await snapshot(env)).buckets[0].value.requests, 1);
    await env.DB.exec('ALTER TABLE unavailable_aggregates RENAME TO usage_aggregates');
    assert.equal((await flush(env)).status, 200);
    assert.equal(await count(env, 'request_usage'), 0);
    assert.equal((await stats(env)).summary.requests, 1);
    // A confirmed capacity rejection is counted only in detailed fallback, never silently dropped.
    const rejected = {
      ...env,
      TELEMETRY: {
        idFromName: (name) => name,
        get: () => ({ fetch: async () => new Response('', { status: 409 }) }),
      },
    };
    await recordTelemetry(rejected, record());
    assert.equal((await stats(env)).summary.requests, 2);
    assert.equal(
      await env.DB.prepare('SELECT aggregate_key FROM request_usage').first('aggregate_key'),
      null,
    );
  } finally {
    await mf.dispose();
  }
});

test('Durable Object SQLite buffer survives a full local runtime restart before D1 flush', async () => {
  const persist = process.cwd() + '/.wrangler/telemetry-persist-' + randomUUID();
  await mkdir(persist, { recursive: true });
  let mf = await runtime(persist);
  try {
    let env = await setup(mf);
    await recordTelemetry(env, record());
    assert.equal(await count(env, 'usage_aggregates'), 0);
    await mf.dispose();
    mf = await runtime(persist);
    env = {
      DB: await mf.getD1Database('DB'),
      TELEMETRY: await mf.getDurableObjectNamespace('TELEMETRY'),
    };
    assert.equal((await stats(env)).summary.requests, 1);
    assert.equal((await flush(env)).status, 200);
    assert.equal((await stats(env)).summary.requests, 1);
  } finally {
    await mf.dispose();
  }
});

test('aggregate mode: 128 clean requests create one aggregate, no log/request_usage rows and few D1 writes', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf);
    const started = Date.now() - 100;
    for (let i = 0; i < 128; i++) await recordTelemetry(env, record({ started }));
    assert.equal(await count(env, 'request_usage'), 0);
    assert.equal(await count(env, 'call_logs'), 0);
    assert.equal(await count(env, 'usage_aggregates'), 0);
    assert.equal((await stats(env)).summary.requests, 128);
    assert.equal((await flush(env)).status, 200);
    assert.equal(await count(env, 'usage_aggregates'), 1);
    assert.equal((await stats(env)).summary.total_tokens, 640);
    await recordTelemetry({ ...env, USAGE_STORAGE_MODE: 'detailed' }, record());
    assert.equal(await count(env, 'request_usage'), 1);
    assert.equal((await stats(env)).summary.requests, 129);
  } finally {
    await mf.dispose();
  }
});

test('KV cache: scoped keys, expiry, unchanged writes suppressed and failures never break requests', async () => {
  const store = new Map();
  let puts = 0;
  const CACHE = {
    get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
    put: async (key, value) => {
      puts++;
      store.set(key, value);
    },
  };
  const env = { CACHE, API_PASSWORD: 'a' };
  assert.equal(await readShared(env, 'settings'), null);
  assert.equal(await publishShared(env, 'settings', { MAX_CREDENTIAL_ATTEMPTS: 3 }, 7200), true);
  assert.equal(await publishShared(env, 'settings', { MAX_CREDENTIAL_ATTEMPTS: 3 }, 7200), false);
  assert.equal(puts, 1);
  for (let i = 0; i < 128; i++)
    assert.equal((await readShared(env, 'settings')).value.MAX_CREDENTIAL_ATTEMPTS, 3);
  assert.equal(puts, 1);
  assert.equal(await readShared({ ...env, API_PASSWORD: 'b' }, 'settings'), null);
  const [key, value] = [...store][0];
  store.set(key, JSON.stringify({ ...JSON.parse(value), expires: Date.now() - 1 }));
  assert.equal(await readShared(env, 'settings'), null);
  const broken = {
    CACHE: {
      get: async () => {
        throw new Error('unavailable');
      },
      put: async () => {
        throw new Error('unavailable');
      },
    },
  };
  assert.equal(await readShared(broken, 'settings'), null);
  assert.equal(await publishShared(broken, 'settings', {}, 60), false);
});

test('resource preparation names new KV gcli2api, reuses existing namespaces and leaves configured bindings intact', async () => {
  const dir = process.cwd() + '/.wrangler/resource-test-' + randomUUID();
  await mkdir(dir, { recursive: true });
  const path = dir + '/wrangler.jsonc';
  const config = {
    name: 'gcli2api',
    kv_namespaces: [{ binding: 'CACHE' }],
    d1_databases: [{ database_id: 'preserved' }],
  };
  await writeFile(path, JSON.stringify(config));
  let created = false;
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.includes('create')) {
      created = true;
      return '';
    }
    return JSON.stringify(created ? [{ title: 'gcli2api', id: 'a'.repeat(32) }] : []);
  };
  await prepareKv(run, path);
  let saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.kv_namespaces[0].id, 'a'.repeat(32));
  assert.deepEqual(saved.d1_databases, config.d1_databases);
  assert.deepEqual(calls[1], ['kv', 'namespace', 'create', 'gcli2api', '--update-config=false']);
  await prepareKv(() => {
    throw new Error('must not provision twice');
  }, path);
  await writeFile(path, JSON.stringify(config));
  await prepareKv(() => JSON.stringify([{ title: 'gcli2api', id: 'b'.repeat(32) }]), path);
  saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.kv_namespaces[0].id, 'b'.repeat(32));
});

test('concurrent flush keeps newer versions pending and retries the cumulative bucket without double counting', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf),
      stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const first = record();
    await recordTelemetry(env, first);
    await stub.fetch('https://test/test/block');
    const inFlight = flush(env);
    for (let i = 0; i < 100; i++) {
      if ((await (await stub.fetch('https://test/test/status')).json()).waiting) break;
      if (i === 99) assert.fail('D1 barrier was not reached');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await recordTelemetry(env, record({ started: first.started }));
    assert.equal((await stats(env)).summary.requests, 2);
    await stub.fetch('https://test/test/release');
    assert.equal((await inFlight).status, 200);
    assert.equal((await snapshot(env)).buckets[0].value.requests, 2);
    assert.equal((await stats(env)).summary.requests, 2);
    await flush(env);
    assert.equal((await stats(env)).summary.requests, 2);
    assert.equal((await snapshot(env)).buckets.length, 0);
  } finally {
    await mf.dispose();
  }
});

test('production entrypoint uses aggregate binding; 128 successes flush with fewer than 12 D1 rows written', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf);
    await env.DB.prepare('UPDATE credentials SET data=? WHERE id=?')
      .bind(JSON.stringify({ token: 'fake', expiry: '2099-01-01T00:00:00Z', project_id: 'p' }), id)
      .run();
    const response = await mf.dispatchFetch('https://test/antigravity/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await count(env, 'request_usage'), 0);
    const started = (await snapshot(env)).buckets[0].value.created_at + 1;
    for (let i = 0; i < 127; i++) await recordTelemetry(env, record({ started }));
    const before = await stats(env);
    assert.equal(before.summary.requests, 128);
    const adminResponse = await mf.dispatchFetch('https://test/admin/telemetry/flush', {
      method: 'POST',
      headers: { authorization: 'Bearer panel' },
    });
    assert.equal(adminResponse.status, 200, await adminResponse.clone().text());
    const cost = await (
      await env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api')).fetch(
        'https://test/test/status',
      )
    ).json();
    assert.ok(cost.writes < 12, JSON.stringify(cost));
    assert.equal((await stats(env)).summary.requests, 128);
    assert.equal(
      (await mf.dispatchFetch('https://test/admin/telemetry/flush', { method: 'POST' })).status,
      401,
    );
  } finally {
    await mf.dispose();
  }
});

test('expired packed diagnostics are physically removed after seven days while aggregate totals survive', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf),
      started = Date.now() - 8 * 86400000;
    const attempts = [
      {
        credential_id: id,
        credential_name: 'old',
        mode: 'antigravity',
        model: 'm',
        status: 502,
        stage: 'generation_fetch',
        duration_ms: 1,
        created_at: started,
        detail_code: 'FAILED',
      },
    ];
    await recordTelemetry(env, record({ started, status: 502, outcome: 'failed', attempts }));
    await recordUsage(env.DB, record({ started, status: 502, outcome: 'failed', attempts }));
    await env.DB.prepare('UPDATE request_usage SET duration_ms=1').run();
    await flush(env);
    assert.equal((await stats(env)).summary.requests, 2);
    await pruneTelemetry(env.DB);
    assert.equal(await count(env, 'request_usage'), 1);
    assert.equal(
      await env.DB.prepare('SELECT attempts FROM request_usage').first('attempts'),
      '[]',
    );
    assert.equal((await stats(env)).summary.requests, 2);
    assert.equal((await queryCallLogs(env.DB, new URLSearchParams())).records.length, 0);
  } finally {
    await mf.dispose();
  }
});
