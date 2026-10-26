import { archiveUsage, archivedEntries } from '../src/telemetry/archive.js';
import { attachTimings } from '../src/core/timing.js';
import { DailyStatsIndex, dayStart } from '../src/telemetry/preaggregate.js';
import { credentialHealth } from '../src/telemetry/health.js';
import { selectCredential } from '../src/credentials/index.js';
import { storageNodeSource } from '../src/storage/node-worker.js';
import { syncNodeTelemetry } from '../src/storage/telemetry.js';
import { handleRequest } from '../src/index.js';
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
import { telemetryPayload, pendingTelemetry } from '../src/telemetry/client.js';
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

test('production entrypoint uses aggregate binding; 128 successes flush within 20 D1 rows written including change indexes', async () => {
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
    // Change tracking adds one shared revision write and an index entry per aggregate.
    assert.ok(cost.writes <= 20, JSON.stringify(cost));
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

test('primary node usage reads existing buffers without D1 I/O or extra SQL writes', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf),
      stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const item = record();
    await recordTelemetry(env, item);
    await recordTelemetry(env, item);
    await stub.fetch('https://test/quota/' + id, {
      method: 'POST',
      body: JSON.stringify({
        credentialId: id,
        mode: 'antigravity',
        queriedAt: new Date().toISOString(),
        models: [{ id: 'm', remaining: 0.5 }],
      }),
    });
    const before = await (await stub.fetch('https://test/test/status')).json();
    let response = await stub.fetch('https://test/node-usage?fresh=1'),
      usage = await response.json();
    assert.equal(response.status, 200);
    assert.equal(usage.today_requests, 1);
    assert.equal(usage.pending_requests, 1);
    assert.equal(usage.pending_buckets, 1);
    assert.equal(usage.quota_entries, 1);
    assert.equal(usage.activity.writes, 3);
    assert.equal(usage.activity.requests, 3);
    assert.ok(usage.buffer_bytes > 0);
    assert.ok(!JSON.stringify(usage).includes('account@example.test'));
    const after = await (await stub.fetch('https://test/test/status')).json();
    assert.equal(after.reads, before.reads);
    assert.equal(after.writes, before.writes);
    assert.equal(after.queries, before.queries);
    assert.equal(after.sqlWrites, before.sqlWrites);
    const again = await (await stub.fetch('https://test/node-usage')).json();
    assert.equal(again.activity.requests, 3);
    await flush(env);
    usage = await (await stub.fetch('https://test/node-usage?fresh=1')).json();
    assert.equal(usage.today_requests, 1);
    assert.equal(usage.pending_requests, 0);
    assert.equal(usage.pending_buckets, 0);
  } finally {
    await mf.dispose();
  }
});

test('child buffers model usage, live statistics merge it immediately, duplicate delivery and lost acknowledgement do not double count', async () => {
  const mf = await runtime();
  let remote;
  try {
    const env = await setup(mf),
      nodeId = '33333333-3333-4333-8333-333333333333',
      secret = 'c'.repeat(64),
      worker = 'gcli2api-storage-333333333333';
    await env.DB.prepare(
      "INSERT INTO storage_nodes(id,email,account_id,worker_name,node_secret,url,status,deployed,created_at,updated_at)VALUES(?,?,?,?,?,?,'ready',1,1,1)",
    )
      .bind(
        nodeId,
        'child@example.test',
        'c'.repeat(32),
        worker,
        secret,
        'https://' + worker + '.pages.dev',
      )
      .run();
    env.TELEMETRY_ORIGIN = 'https://main.test';
    let callbacks = 0;
    remote = new Miniflare({
      modules: true,
      script: storageNodeSource,
      compatibilityDate: '2025-09-01',
      bindings: { NODE_ID: nodeId, NODE_SECRET: secret },
      durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
      log: quiet,
      outboundService: async (request) => {
        callbacks++;
        const response = await handleRequest(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
          }),
          env,
        );
        return new OutboundResponse(await response.arrayBuffer(), {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    let snapshotReads = 0;
    env.STORAGE_NODE_FETCH = (url, init) => {
      if (url.endsWith('/telemetry/snapshot')) snapshotReads++;
      return remote.dispatchFetch(url, init);
    };
    const a = record(),
      b = record();
    await recordTelemetry(env, a);
    await recordTelemetry(env, a);
    await recordTelemetry(env, b);
    assert.equal((await snapshot(env)).buckets.length, 0, 'no per-request primary DO writes');
    assert.equal(await count(env, 'request_usage'), 0, 'successful requests have no D1 details');
    const basic = await handleRequest(
      new Request('https://main.test/admin/credentials?view=basic', {
        headers: { authorization: 'Bearer panel' },
      }),
      { ...env, PANEL_PASSWORD: 'panel' },
    );
    assert.equal(basic.status, 200);
    assert.match(basic.headers.get('server-timing'), /credentials_db;dur=/);
    assert.equal((await basic.json()).credentials.length, 1);
    assert.equal(snapshotReads, 0, 'basic list must not wait for node synchronization');

    const headers = { authorization: 'Bearer ' + secret, 'content-type': 'application/json' };
    const raw = await (
      await remote.dispatchFetch('https://node/telemetry/snapshot', { method: 'POST', headers })
    ).json();
    assert.equal(
      raw.buckets.reduce((n, b) => n + b.value.requests, 0),
      2,
    );
    const unchanged = await (
      await remote.dispatchFetch('https://node/telemetry/snapshot', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          known_versions: Object.fromEntries(raw.buckets.map((b) => [b.key, b.version])),
        }),
      })
    ).json();
    assert.deepEqual(
      unchanged.buckets,
      [],
      'known versions skip unchanged payloads without hiding later versions',
    );
    let usage = await (await remote.dispatchFetch('https://node/usage', { headers })).json();
    assert.equal(usage.telemetry.today_requests, 2);
    assert.equal(usage.telemetry.interval_seconds, 300);
    const [live, pending] = await Promise.all([
      usageStats(env.DB, new URLSearchParams(), env),
      pendingTelemetry(env),
    ]);
    assert.equal(live.summary.requests, 2, 'ordinary query reads current child buffers');
    assert.equal(
      pending.buckets.reduce((n, b) => n + b.value.requests, 0),
      2,
    );
    assert.equal(
      snapshotReads,
      1,
      'concurrent account and statistics queries share one live node synchronization',
    );
    assert.equal(
      await count(env, 'usage_aggregates'),
      0,
      'live query does not force D1 aggregate writes',
    );
    const c = record();
    await recordTelemetry(env, c);
    assert.equal(
      (await usageStats(env.DB, new URLSearchParams(), env)).summary.requests,
      3,
      'previous statistics cache cannot hide fresh child usage',
    );
    // A lost acknowledgement leaves a D1 fallback detail linked to the same child bucket.
    env.STORAGE_NODE_FETCH = async (url, init) => {
      const response = await remote.dispatchFetch(url, init);
      if (url.endsWith('/telemetry/record')) throw new Error('lost ack');
      return response;
    };
    await recordTelemetry(env, record());
    assert.equal(await count(env, 'request_usage'), 1);
    assert.equal(
      (await stats(env)).summary.requests,
      4,
      'fallback detail and child membership count once',
    );
    const flushed = await remote.dispatchFetch('https://node/telemetry/flush', {
      method: 'POST',
      headers,
    });
    assert.equal(flushed.status, 200);
    assert.equal(callbacks, 1);
    await syncNodeTelemetry(env);
    assert.equal((await stats(env)).summary.requests, 4);
    assert.equal((await flush(env)).status, 200);
    assert.equal(
      await count(env, 'request_usage'),
      0,
      'confirmed successful fallback detail is pruned at aggregate commit',
    );
    const before = await stats(env);
    // An old snapshot cannot replace a newer imported version.
    const replay = await handleRequest(
      new Request('https://main.test/internal/storage-telemetry', {
        method: 'POST',
        headers: { ...headers, 'x-storage-node-id': nodeId },
        body: JSON.stringify({ buckets: raw.buckets }),
      }),
      env,
    );
    assert.equal(replay.status, 200);
    assert.equal((await stats(env)).summary.requests, before.summary.requests);
    usage = await (await remote.dispatchFetch('https://node/usage', { headers })).json();
    assert.equal(usage.telemetry.pending_buckets, 0);
    assert.equal(
      (
        await handleRequest(
          new Request('https://main.test/internal/storage-telemetry', {
            method: 'POST',
            body: '{}',
          }),
          env,
        )
      ).status,
      401,
    );
  } finally {
    await remote?.dispose();
    await mf.dispose();
  }
});

test('child keeps issue diagnostics and health, merged issue pagination and filtered cleanup preserve usage totals', async () => {
  const mf = await runtime();
  let remote;
  try {
    const env = await setup(mf),
      nodeId = '44444444-4444-4444-8444-444444444444',
      secret = 'e'.repeat(64),
      worker = 'gcli2api-storage-444444444444';
    await env.DB.prepare(
      "INSERT INTO storage_nodes(id,email,account_id,worker_name,node_secret,url,status,deployed,created_at,updated_at)VALUES(?,?,?,?,?,?,'ready',1,1,1)",
    )
      .bind(
        nodeId,
        'logs@example.test',
        'e'.repeat(32),
        worker,
        secret,
        'https://' + worker + '.pages.dev',
      )
      .run();
    const other = '55555555-5555-4555-8555-555555555555';
    await env.DB.prepare(
      "INSERT INTO credentials(id,mode,name,data,created_at)VALUES(?,'antigravity','other','{}',1)",
    )
      .bind(other)
      .run();
    env.TELEMETRY_ORIGIN = 'https://main.test';
    remote = new Miniflare({
      modules: true,
      script: storageNodeSource,
      compatibilityDate: '2025-09-01',
      bindings: { NODE_ID: nodeId, NODE_SECRET: secret },
      durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
      log: quiet,
    });
    env.STORAGE_NODE_FETCH = (url, init) => remote.dispatchFetch(url, init);
    await selectCredential(env.DB, 'antigravity', 'm', [], 'round_robin', null, env);
    assert.equal(
      await env.DB.prepare('SELECT last_used FROM credentials WHERE id=?')
        .bind(id)
        .first('last_used'),
      0,
      'rotation snapshot skips per-request D1 persistence',
    );
    for (let n = 0; n < 27; n++)
      await recordTelemetry(
        env,
        record({
          status: 502,
          outcome: 'failed',
          apiKey: { id: '66666666-6666-4666-8666-666666666666', name: 'client-fixture' },
          attempts: [
            {
              credential_id: other,
              credential_name: 'other@example.test',
              mode: 'antigravity',
              model: 'm',
              status: 429,
              stage: 'response_headers',
              duration_ms: 1,
              created_at: Date.now(),
              detail_code: 'HTTP_429',
              detail_message: 'safe diagnostic',
            },
          ],
        }),
      );
    assert.equal(await count(env, 'request_usage'), 0, 'issue diagnostics stay in child SQLite');
    assert.equal(await count(env, 'credential_health'), 0, 'health changes are buffered');
    const params = new URLSearchParams('issues=1');
    let releaseParallel,
      dbStarted = false,
      nodeStarted = false;
    const parallelGate = new Promise((resolve) => (releaseParallel = resolve)),
      realDb = env.DB;
    const delayedDb = {
      prepare(sql) {
        const raw = realDb.prepare(sql);
        if (!sql.startsWith('WITH events')) return raw;
        return {
          bind(...values) {
            const statement = raw.bind(...values);
            return {
              async all() {
                dbStarted = true;
                await parallelGate;
                return statement.all();
              },
            };
          },
        };
      },
    };
    const parallelEnv = {
      ...env,
      DB: delayedDb,
      STORAGE_NODE_FETCH: async (url, init) => {
        if (url.includes('/events/query')) {
          nodeStarted = true;
          await parallelGate;
        }
        return remote.dispatchFetch(url, init);
      },
    };
    const firstFlight = queryCallLogs(delayedDb, params, false, parallelEnv);
    for (let attempt = 0; attempt < 100 && !(dbStarted && nodeStarted); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    releaseParallel();
    assert.ok(dbStarted && nodeStarted, 'D1 and node reads must start in parallel');
    const first = await firstFlight;
    assert.equal(first.records.length, 50);
    assert.ok(first.next);
    assert.equal(first.records[0].api_key_name, 'client-fixture');
    params.set('before', first.next);
    const next = await queryCallLogs(env.DB, params, false, env);
    assert.equal(next.records.length, 4);
    assert.equal(new Set([...first.records, ...next.records].map((row) => row.id)).size, 54);
    const filtered = await queryCallLogs(
      env.DB,
      new URLSearchParams('status=429&email=other@&stage=response_headers'),
      true,
      env,
    );
    assert.equal(filtered.records.length, 27);
    assert.equal(filtered.truncated, false);
    assert.equal((await credentialHealth(env.DB, other, env)).health.last_status, 429);
    assert.equal(
      (await credentialHealth(env.DB, id, env)).health.last_status,
      502,
      'another account retry does not replace the final account status',
    );
    assert.equal((await stats(env)).summary.requests, 27);
    const cleared = await clearCallLogs(
      env.DB,
      new URLSearchParams('stage=response_headers'),
      { confirm: 'delete-matching-logs' },
      env,
    );
    assert.equal(cleared.deleted, 27);
    const remaining = await queryCallLogs(env.DB, new URLSearchParams('issues=1'), true, env);
    assert.equal(remaining.records.length, 27);
    assert.ok(remaining.records.every((row) => row.stage === 'request_failed'));
    assert.equal(
      (await stats(env)).summary.requests,
      27,
      'clearing diagnostics cannot erase usage',
    );
    assert.equal((await flush(env)).status, 200);
    assert.equal(
      await env.DB.prepare('SELECT last_status FROM credential_health WHERE credential_id=?')
        .bind(other)
        .first('last_status'),
      429,
    );
    assert.equal(
      await env.DB.prepare('SELECT last_status FROM credential_health WHERE credential_id=?')
        .bind(id)
        .first('last_status'),
      502,
    );
    assert.ok(
      (await env.DB.prepare('SELECT last_used FROM credentials WHERE id=?')
        .bind(id)
        .first('last_used')) > 0,
    );
    await publishShared(
      env,
      'models:antigravity',
      { ids: ['model-fixture'], routes: { 'model-fixture': 'model-fixture' } },
      900,
    );
    const shared = await readShared({ ...env, CACHE: undefined }, 'models:antigravity');
    assert.deepEqual(
      shared.value.ids,
      ['model-fixture'],
      'model catalogs are reusable from the child without KV reads',
    );
  } finally {
    await remote?.dispose();
    await mf.dispose();
  }
});

test('daily preaggregation preserves null versus zero, exact boundary times, live replacements and detail deduplication', () => {
  const first = dayStart(Date.now()) - 2 * 86400000,
    aggregates = [];
  for (let day = 0; day < 2; day++)
    for (let slot = 0; slot < 6; slot++) {
      const created_at = first + day * 86400000 + slot * 4 * 3600000;
      aggregates.push({
        key: 'bucket:' + day + ':' + slot,
        version: 1,
        value: {
          credential_id: id,
          credential_name: 'account',
          api_key_id: null,
          mode: 'antigravity',
          model: 'm',
          status: 200,
          outcome: 'success',
          created_at,
          requests: 1,
          successes: 1,
          failures: 0,
          cancellations: 0,
          total_duration_ms: 100,
          input_tokens: null,
          output_tokens: null,
          thought_tokens: null,
          total_tokens: day === 0 && slot === 0 ? 0 : null,
          token_reports: day === 0 && slot === 0 ? 1 : 0,
        },
      });
    }
  const detail = {
    request_id: 'fallback',
    aggregate_key: 'bucket:1:0',
    credential_id: id,
    credential_name: 'account',
    mode: 'antigravity',
    model: 'm',
    status: 502,
    outcome: 'failed',
    created_at: first + 86400000 + 3600000,
    duration_ms: 200,
    total_tokens: null,
  };
  const index = new DailyStatsIndex({ aggregates, details: [detail] });
  index.update(new Map());
  const full = index.query(first, first + 2 * 86400000 - 1);
  assert.equal(full.total_rows, 13);
  assert.equal(full.query_rows, 3);
  assert.equal(
    full.rows.reduce((n, r) => n + r.requests, 0),
    13,
  );
  assert.equal(
    full.rows.filter((r) => r.outcome === 'success').find((r) => r.created_at === first)
      .total_tokens,
    0,
  );
  assert.equal(
    full.rows.filter((r) => r.outcome === 'success').find((r) => r.created_at === first + 86400000)
      .total_tokens,
    null,
  );
  const range = index.query(first + 5 * 3600000, first + 86400000 + 5 * 3600000);
  assert.equal(
    range.rows.reduce((n, r) => n + r.requests, 0),
    7,
  );
  const old = aggregates.find((row) => row.key === 'bucket:1:0');
  const live = new Map([
    [
      old.key,
      {
        version: 2,
        dirty: 1,
        payload: JSON.stringify({
          ...old.value,
          requests: 2,
          successes: 2,
          total_tokens: 5,
          token_reports: 2,
        }),
        members: JSON.stringify(['original', 'fallback']),
      },
    ],
  ]);
  index.update(live);
  const updated = index.query(first, Infinity);
  assert.equal(
    updated.rows.reduce((n, r) => n + r.requests, 0),
    13,
    'fallback detail becomes part of the newer live bucket',
  );
  assert.equal(
    updated.rows.reduce((n, r) => n + (r.total_tokens || 0), 0),
    5,
  );
  assert.equal(index.pending, 2);
  index.update(live);
  assert.equal(
    index.query(first, Infinity).rows.reduce((n, r) => n + r.requests, 0),
    13,
    'same bucket version cannot be added twice',
  );
  live.get(old.key).dirty = 0;
  index.update(live);
  assert.equal(index.pending, 0);
  assert.ok(
    index.query(first, Infinity, true).query_rows > updated.query_rows,
    'request ID filtering can retain exact original rows',
  );
});

test('slow request diagnostics contain stage timings without query strings or arbitrary metric names', () => {
  const original = console.warn,
    logs = [];
  console.warn = (value) => logs.push(value);
  try {
    const response = Response.json({});
    attachTimings(
      response,
      {
        REQUEST_TIMINGS: [
          { name: 'nodes', ms: 50 },
          { name: 'stats_do', ms: 25 },
          { name: 'bad;secret=fixture-private', ms: 1 },
        ],
      },
      performance.now() - 2000,
      '/admin/stats?token=fixture-private',
    );
    assert.match(response.headers.get('server-timing'), /nodes;dur=50.0/);
    assert.match(response.headers.get('server-timing'), /total;dur=/);
    assert.equal(logs.length, 1);
    assert.equal(JSON.parse(logs[0]).route, '/admin/stats');
    assert.ok(!logs[0].includes('fixture-private'));
    assert.ok(!response.headers.get('server-timing').includes('fixture-private'));
  } finally {
    console.warn = original;
  }
});

test('incremental history reads only changed buckets after 1200 historical rows', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf),
      at = Math.floor(Date.now() / 300000) * 300000;
    await env.DB.exec(
      `INSERT INTO usage_aggregates(bucket_key,version,created_at,payload,members)
   WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1200)
   SELECT printf('%013d',${at})||':seed:'||x,1,${at},json_object('created_at',${at},'mode','antigravity','model','seed','status',200,'outcome','success','requests',1,'successes',1,'failures',0,'cancellations',0,'total_duration_ms',10,'total_tokens',5,'token_reports',1),'[]' FROM n`.replaceAll(
        '\n',
        ' ',
      ),
    );
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const control = (path = 'status') =>
      stub.fetch('https://test/test/' + path).then((r) => r.json());
    const query = () => usageStats(env.DB, new URLSearchParams('fresh=1'), env);
    assert.equal((await query()).summary.requests, 1200);
    await recordTelemetry(env, record({ model: 'new' }));
    await flush(env);
    const before = await control();
    await control('expire-history');
    const latest = await query(),
      after = await control();
    assert.equal(latest.summary.requests, 1201);
    assert.ok(after.queryReads - before.queryReads < 80, JSON.stringify({ before, after }));
    assert.equal(
      (await stats(env)).summary.requests,
      1201,
      'full rebuild agrees with incremental data',
    );
  } finally {
    await mf.dispose();
  }
});

test('one flush merges twenty model buckets into five SQL statements and one health update per credential', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf),
      started = Date.now() - 20;
    for (let i = 0; i < 20; i++)
      await recordTelemetry(env, record({ started, model: 'model-' + i }));
    assert.equal((await flush(env)).status, 200);
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const state = await (await stub.fetch('https://test/test/status')).json();
    assert.equal(state.batches, 1);
    assert.equal(state.statements, 5);
    const health = await env.DB.prepare('SELECT * FROM credential_health WHERE credential_id=?')
      .bind(id)
      .first();
    assert.ok(health.last_success >= started);
    assert.equal(health.failure_streak, 0);
    assert.equal((await stats(env)).summary.requests, 20);
  } finally {
    await mf.dispose();
  }
});

test('daily archive keeps exact times, survives cold rebuild, deduplicates late cumulative versions and D1-only reads', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf),
      started = dayStart(Date.now() - 8 * 86400000) + 13 * 3600000;
    await recordTelemetry(env, record({ started, model: 'old-a' }));
    await recordTelemetry(
      env,
      record({ started: started + 600000, model: 'old-b', usage: { totalTokenCount: 0 } }),
    );
    const live = (await snapshot(env)).buckets;
    assert.equal((await flush(env)).status, 200);
    const result = await archiveUsage(env.DB);
    assert.equal(result.archived, 2);
    assert.equal(await count(env, 'usage_aggregates'), 0);
    assert.equal(await count(env, 'usage_daily_archive'), 1);
    const stored = await archivedEntries(env.DB);
    assert.equal(stored.size, 2);
    assert.equal(
      (await stats(env)).summary.requests,
      2,
      'cold history restores compressed daily archive',
    );
    assert.equal(
      (await stats(env, 'from=' + started + '&to=' + (started + 1))).summary.requests,
      1,
      'exact time filter after daily compression',
    );
    let direct = await usageStats(env.DB, new URLSearchParams('fresh=1'), {
      USAGE_STORAGE_MODE: 'detailed',
    });
    assert.equal(direct.summary.requests, 2, 'D1-only fallback includes archived totals');
    const previous = live[0],
      value = { ...previous.value, requests: 2, successes: 2, total_tokens: 10 };
    await env.DB.batch([
      env.DB.prepare('UPDATE telemetry_revision SET value=value+1 WHERE id=1'),
      env.DB.prepare(
        'INSERT INTO usage_aggregates(bucket_key,version,created_at,credential_id,api_key_id,payload,members,change_seq)VALUES(?,?,?,?,?,?,?,(SELECT value FROM telemetry_revision WHERE id=1))',
      ).bind(
        previous.key,
        2,
        value.created_at,
        id,
        null,
        JSON.stringify(value),
        JSON.stringify([...previous.members, 'late-member']),
      ),
    ]);
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    await stub.fetch('https://test/test/expire-history');
    assert.equal(
      (await usageStats(env.DB, new URLSearchParams('fresh=1'), env)).summary.requests,
      3,
      'late newer cumulative bucket replaces archived version',
    );
    direct = await usageStats(env.DB, new URLSearchParams('fresh=1'), {
      USAGE_STORAGE_MODE: 'detailed',
    });
    assert.equal(direct.summary.requests, 3);
    assert.equal((await archiveUsage(env.DB)).archived, 1);
    assert.equal((await stats(env)).summary.requests, 3, 'repeated archive does not double count');
    await env.DB.prepare(
      'INSERT INTO usage_aggregates(bucket_key,version,created_at,credential_id,api_key_id,payload,members)VALUES(?,?,?,?,?,?,?)',
    )
      .bind(
        previous.key,
        previous.version,
        previous.value.created_at,
        id,
        null,
        JSON.stringify(previous.value),
        JSON.stringify(previous.members),
      )
      .run();
    const stale = await usageStats(env.DB, new URLSearchParams('fresh=1'), {
      USAGE_STORAGE_MODE: 'detailed',
    });
    assert.equal(
      stale.summary.requests,
      3,
      'stale hot retransmission cannot replace newer archived cumulative totals',
    );
  } finally {
    await mf.dispose();
  }
});

test('failure before account selection records its real phase, safe quota error and auto routing', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf),
      raw = env.DB;
    const DB = {
      prepare(sql) {
        if (sql.startsWith('SELECT c.* FROM credentials'))
          throw new Error('D1 read quota exceeded private-cause-token');
        return raw.prepare(sql);
      },
      batch: (args) => raw.batch(args),
    };
    let upstreamCalls = 0;
    const response = await handleRequest(
      new Request('https://test/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-test', messages: [{ role: 'user', content: 'hi' }] }),
      }),
      { ...env, DB, API_PASSWORD: 'api' },
      async () => {
        upstreamCalls++;
        throw new Error('must not call Google');
      },
    );
    assert.equal(response.status, 503);
    const body = await response.json();
    const logs = await queryCallLogs(
      raw,
      new URLSearchParams({ request_id: body.error.request_id }),
    );
    assert.equal(logs.records.length, 1);
    const final = logs.records[0];
    assert.equal(final.mode, 'auto');
    assert.equal(final.credential_id, null);
    assert.equal(final.credential_state, 'not_selected');
    assert.equal(final.stage, 'credential_select');
    assert.equal(final.detail_code, 'DB_RESOURCE_LIMIT');
    assert.match(final.detail_message, /D1/);
    assert.ok(!JSON.stringify(final).includes('private-cause-token'));
    assert.equal(final.status, response.status);
    assert.equal(upstreamCalls, 0);
  } finally {
    await mf.dispose();
  }
});

test('unified routing retains selected account when preparation fails before upstream fetch', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf);
    let calls = 0;
    const response = await handleRequest(
      new Request('https://test/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-test', messages: [{ role: 'user', content: 'hi' }] }),
      }),
      { ...env, API_PASSWORD: 'api', ANTIGRAVITY_API_URL: 'http://invalid.example' },
      async () => {
        calls++;
        throw new Error('must not call Google');
      },
    );
    assert.equal(response.status, 503);
    const body = await response.json();
    const logs = await queryCallLogs(
      env.DB,
      new URLSearchParams({ request_id: body.error.request_id }),
    );
    assert.equal(logs.records[0].credential_id, id);
    assert.equal(logs.records[0].mode, 'antigravity');
    assert.equal(logs.records[0].credential_state, 'selected');
    assert.equal(logs.records[0].stage, 'request_prepare');
    assert.match(logs.records[0].detail_message, /HTTPS/);
    assert.equal(calls, 0);
  } finally {
    await mf.dispose();
  }
});

test('legacy accountless records remain explicit history instead of inventing an account', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf),
      item = record({ row: undefined, status: 500, outcome: 'failed' });
    await recordUsage(env.DB, item);
    const logs = await queryCallLogs(env.DB, new URLSearchParams({ request_id: item.requestId }));
    assert.equal(logs.records[0].credential_state, 'unrecorded');
    assert.match(logs.records[0].display_name, /历史记录/);
    assert.match(logs.records[0].detail_message, /无法还原/);
    const expired = record({
      row: undefined,
      status: 503,
      outcome: 'failed',
      started: Date.now() - 8 * 86400000,
      failure: { stage: 'credential_select', code: 'DB_RESOURCE_LIMIT', message: 'retained error' },
    });
    await recordUsage(env.DB, expired);
    await pruneTelemetry(env.DB);
    const retained = await env.DB.prepare(
      'SELECT failure_stage,failure_code,failure_message,log_visible FROM request_usage WHERE request_id=?',
    )
      .bind(expired.requestId)
      .first();
    assert.deepEqual(
      retained,
      { failure_stage: null, failure_code: null, failure_message: null, log_visible: 0 },
      'new failure diagnostics also expire after seven days while usage survives',
    );
  } finally {
    await mf.dispose();
  }
});

test('persistent schedule endpoint rejects external hosts and never rewrites a frozen hourly decision', async () => {
  const mf = await runtime();
  try {
    const env = await setup(mf);
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const nodes = [1, 2].map((n) => ({
      id: `${n}`.repeat(8) + '-0000-0000-0000-000000000000',
      worker_name: 'gcli2api-storage-' + `${n}`.repeat(12),
      url: 'https://gcli2api-storage-' + `${n}`.repeat(12) + '.pages.dev',
      node_secret: `${n}`.repeat(64),
      activated_at: 0,
    }));
    const request = (value) =>
      stub.fetch('https://test/storage-schedule', {
        method: 'POST',
        body: JSON.stringify({ nodes: value }),
      });
    assert.equal((await request([{ ...nodes[0], url: 'https://untrusted.example' }])).status, 400);
    const firstResponse = await request(nodes);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.ok(nodes.some((n) => n.id === first.current_id));
    assert.ok(!JSON.stringify(first).includes(nodes[0].node_secret));
    const before = await (await stub.fetch('https://test/test/status')).json();
    const second = await (await request([...nodes].reverse())).json();
    assert.deepEqual(second, first);
    const after = await (await stub.fetch('https://test/test/status')).json();
    assert.equal(after.sqlWrites, before.sqlWrites);
    assert.equal(after.queries, before.queries, 'schedule uses no D1 reads');
  } finally {
    await mf.dispose();
  }
});

test('search model errors retain sanitized Google messages for each retry and the final issue', async () => {
  for (const status of [503, 404]) {
    const mf = await runtime();
    try {
      const env = {
        ...(await setup(mf)),
        API_PASSWORD: 'api',
        PANEL_PASSWORD: 'panel',
        ANTIGRAVITY_STREAM2NOSTREAM: false,
        MAX_CREDENTIAL_ATTEMPTS: 3,
      };
      const data = JSON.stringify({
        token: 'fixture-private-oauth-token',
        refresh_token: 'fixture-private-refresh',
        project_id: 'fixture-project',
        expiry: '2099-01-01T00:00:00Z',
      });
      await env.DB.prepare('UPDATE credentials SET data=? WHERE id=?').bind(data, id).run();
      for (let n = 2; n <= 3; n++)
        await env.DB.prepare(
          'INSERT INTO credentials(id,mode,name,data,created_at)VALUES(?,?,?,?,?)',
        )
          .bind(
            `${n}`.repeat(8) + '-1111-4111-8111-111111111111',
            'antigravity',
            'account-' + n,
            data,
            Date.now(),
          )
          .run();
      let calls = 0;
      const raw = {
        error: {
          code: status,
          status: status === 503 ? 'UNAVAILABLE' : 'NOT_FOUND',
          message:
            (status === 503 ? 'Model capacity unavailable' : 'Model not found') +
            ' fixture-private-oauth-token',
        },
      };
      const response = await handleRequest(
        new Request('https://fixture/antigravity/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-2.5-pro-search',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        }),
        env,
        async (url, init) => {
          calls++;
          const payload = JSON.parse(init.body);
          assert.equal(payload.model, 'gemini-2.5-pro');
          assert.ok(payload.request.tools.some((tool) => tool.googleSearch));
          return Response.json(raw, { status });
        },
      );
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), raw);
      assert.equal(calls, status === 503 ? 3 : 1);
      const logs = await queryCallLogs(
        env.DB,
        new URLSearchParams({ request_id: response.headers.get('x-request-id') }),
      );
      assert.equal(logs.records.length, calls + 1);
      for (const event of logs.records) {
        assert.equal(event.detail_code, 'HTTP_' + status);
        assert.match(
          event.detail_message,
          status === 503 ? /Model capacity unavailable/ : /Model not found/,
        );
        assert.ok(!event.detail_message.includes('fixture-private-oauth-token'));
      }
    } finally {
      await mf.dispose();
    }
  }
});

test('catalog tiered search shortcut reaches the real upstream model on fixed and unified endpoints', async () => {
  for (const path of ['/antigravity/v1/chat/completions', '/v1/chat/completions']) {
    const mf = await runtime();
    try {
      const env = { ...(await setup(mf)), API_PASSWORD: 'api', ANTIGRAVITY_STREAM2NOSTREAM: false };
      await env.DB.prepare('UPDATE credentials SET data=? WHERE id=?')
        .bind(
          JSON.stringify({
            token: 'fixture-token',
            project_id: 'project',
            expiry: '2099-01-01T00:00:00Z',
          }),
          id,
        )
        .run();
      const { dbCache } = await import('../src/cache/db.js');
      const model = 'gemini-3.8-flash-tiered';
      dbCache(env.DB).models = {
        until: Date.now() + 60000,
        value: { ids: [model], routes: { [model]: model }, queriedAt: new Date().toISOString() },
      };
      const response = await handleRequest(
        new Request('https://fixture' + path, {
          method: 'POST',
          headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: model + '-search',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        }),
        env,
        async (url, init) => {
          const body = JSON.parse(init.body);
          assert.equal(body.model, model);
          assert.ok(body.request.tools.some((tool) => tool.googleSearch));
          return Response.json({
            response: {
              candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
            },
          });
        },
      );
      assert.equal(response.status, 200);
    } finally {
      await mf.dispose();
    }
  }
});
