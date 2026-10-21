import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, Response as OutboundResponse } from 'miniflare';
import { webcrypto } from 'node:crypto';
import { weightedChoice, selectCredential } from '../src/credentials/index.js';
import { filters } from '../src/telemetry/filters.js';
import { pruneTelemetry } from '../src/telemetry/maintenance.js';
import { reportedUsage, recordUsage } from '../src/telemetry/index.js';
import { handleRequest } from '../src/index.js';
import { validateSetting } from '../src/config/settings.js';
globalThis.crypto ||= webcrypto;
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';

test('weighted random uses weight intervals without treating weights as priority', () => {
  const rows = [
    { id: 'a', weight: 1 },
    { id: 'b', weight: 3 },
  ];
  assert.equal(
    weightedChoice([], () => 0),
    null,
  );
  for (const r of [0, 0.1, 0.2499])
    assert.equal(
      weightedChoice(rows, () => r),
      'a',
    );
  for (const r of [0.25, 0.5, 0.999999])
    assert.equal(
      weightedChoice(rows, () => r),
      'b',
    );
  for (const value of ['round_robin', 'priority', 'weighted'])
    assert.equal(validateSetting('CREDENTIAL_SELECTION', value), value);
  assert.throws(() => validateSetting('CREDENTIAL_SELECTION', 'ORDER BY secret'), { status: 400 });
});
test('filter values are bound, ranges/status/cursors validated and missing usage stays unknown', () => {
  const f = filters(
    new URLSearchParams({ email: "x' OR 1=1 --", status: '5xx', model: 'm', from: '0', to: '100' }),
  );
  assert.ok(!f.where.includes("x'"));
  assert.ok(f.values.includes("x' OR 1=1 --"));
  for (const query of [
    'status=600',
    'status=abc',
    'from=100&to=1',
    'from=bad',
    'before=1.5',
    'credential_id=bad',
    'mode=bad',
  ])
    assert.throws(() => filters(new URLSearchParams(query)), { status: 400 });
  assert.deepEqual(
    reportedUsage({
      promptTokenCount: 0,
      candidatesTokenCount: -1,
      thoughtsTokenCount: 2.5,
      totalTokenCount: '5',
    }),
    { input: 0, output: null, thought: null, total: null },
  );
});

test('production Worker: final usage, account health, selection, scoped log export/delete and retention', async () => {
  const bundle = await build({
    entryPoints: ['src/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  let scenario = 'retry';
  const seen = [];
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: { API_PASSWORD: 'api', PANEL_PASSWORD: 'panel' },
    d1Databases: { DB: 'operations-test' },
    log: new Log(LogLevel.NONE),
    outboundService: async (request) => {
      const payload = JSON.parse(await request.text());
      const token = request.headers.get('authorization');
      seen.push({ token, model: payload.model });
      if (scenario === 'retry' && token === 'Bearer token-a')
        return new OutboundResponse(
          JSON.stringify({
            error: {
              message: 'limit',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  metadata: { quotaResetDelay: '6d' },
                },
              ],
            },
          }),
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '60' },
          },
        );
      const value = {
        response: {
          candidates: [
            {
              content: { parts: [{ text: 'ok' }] },
              ...(scenario === 'truncated' ? {} : { finishReason: 'STOP' }),
            },
          ],
          ...(scenario === 'unknown'
            ? {}
            : {
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 3,
                  thoughtsTokenCount: 2,
                  totalTokenCount: 15,
                },
              }),
        },
      };
      return new OutboundResponse(
        request.url.includes('streamGenerateContent')
          ? 'data: ' + JSON.stringify(value) + '\n\n'
          : JSON.stringify(value),
        {
          headers: {
            'content-type': request.url.includes('streamGenerateContent')
              ? 'text/event-stream'
              : 'application/json',
          },
        },
      );
    },
  });
  try {
    const db = await mf.getD1Database('DB');
    // Seed old-schema data before applying 0005: upgrade must preserve tokens and defaults.
    for (const name of [
      '0001_credentials.sql',
      '0002_oauth.sql',
      '0003_reliability.sql',
      '0004_settings.sql',
    ])
      await db.exec((await readFile('migrations/' + name, 'utf8')).replaceAll('\n', ' '));
    for (const [id, email, token] of [
      [a, 'alpha@example.test', 'token-a'],
      [b, 'beta@example.test', 'token-b'],
    ])
      await db
        .prepare('INSERT INTO credentials (id,mode,name,data,created_at) VALUES (?,?,?,?,?)')
        .bind(
          id,
          'antigravity',
          id,
          JSON.stringify({
            token,
            project_id: 'p',
            user_email: email,
            expiry: '2099-01-01T00:00:00Z',
          }),
          Date.now(),
        )
        .run();
    await db.exec((await readFile('migrations/0005_operations.sql', 'utf8')).replaceAll('\n', ' '));
    await db.exec((await readFile('migrations/0006_d1_budget.sql', 'utf8')).replaceAll('\n', ' '));
    await db.exec(
      (await readFile('migrations/0007_packed_diagnostics.sql', 'utf8')).replaceAll('\n', ' '),
    );
    await db.exec(
      (await readFile('migrations/0008_usage_aggregates.sql', 'utf8')).replaceAll('\n', ' '),
    );
    await db.exec((await readFile('migrations/0009_api_keys.sql', 'utf8')).replaceAll('\n', ' '));
    assert.equal(
      (await db.prepare('SELECT weight FROM credentials WHERE id=?').bind(a).first()).weight,
      1,
    );
    const admin = (path, method = 'GET', body) =>
      mf.dispatchFetch('https://test' + path, {
        method,
        headers: { authorization: 'Bearer panel', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const settings = (value) => admin('/admin/settings', 'PATCH', value);
    const chat = (stream = false, model = 'claude-opus-4-6') =>
      mf.dispatchFetch('https://test/antigravity/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream,
          messages: [{ role: 'user', content: 'prompt-never-in-metrics' }],
        }),
      });
    const stats = async (query) => {
      const r = await admin('/admin/stats?fresh=1' + (query ? '&' + query : ''));
      assert.equal(r.status, 200, await r.clone().text());
      return r.json();
    };
    assert.equal(
      (await admin('/admin/credentials/' + a, 'PATCH', { priority: 10, weight: 9 })).status,
      200,
    );
    assert.equal(
      (await admin('/admin/credentials/' + b, 'PATCH', { priority: 1, weight: 1 })).status,
      200,
    );
    for (const patch of [{ priority: 101 }, { priority: 1.2 }, { weight: 0 }, { weight: '3' }])
      assert.equal((await admin('/admin/credentials/' + a, 'PATCH', patch)).status, 400);
    assert.equal((await settings({ CREDENTIAL_SELECTION: 'priority' })).status, 200);
    let response = await chat();
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
      seen.map((s) => s.token),
      ['Bearer token-a', 'Bearer token-b'],
    );
    assert.equal(seen[0].model, 'claude-opus-4-6-thinking');
    let value = await stats();
    assert.equal(value.summary.requests, 1);
    assert.equal(value.summary.successes, 1);
    assert.equal(value.summary.total_tokens, 15);
    assert.equal(value.summary.thought_tokens, 2);
    assert.equal(value.credentials[0].display_name, 'beta@example.test');
    assert.doesNotMatch(JSON.stringify(value), /token-a|token-b|prompt-never/);
    let health = await (await admin('/admin/credentials/' + a + '/health')).json();
    assert.equal(health.health.last_status, 429);
    assert.equal(health.health.last_success, null);
    assert.equal(health.cooldowns[0].model, 'claude-opus-4-6-thinking');
    assert.ok(health.cooldowns[0].until_ms > Date.now() + 5 * 86400000);
    health = await (await admin('/admin/credentials/' + b + '/health')).json();
    assert.ok(health.health.last_success);
    assert.equal(health.health.failure_streak, 0);
    const requestId = response.headers.get('x-request-id');
    value = await (await admin('/admin/calls?status=2xx&request_id=' + requestId)).json();
    assert.equal(value.records.length, 1);
    assert.equal(value.records[0].stage, 'completed');
    value = await (await admin('/admin/calls?status=429&email=ALPHA')).json();
    assert.equal(value.records.length, 1);
    response = await admin('/admin/calls/export?credential_id=' + b);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.equal((await response.json()).records.length, 1);
    for (const path of [
      '/admin/calls?status=600',
      '/admin/stats?from=100&to=1',
      '/admin/calls?before=-1',
    ])
      assert.equal((await admin(path)).status, 400);
    assert.equal((await mf.dispatchFetch('https://test/admin/stats')).status, 401);
    assert.equal((await admin('/admin/calls?status=429', 'DELETE', {})).status, 400);
    response = await admin('/admin/calls?status=429', 'DELETE', {
      confirm: 'delete-matching-logs',
    });
    assert.equal((await response.json()).deleted, 1);
    assert.equal((await stats()).summary.requests, 1);
    assert.equal(
      (await (await admin('/admin/credentials/' + a + '/health')).json()).health.last_status,
      429,
    );
    // Priority picks a repeatedly; weighted skips disabled, cooldown and excluded IDs.
    scenario = 'ok';
    await db.prepare('DELETE FROM credential_cooldowns').run();
    for (let i = 0; i < 2; i++) assert.equal((await chat()).status, 200);
    assert.deepEqual(
      seen.slice(-2).map((s) => s.token),
      ['Bearer token-a', 'Bearer token-a'],
    );
    await admin('/admin/credentials/' + a, 'PATCH', { disabled: true });
    assert.equal((await selectCredential(db, 'antigravity', 'm', [], 'weighted')).id, b);
    await admin('/admin/credentials/' + a, 'PATCH', { disabled: false });
    assert.equal((await selectCredential(db, 'antigravity', 'm', [a], 'weighted')).id, b);
    await db
      .prepare(
        'INSERT INTO credential_cooldowns (credential_id,model,until_ms,status) VALUES (?,?,?,429)',
      )
      .bind(a, 'm', Date.now() + 60000)
      .run();
    assert.equal((await selectCredential(db, 'antigravity', 'm', [], 'weighted')).id, b);
    // Existing single-file import must retain scheduling; backups can explicitly restore it.
    const credential = (await db.prepare('SELECT data FROM credentials WHERE id=?').bind(a).first())
      .data;
    await admin('/admin/credentials', 'POST', {
      name: a,
      mode: 'antigravity',
      credential: JSON.parse(credential),
    });
    assert.equal(
      (await db.prepare('SELECT weight FROM credentials WHERE id=?').bind(a).first()).weight,
      9,
    );
    await admin('/admin/credentials', 'POST', {
      name: a,
      mode: 'antigravity',
      priority: 4,
      weight: 7,
      credential: JSON.parse(credential),
    });
    assert.equal(
      (await db.prepare('SELECT weight FROM credentials WHERE id=?').bind(a).first()).weight,
      7,
    );
    // Success without reported usage stays unknown. Stream failures preserve observed usage but never success.
    scenario = 'unknown';
    assert.equal((await chat(false, 'unknown')).status, 200);
    let row = (await stats('model=unknown')).summary;
    assert.equal(row.requests, 1);
    assert.equal(row.token_reports, 0);
    assert.equal(row.total_tokens, null);
    scenario = 'truncated';
    response = await chat(true, 'truncated');
    assert.match(await response.text(), /upstream_error/);
    row = (await stats('model=truncated')).summary;
    assert.equal(row.failures, 1);
    assert.equal(row.successes, 0);
    assert.equal(row.requests, 1);
    assert.equal(row.total_tokens, 15);
    // All three public stream formats save the same upstream usage once, including actual thinking tokens.
    scenario = 'ok';
    for (const [path, body] of [
      [
        '/v1/chat/completions',
        { model: 'stream-ok', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      ],
      [
        '/v1/messages',
        {
          model: 'stream-ok',
          stream: true,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }],
        },
      ],
      [
        '/v1beta/models/stream-ok:streamGenerateContent',
        { contents: [{ parts: [{ text: 'hi' }] }] },
      ],
    ]) {
      response = await mf.dispatchFetch('https://test/antigravity' + path, {
        method: 'POST',
        headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    row = (await stats('model=stream-ok')).summary;
    assert.equal(row.requests, 3);
    assert.equal(row.successes, 3);
    assert.equal(row.total_tokens, 45);
    // Direct route plus actual D1 verifies client cancellation without depending on Miniflare's HTTP buffering.
    const beforeCancellation = (await (await admin('/admin/credentials/' + a + '/health')).json())
      .health?.last_failure;
    const cancelled = await handleRequest(
      new Request('https://test/antigravity/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'cancelled',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      { DB: db, API_PASSWORD: 'api' },
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    await cancelled.body.cancel();
    row = (await stats('model=cancelled')).summary;
    assert.equal(row.cancellations, 1);
    assert.equal(row.requests, 1);
    assert.equal(row.successes, 0);
    assert.equal(
      (await (await admin('/admin/credentials/' + a + '/health')).json()).health?.last_failure,
      beforeCancellation,
    );
    // Rename updates email/name grouping; deleted credentials retain their snapshot label.
    await admin('/admin/credentials/' + b, 'PATCH', { name: 'renamed' });
    value = await stats('email=BETA');
    assert.equal(value.credentials[0].display_name, 'beta@example.test');
    const now = Date.now();
    await recordUsage(db, {
      requestId: 'idempotent',
      row: { id: b, name: 'n', data: { user_email: 'beta@example.test' } },
      mode: 'antigravity',
      model: 'once',
      status: 200,
      outcome: 'success',
      started: now,
    });
    await recordUsage(db, {
      requestId: 'idempotent',
      mode: 'antigravity',
      model: 'once',
      status: 200,
      outcome: 'success',
      started: now,
    });
    assert.equal((await stats('model=once')).summary.requests, 1);
    await admin('/admin/credentials/' + b, 'DELETE');
    assert.equal(
      (await stats('email=beta&model=once')).credentials[0].display_name,
      'beta@example.test',
    );
    // Deleting an account during generation must not discard the final request metrics.
    await recordUsage(db, {
      requestId: 'deleted-inflight',
      row: { id: b, name: 'deleted', data: {} },
      mode: 'antigravity',
      model: 'inflight',
      status: 200,
      outcome: 'success',
      started: now,
    });
    assert.equal((await stats('model=inflight')).summary.requests, 1);
    const localDay = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T16:10:00Z') - 86400000;
    await recordUsage(db, {
      requestId: 'beijing-day',
      mode: 'antigravity',
      model: 'timezone',
      status: 200,
      outcome: 'success',
      started: localDay,
    });
    assert.equal(
      (await stats('model=timezone')).days[0].day,
      new Date(localDay + 8 * 3600000).toISOString().slice(0, 10),
    );
    assert.equal((await stats('model=timezone&from=' + String(localDay + 1))).summary.requests, 0);
    // Retention bounds storage and drops expired rows on the next write.
    await db.exec(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10005) INSERT INTO request_usage (request_id,mode,model,status,outcome,duration_ms,created_at) SELECT 'seed-'||x,'antigravity','seed',200,'success',1,${now} FROM n`,
    );
    await recordUsage(db, {
      requestId: 'prune',
      mode: 'antigravity',
      model: 'prune',
      status: 200,
      outcome: 'success',
      started: now,
    });
    await pruneTelemetry(db);
    assert.equal(
      (await db.prepare('SELECT COUNT(*) AS count FROM request_usage').first()).count,
      10000,
    );
    await recordUsage(db, {
      requestId: 'expired',
      mode: 'antigravity',
      model: 'expired',
      status: 200,
      outcome: 'success',
      started: now - 31 * 86400000,
    });
    await pruneTelemetry(db);
    assert.equal(
      (
        await db
          .prepare("SELECT COUNT(*) AS count FROM request_usage WHERE model='expired'")
          .first()
      ).count,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
