import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { Miniflare, Log, LogLevel } from 'miniflare';
import worker, { handleRequest } from '../src/index.js';
import { effectiveEnv, readSettings, saveSettings } from '../src/settings.js';
import { recordUsage, usageStats } from '../src/metrics.js';
import { queryCallLogs, clearCallLogs } from '../src/reliability.js';
import { dbCache } from '../src/db-cache.js';
globalThis.crypto ||= webcrypto;
async function database(run) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2025-09-01',
    d1Databases: { DB: 'budget-test' },
    log: new Log(LogLevel.NONE),
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const file of (await readdir('migrations')).filter((f) => f.endsWith('.sql')).sort())
      await db.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
    await run(db);
  } finally {
    await mf.dispose();
  }
}
function metered(raw) {
  const totals = { queries: 0, rows_read: 0, rows_written: 0 };
  const count = (r) => {
    totals.queries++;
    totals.rows_read += r.meta?.rows_read || 0;
    totals.rows_written += r.meta?.rows_written || 0;
    return r;
  };
  return {
    totals,
    prepare(sql) {
      const wrap = (stmt) => ({
        stmt,
        bind(...values) {
          assert.ok(values.length <= 100, 'D1 parameter limit');
          return wrap(stmt.bind(...values));
        },
        async all() {
          return count(await stmt.all());
        },
        async run() {
          return count(await stmt.run());
        },
        async first(column) {
          const r = count(await stmt.all());
          return column ? (r.results[0]?.[column] ?? null) : (r.results[0] ?? null);
        },
      });
      return wrap(raw.prepare(sql));
    },
    async batch(items) {
      return (await raw.batch(items.map((i) => i.stmt))).map(count);
    },
  };
}

test('D1 budget: full retention window and 128 healthy requests avoid per-request log duplication and pruning', () =>
  database(async (raw) => {
    const now = Date.now(),
      id = '11111111-1111-4111-8111-111111111111';
    await raw
      .prepare('INSERT INTO credentials(id,mode,name,data,created_at)VALUES(?,?,?,?,?)')
      .bind(
        id,
        'antigravity',
        'benchmark',
        JSON.stringify({ token: 'fake', project_id: 'p', expiry: '2099-01-01T00:00:00Z' }),
        now,
      )
      .run();
    await raw.exec(
      `WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO request_usage(request_id,mode,model,status,outcome,duration_ms,created_at)SELECT 'seed-'||x,'antigravity','seed',200,'success',1,${now} FROM n`,
    );
    await raw.exec(
      `WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO call_logs(request_id,mode,model,status,stage,duration_ms,created_at)SELECT 'seed-'||x,'antigravity','seed',200,'completed',1,${now} FROM n`,
    );
    const DB = metered(raw),
      env = { DB, API_PASSWORD: 'api', ANTIGRAVITY_STREAM2NOSTREAM: false };
    const send = () =>
      handleRequest(
        new Request('https://test/antigravity/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'benchmark', messages: [{ role: 'user', content: 'hi' }] }),
        }),
        env,
        async () =>
          Response.json({
            response: {
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
            },
          }),
      );
    assert.equal((await send()).status, 200);
    for (const key of Object.keys(DB.totals)) DB.totals[key] = 0;
    for (let i = 0; i < 128; i++) {
      const response = await send();
      assert.equal(response.status, 200, await response.clone().text());
    }
    assert.ok(DB.totals.queries <= 128 * 4, JSON.stringify(DB.totals));
    assert.ok(DB.totals.rows_written <= 128 * 8, JSON.stringify(DB.totals));
    assert.ok(DB.totals.rows_read <= 128 * 12, JSON.stringify(DB.totals));
    assert.equal(
      (
        await raw
          .prepare("SELECT COUNT(*) AS count FROM request_usage WHERE model='benchmark'")
          .first()
      ).count,
      129,
    );
    assert.equal(
      (await raw.prepare("SELECT COUNT(*) AS count FROM call_logs WHERE model='benchmark'").first())
        .count,
      0,
    );
    assert.ok(
      (await raw.prepare('SELECT COUNT(*) AS count FROM request_usage').first()).count <= 10127,
    );
    // The bounded local rotation metadata must not grow SQL beyond D1's parameter limit.
    assert.ok(dbCache(DB).rotation.size <= 40);
  }));

test('D1 reads: settings TTL and scoped invalidation; stats aggregate once and cache immutable results', () =>
  database(async (raw) => {
    const DB = metered(raw),
      env = { DB, MAX_CREDENTIAL_ATTEMPTS: '3' };
    for (let i = 0; i < 10; i++) assert.equal((await effectiveEnv(env)).MAX_CREDENTIAL_ATTEMPTS, 3);
    assert.equal(DB.totals.queries, 1);
    await saveSettings(env, { MAX_CREDENTIAL_ATTEMPTS: 4 });
    assert.equal((await effectiveEnv(env)).MAX_CREDENTIAL_ATTEMPTS, 4);
    await raw
      .prepare("UPDATE app_settings SET value='5' WHERE key='MAX_CREDENTIAL_ATTEMPTS'")
      .run();
    assert.equal((await effectiveEnv(env)).MAX_CREDENTIAL_ATTEMPTS, 4);
    dbCache(DB).settings.until = 0;
    assert.equal((await effectiveEnv(env)).MAX_CREDENTIAL_ATTEMPTS, 5);
    assert.equal((await readSettings(env)).effective.MAX_CREDENTIAL_ATTEMPTS, 5);
    await recordUsage(raw, {
      requestId: 'stats-1',
      mode: 'antigravity',
      model: 'm',
      status: 200,
      outcome: 'success',
      started: Date.now(),
      usage: { promptTokenCount: 2, totalTokenCount: 5 },
    });
    const before = DB.totals.queries;
    let value = await usageStats(DB, new URLSearchParams());
    assert.equal(value.summary.requests, 1);
    assert.equal(DB.totals.queries, before + 1);
    value.summary.requests = 999;
    value = await usageStats(DB, new URLSearchParams());
    assert.equal(value.summary.requests, 1);
    assert.equal(DB.totals.queries, before + 1);
    await recordUsage(raw, {
      requestId: 'stats-2',
      mode: 'antigravity',
      model: 'm',
      status: 200,
      outcome: 'success',
      started: Date.now(),
      usage: { totalTokenCount: 7 },
    });
    assert.equal((await usageStats(DB, new URLSearchParams())).summary.requests, 1);
    value = await usageStats(DB, new URLSearchParams('fresh=1'));
    assert.equal(value.summary.requests, 2);
    assert.equal(value.summary.total_tokens, 12);
    assert.equal(DB.totals.queries, before + 2);
  }));

test('7-day logs: hide expired entries immediately, hourly Cron deletes old events while retaining 30-day usage; union cursors and deletion preserve statistics', () =>
  database(async (db) => {
    const now = Date.now();
    for (const [id, days] of [
      ['old', 8],
      ['recent', 6],
    ]) {
      await db
        .prepare(
          'INSERT INTO call_logs(request_id,mode,model,status,stage,duration_ms,created_at)VALUES(?,?,?,?,?,?,?)',
        )
        .bind(id, 'antigravity', 'retention', 429, 'response_headers', 1, now - days * 86400000)
        .run();
      await recordUsage(db, {
        requestId: 'usage-' + id,
        mode: 'antigravity',
        model: 'retention',
        status: 200,
        outcome: 'success',
        started: now - days * 86400000,
      });
    }
    await recordUsage(db, {
      requestId: 'usage-expired',
      mode: 'antigravity',
      model: 'retention',
      status: 200,
      outcome: 'success',
      started: now - 31 * 86400000,
    });
    await db.prepare('UPDATE request_usage SET duration_ms=1').run();
    let result = await queryCallLogs(db, new URLSearchParams());
    assert.equal(result.records.length, 2);
    assert.ok(result.records.every((r) => r.request_id.includes('recent')));
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS count FROM call_logs WHERE request_id='old'").first())
        .count,
      1,
    );
    const pending = [];
    worker.scheduled({}, { DB: db }, { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS count FROM call_logs WHERE request_id='old'").first())
        .count,
      0,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT COUNT(*) AS count FROM request_usage WHERE request_id='usage-old'")
          .first()
      ).count,
      1,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT COUNT(*) AS count FROM request_usage WHERE request_id='usage-expired'")
          .first()
      ).count,
      0,
    );
    assert.equal((await usageStats(db, new URLSearchParams('fresh=1'))).summary.requests, 2);
    await db.batch([db.prepare('DELETE FROM call_logs'), db.prepare('DELETE FROM request_usage')]);
    await db.exec(
      `WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<120) INSERT INTO call_logs(request_id,mode,model,status,stage,duration_ms,created_at)SELECT 'tie-event-'||x,'antigravity','tie',429,'response_headers',0,${now} FROM n`,
    );
    await db.exec(
      `WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<120) INSERT INTO request_usage(request_id,mode,model,status,outcome,duration_ms,created_at)SELECT 'tie-usage-'||x,'antigravity','tie',200,'success',0,${now} FROM n`,
    );
    const seen = new Set();
    let before = null;
    do {
      result = await queryCallLogs(db, new URLSearchParams(before ? { before } : {}));
      for (const row of result.records) {
        const key = row.event_source + ':' + row.id;
        assert.equal(seen.has(key), false);
        seen.add(key);
      }
      before = result.next;
    } while (before);
    assert.equal(seen.size, 240);
    let cleared = await clearCallLogs(db, new URLSearchParams('stage=completed'), {
      confirm: 'delete-matching-logs',
    });
    assert.equal(cleared.deleted, 120);
    result = await queryCallLogs(db, new URLSearchParams(), true);
    assert.equal(result.records.length, 120);
    assert.ok(result.records.every((r) => r.status === 429));
    assert.equal((await usageStats(db, new URLSearchParams('fresh=1'))).summary.requests, 120);
    cleared = await clearCallLogs(db, new URLSearchParams(), { confirm: 'delete-matching-logs' });
    assert.equal(cleared.deleted, 120);
    assert.equal((await queryCallLogs(db, new URLSearchParams())).records.length, 0);
  }));
