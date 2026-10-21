import { pruneTelemetry } from '../src/telemetry/maintenance.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, Response as OutboundResponse } from 'miniflare';
import { recordTelemetry, recordUsage, usageStats } from '../src/telemetry/index.js';
import { telemetryPayload } from '../src/telemetry/client.js';
import { readShared, publishShared } from '../src/cache/shared.js';
import { queryCallLogs, clearCallLogs } from '../src/upstream/reliability.js';
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
    kvNamespaces: ['CACHE'],
    compatibilityFlags: ['enable_request_signal'],
    bindings: { API_PASSWORD: 'api', PANEL_PASSWORD: 'panel', ANTIGRAVITY_STREAM2NOSTREAM: false },
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
    CACHE: await mf.getKVNamespace('CACHE'),
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
  usageStats(env.DB, new URLSearchParams('fresh=1&sync=1&' + params), env);
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
  const persist = await mkdtemp(join(tmpdir(), 'gcli-telemetry-persist-'));
  let mf = await runtime(persist);
  try {
    let env = await setup(mf);
    await recordTelemetry(env, record());
    assert.equal(await count(env, 'usage_aggregates'), 0);
    assert.equal(
      (await usageStats(env.DB, new URLSearchParams('fresh=1'), env)).summary.requests,
      1,
    );
    await mf.dispose();
    mf = await runtime(persist);
    env = {
      DB: await mf.getD1Database('DB'),
      TELEMETRY: await mf.getDurableObjectNamespace('TELEMETRY'),
    };
    assert.equal(
      (await usageStats(env.DB, new URLSearchParams('fresh=1'), env)).summary.requests,
      1,
    );
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const control = await (await stub.fetch('https://test/test/status')).json();
    assert.equal(control.queries, 0, 'persistent snapshot survives restart without D1 reread');
    assert.equal((await flush(env)).status, 200);
    assert.equal((await stats(env)).summary.requests, 1);
  } finally {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
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
  const dir = await mkdtemp(join(tmpdir(), 'gcli-resource-test-'));
  try {
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('production entrypoint uses aggregate binding; 128 successes flush within 16 D1 rows written including read indexes', async () => {
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
    // Maintaining the aggregate key/time and latest-success indexes adds four writes per two-bucket flush.
    assert.ok(cost.writes <= 16, JSON.stringify(cost));
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

test('DO statistics reuse persistent history for filters and fresh queries; explicit and hourly sync read D1', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf);
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const query = (params = '') =>
      usageStats(env.DB, new URLSearchParams('fresh=1&' + params), env);
    const control = (path = 'status') =>
      stub.fetch('https://test/test/' + path).then((r) => r.json());
    await recordTelemetry(env, record());
    const first = await query();
    assert.equal(first.query_source, 'durable-object');
    assert.equal(first.summary.requests, 1);
    const initial = await control();
    assert.ok(initial.queries >= 5);
    await recordTelemetry(env, record({ model: 'second' }));
    assert.equal((await query()).summary.requests, 2);
    assert.equal((await query('model=second')).summary.requests, 1);
    assert.equal((await control()).queries, initial.queries);
    await flush(env);
    assert.equal((await query()).summary.requests, 2);
    assert.equal((await control()).queries, initial.queries);
    const forced = await query('sync=1');
    assert.equal(forced.summary.requests, 2);
    const afterForce = await control();
    assert.ok(afterForce.queries > initial.queries);
    await control('expire-history');
    assert.equal((await query()).summary.requests, 2);
    assert.ok((await control()).queries > afterForce.queries);
    await control('fail-history');
    // Within the hour, fresh queries still work without the unavailable historical database.
    assert.equal((await query()).summary.requests, 2);
    await assert.rejects(query('sync=1'), { status: 503 });
    await control('recover-history');
    assert.equal((await query('sync=1')).summary.requests, 2);
  } finally {
    await mf.dispose();
  }
});

test('DO quota cache validates records, expires, and invalidates with credential metadata', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf);
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const url = 'https://test/quota/' + id;
    const value = {
      success: true,
      credentialId: id,
      mode: 'antigravity',
      queriedAt: new Date().toISOString(),
      models: [{ id: 'gemini-test', remaining: 0.7 }],
      secret: 'must-not-persist',
    };
    assert.equal((await stub.fetch(url)).status, 404);
    const save = () => stub.fetch(url, { method: 'POST', body: JSON.stringify(value) });
    assert.equal((await save()).status, 200);
    const result = await (await stub.fetch(url)).json();
    assert.equal(result.cached, true);
    assert.equal(result.cacheSeconds, 600);
    assert.equal(result.models[0].remaining, 0.7);
    assert.equal(result.secret, undefined);
    await stub.fetch('https://test/test/expire-quota');
    assert.equal((await stub.fetch(url)).status, 404);
    await save();
    assert.equal(
      (
        await stub.fetch('https://test/invalidate-metadata', {
          method: 'POST',
          body: JSON.stringify({ credentialId: id }),
        })
      ).status,
      200,
    );
    assert.equal((await stub.fetch(url)).status, 404);
  } finally {
    await mf.dispose();
  }
});

test('packed history: 5000 historical aggregates do not become 5000 DO rows; warm filtering has bounded reads', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf);
    const at = Date.now() - 86400000;
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5000)
      INSERT INTO usage_aggregates(bucket_key,version,created_at,payload,members) SELECT printf('%013d',${at})||':'||x,1,${at},json_object('created_at',${at},'mode','antigravity','model',CASE WHEN x%2=0 THEN 'even' ELSE 'odd' END,'status',200,'outcome','success','requests',1,'successes',1,'failures',0,'cancellations',0,'total_duration_ms',10,'total_tokens',5,'token_reports',1),'[]' FROM n`,
    ).run();
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const control = (path = 'status') =>
      stub.fetch('https://test/test/' + path).then((r) => r.json());
    const query = (params = '') =>
      usageStats(env.DB, new URLSearchParams('fresh=1&' + params), env);
    const before = await control();
    const initial = await query();
    assert.equal(initial.summary.requests, 5000);
    const first = await control();
    assert.ok(first.sqlWrites - before.sqlWrites < 30, JSON.stringify(first));
    assert.ok(first.kvWrites <= 2, JSON.stringify(first));
    for (let i = 0; i < 5; i++) assert.equal((await query('model=even')).summary.requests, 2500);
    const after = await control();
    assert.equal(after.queries, first.queries);
    assert.equal(after.sqlWrites, first.sqlWrites);
    assert.equal(
      after.kvWrites,
      first.kvWrites,
      'filters and manual refresh do not bypass the global KV write gate',
    );
    assert.ok(after.sqlReads - first.sqlReads <= 25, JSON.stringify({ first, after }));
    // KV restores a missing local baseline; no historical D1 scan is needed.
    await control('forget-history');
    assert.equal((await query()).summary.requests, 5000);
    assert.equal((await control()).queries, first.queries);
    await control('fail-kv');
    await control('expire-query-kv');
    assert.equal((await query('model=odd')).summary.requests, 2500);
  } finally {
    await mf.dispose();
  }
});

test('KV query snapshot serves a new Worker cache without calling DO and manual fresh bypasses it', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf);
    await recordTelemetry(env, record());
    assert.equal(
      (await usageStats(env.DB, new URLSearchParams('fresh=1'), env)).summary.requests,
      1,
    );
    let calls = 0;
    const isolated = {
      ...env,
      DB: {},
      TELEMETRY: {
        idFromName: () => 0,
        get: () => ({
          fetch: () => {
            calls++;
            throw new Error('DO should be cached');
          },
        }),
      },
    };
    const cached = await usageStats(isolated.DB, new URLSearchParams(), isolated);
    assert.equal(cached.summary.requests, 1);
    assert.equal(cached.cache_source, 'kv');
    assert.equal(calls, 0);
    await assert.rejects(usageStats(isolated.DB, new URLSearchParams('fresh=1'), isolated));
    assert.equal(calls, 1);
    const entry = (await env.CACHE.list({ prefix: 'gcli-stats:v2:' })).keys[0];
    const value = await env.CACHE.get(entry.name, 'json');
    value.cached_at = Date.now() - 301000;
    await env.CACHE.put(entry.name, JSON.stringify(value));
    const expired = { ...isolated, DB: {} };
    await assert.rejects(usageStats(expired.DB, new URLSearchParams(), expired));
    assert.equal(calls, 2, 'expired KV data must not hide new usage');
  } finally {
    await mf.dispose();
  }
});
