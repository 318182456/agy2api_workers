import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, Response as OutboundResponse } from 'miniflare';
import { authenticateApi, parseKeyImport, keyHash, MASTER_KEY_ID } from '../src/api-keys.js';
import { recordTelemetry, recordUsage, usageStats } from '../src/metrics.js';
import { queryCallLogs, clearCallLogs } from '../src/reliability.js';

globalThis.crypto ||= webcrypto;
let bundle;
async function runtime(upstreamOverride) {
  bundle ||= (
    await build({
      entryPoints: ['src/index.js'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    })
  ).outputFiles[0].text;
  const mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate: '2025-09-01',
    compatibilityFlags: ['enable_request_signal'],
    bindings: {
      API_PASSWORD: 'local-master-only',
      PANEL_PASSWORD: 'local-panel-only',
    },
    d1Databases: { DB: 'api-keys-test' },
    durableObjects: { TELEMETRY: { className: 'TelemetryBuffer', useSQLite: true } },
    log: new Log(LogLevel.NONE),
    outboundService:
      upstreamOverride ||
      (async () =>
        new OutboundResponse(
          JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { totalTokenCount: 5 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )),
  });
  const DB = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter((file) => file.endsWith('.sql')).sort())
    await DB.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
  return {
    mf,
    env: {
      DB,
      TELEMETRY: await mf.getDurableObjectNamespace('TELEMETRY'),
      API_PASSWORD: 'local-master-only',
      USAGE_STORAGE_MODE: 'aggregate',
    },
  };
}
async function admin(mf, path = '', method = 'GET', body, expected = 200) {
  const response = await mf.dispatchFetch('https://test/admin/api-keys' + path, {
    method,
    headers: { authorization: 'Bearer local-panel-only', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, await response.clone().text());
  return response.json();
}
const request = (key, header = 'authorization') =>
  new Request('https://test/v1/models', {
    headers: { [header]: header === 'authorization' ? 'Bearer ' + key : key },
  });

test('key imports preserve opaque values, understand New API expiry/status and reject masked or malformed data', () => {
  const secret = 'old-client-key';
  assert.equal(parseKeyImport(secret)[0].key, secret);
  assert.equal(
    parseKeyImport(
      JSON.stringify({
        data: { items: [{ name: '项目', key: 'raw-new-api-key', status: 2, expired_time: -1 }] },
      }),
      'newapi',
    )[0].key,
    'sk-raw-new-api-key',
  );
  const row = parseKeyImport(
    { data: { name: 'token', key: 'sk-existing-client-key', status: 1, expired_time: 1800000000 } },
    'newapi',
  )[0];
  assert.equal(row.key, 'sk-existing-client-key');
  assert.equal(row.enabled, true);
  assert.equal(row.expires_at, 1800000000000);
  for (const input of [
    '',
    '[bad',
    'sk-1234********5678',
    [{ key: 'abc' }],
    Array(201).fill(secret),
    [{ key: secret, enabled: 'false' }],
  ])
    assert.throws(() => parseKeyImport(input), { status: 400 });
  assert.throws(
    () => parseKeyImport([{ key: 'private-key-must-not-echo', name: 'bad\nname' }]),
    (error) => error.status === 400 && !error.message.includes('private-key'),
  );
});

test('managed keys: import/deduplicate, hashing, immediate revocation/expiry, rename, paging and management isolation', async () => {
  const { mf, env } = await runtime();
  try {
    let created = await admin(mf, '', 'POST', { name: 'project-A' }, 201);
    assert.match(created.key, /^sk-gcli-[0-9a-f]{64}$/);
    assert.equal((await authenticateApi(request(created.key), env)).id, created.id);
    assert.equal((await authenticateApi(request(created.key), { DB: env.DB })).id, created.id);
    for (const header of ['x-goog-api-key', 'x-api-key'])
      assert.equal((await authenticateApi(request(created.key, header), env)).id, created.id);
    const native = new Request('https://test/v1beta/models?key=' + created.key);
    assert.equal((await authenticateApi(native, env, true)).id, created.id);
    await assert.rejects(authenticateApi(native, env), { status: 401 });
    await assert.rejects(
      authenticateApi(
        new Request(native, {
          headers: { authorization: 'Bearer wrong', 'x-api-key': created.key },
        }),
        env,
        true,
      ),
      { status: 401 },
    );
    assert.equal((await authenticateApi(request(env.API_PASSWORD), env)).id, MASTER_KEY_ID);
    const dbRow = await env.DB.prepare('SELECT * FROM api_keys WHERE id=?')
      .bind(created.id)
      .first();
    assert.equal(dbRow.key_hash, await keyHash(created.key));
    assert.equal(dbRow.key_value, created.key);
    assert.equal((await admin(mf, '/' + created.id + '/reveal', 'POST')).key, created.key);
    assert.equal(dbRow.key_value, created.key);
    const listing = await admin(mf);
    assert.equal(listing.master_enabled, true);
    assert.ok(!JSON.stringify(listing).includes(created.key));
    assert.ok(!JSON.stringify(listing).includes(dbRow.key_hash));
    const noReveal = await mf.dispatchFetch(
      'https://test/admin/api-keys/' + created.id + '/reveal',
      { method: 'POST', headers: { authorization: 'Bearer ' + created.key } },
    );
    assert.equal(noReveal.status, 401);
    const noAdmin = await mf.dispatchFetch('https://test/admin/api-keys', {
      headers: { authorization: 'Bearer ' + created.key },
    });
    assert.equal(noAdmin.status, 401);
    await admin(mf, '/' + created.id, 'PATCH', { name: 'renamed', enabled: false });
    await assert.rejects(authenticateApi(request(created.key), env), { status: 401 });
    assert.deepEqual(
      await admin(mf, '/import', 'POST', { data: [{ key: created.key, name: 'do-not-revive' }] }),
      { imported: 0, duplicates: 1 },
    );
    await assert.rejects(authenticateApi(request(created.key), env), { status: 401 });
    assert.equal((await admin(mf)).keys[0].name, 'renamed');
    await admin(mf, '/' + created.id, 'PATCH', { enabled: true, expires_at: Date.now() - 1 });
    assert.equal((await admin(mf)).keys[0].state, 'expired');
    await assert.rejects(authenticateApi(request(created.key), env), { status: 401 });
    await admin(mf, '/' + created.id, 'PATCH', { expires_at: null });
    assert.equal((await authenticateApi(request(created.key), env)).name, 'renamed');
    await admin(mf, '/import', 'POST', {
      format: 'newapi',
      data: {
        data: [{ key: 'new-api-original-key', name: 'New API 项目', status: 1, expired_time: -1 }],
      },
    });
    const imported = await authenticateApi(request('sk-new-api-original-key'), env);
    assert.equal(imported.name, 'New API 项目');
    assert.equal(
      (await admin(mf, '/' + imported.id + '/reveal', 'POST')).key,
      'sk-new-api-original-key',
    );
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys').first('n');
    await admin(
      mf,
      '/import',
      'POST',
      { data: [{ key: 'valid-batch-key' }, { key: 'masked***key' }] },
      400,
    );
    assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys').first('n'), before);
    await admin(mf, '/import', 'POST', { data: env.API_PASSWORD }, 400);
    await admin(mf, '/import', 'POST', {
      data: Array.from({ length: 51 }, (_, i) => ({
        name: 'paged-' + i,
        key: 'pagination-key-' + i,
      })),
    });
    assert.equal((await admin(mf, '?search=paged')).has_next, true);
    assert.equal((await admin(mf, '?search=paged&page=1')).keys.length, 1);
    await admin(mf, '/' + created.id, 'DELETE');
    await assert.rejects(authenticateApi(request(created.key), env), { status: 401 });
    await admin(mf, '/' + created.id, 'DELETE', undefined, 404);
  } finally {
    await mf.dispose();
  }
});

test('Worker protocols accept managed keys and telemetry isolates per-key totals before and after DO flush and deletion', async () => {
  const { mf, env } = await runtime();
  try {
    const a = await admin(mf, '', 'POST', { name: 'project-A' }, 201),
      b = await admin(mf, '', 'POST', { name: 'project-B' }, 201);
    const row = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'account',
      data: { project_id: 'test', token: 'fake', expiry: '2099-01-01T00:00:00Z' },
    };
    await env.DB.prepare('INSERT INTO credentials(id,mode,name,data,created_at) VALUES(?,?,?,?,?)')
      .bind(row.id, 'antigravity', row.name, JSON.stringify(row.data), Date.now())
      .run();
    const chat = async (key) => {
      const response = await mf.dispatchFetch('https://test/antigravity/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      await response.json();
    };
    await chat(a.key);
    await chat(a.key);
    await chat(b.key);
    await chat(env.API_PASSWORD);
    for (const [path, headers, body] of [
      [
        '/v1/messages/count_tokens',
        { 'x-api-key': a.key },
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      ],
      [
        '/v1beta/models/m:countTokens?key=' + a.key,
        {},
        { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      ],
    ]) {
      const response = await mf.dispatchFetch('https://test' + path, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
    }
    const stats = (key) =>
      usageStats(env.DB, new URLSearchParams({ api_key_id: key, fresh: '1' }), env);
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    assert.equal((await stats(a.id)).summary.requests, 2);
    assert.equal((await stats(a.id)).summary.total_tokens, 10);
    assert.equal((await stats(b.id)).summary.requests, 1);
    assert.equal((await stats(MASTER_KEY_ID)).summary.requests, 1);
    assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM request_usage').first('n'), 0);
    assert.equal((await stub.fetch('https://test/flush', { method: 'POST' })).status, 200);
    assert.equal((await stats(a.id)).summary.requests, 2);
    assert.equal((await stats(b.id)).summary.total_tokens, 5);
    const failed = {
      requestId: randomUUID(),
      row,
      mode: 'antigravity',
      model: 'm',
      status: 502,
      outcome: 'failed',
      started: Date.now() - 10,
      apiKey: { id: a.id, name: a.name },
      attempts: [],
    };
    await recordTelemetry(env, failed);
    assert.equal((await stats(a.id)).summary.failures, 1);
    assert.equal((await stats(a.id)).summary.requests, 3);
    assert.equal((await stub.fetch('https://test/flush', { method: 'POST' })).status, 200);
    assert.equal((await stats(a.id)).summary.requests, 3);
    assert.equal((await stats(a.id)).summary.failures, 1);
    const unknown = {
      ...failed,
      requestId: randomUUID(),
      apiKey: undefined,
      status: 200,
      outcome: 'success',
    };
    await recordUsage(env.DB, unknown);
    assert.equal((await stats(a.id)).summary.requests, 3);
    await admin(mf, '/' + a.id, 'DELETE');
    assert.equal((await stats(a.id)).summary.requests, 3);
    const persisted = await env.DB.prepare('SELECT payload FROM usage_aggregates').all();
    assert.ok(!JSON.stringify(persisted).includes(a.key));
    await assert.rejects(usageStats(env.DB, new URLSearchParams('api_key_id=bad&fresh=1'), env), {
      status: 400,
    });
  } finally {
    await mf.dispose();
  }
});

test('problem view excludes ordinary successes, retains recovered retries and clears only selected scope without changing usage', async () => {
  const { mf, env } = await runtime();
  try {
    const base = {
      row: null,
      mode: 'geminicli',
      model: 'm',
      status: 200,
      outcome: 'success',
      started: Date.now() - 10,
      attempts: [],
    };
    const clean = { ...base, requestId: randomUUID() };
    await recordUsage(env.DB, clean);
    const retry = {
      ...base,
      requestId: randomUUID(),
      attempts: [
        {
          credential_id: null,
          credential_name: 'test',
          mode: 'geminicli',
          model: 'm',
          status: 429,
          stage: 'response_headers',
          detail_code: 'HTTP_429',
          duration_ms: 1,
          created_at: Date.now(),
        },
      ],
    };
    await recordUsage(env.DB, retry);
    await recordUsage(env.DB, {
      ...base,
      requestId: randomUUID(),
      status: 499,
      outcome: 'cancelled',
    });
    const params = new URLSearchParams('issues=1');
    let records = (await queryCallLogs(env.DB, params)).records;
    assert.equal(records.length, 3);
    assert.ok(records.every((r) => r.request_id !== clean.requestId));
    assert.ok(records.some((r) => r.stage === 'completed' && r.retried === 1));
    assert.equal((await queryCallLogs(env.DB, new URLSearchParams())).records.length, 4);
    assert.equal((await queryCallLogs(env.DB, params, true)).records.length, 3);
    await clearCallLogs(env.DB, params, { confirm: 'delete-matching-logs' });
    assert.equal((await queryCallLogs(env.DB, params)).records.length, 0);
    assert.equal(
      (await queryCallLogs(env.DB, new URLSearchParams())).records[0].request_id,
      clean.requestId,
    );
    assert.equal((await usageStats(env.DB, new URLSearchParams('fresh=1'))).summary.requests, 3);
  } finally {
    await mf.dispose();
  }
});

test('unified gateway: model union, cross-channel HTTP/network failover, one usage record, global budget and fixed-mode compatibility', async () => {
  const seen = [];
  let scenario = 'quota';
  const { mf, env } = await runtime(async (request) => {
    if (request.url.includes('fetchAvailableModels'))
      return new OutboundResponse(
        JSON.stringify({ models: { 'gemini-shared': {}, 'claude-only': {} } }),
        { headers: { 'content-type': 'application/json' } },
      );
    if (request.url.includes('retrieveUserQuota'))
      return new OutboundResponse(JSON.stringify({ buckets: [{ modelId: 'gemini-shared' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    const payload = await request.json();
    const mode = request.url.includes('daily-cloudcode') ? 'antigravity' : 'geminicli';
    seen.push({ mode, body: payload, authorization: request.headers.get('authorization') });
    if (scenario === 'quota' && mode === 'geminicli')
      return new OutboundResponse('rate limited', {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    if (scenario === 'network' && mode === 'geminicli')
      throw new Error('simulated transport failure');
    if (scenario === 'all-fail') return new OutboundResponse('unavailable', { status: 503 });
    if (scenario === 'bad-request') return new OutboundResponse('invalid request', { status: 400 });
    return new OutboundResponse(
      JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: 'unified works' }] }, finishReason: 'STOP' }],
          usageMetadata: { totalTokenCount: 7 },
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  try {
    const a = '11111111-1111-4111-8111-111111111111',
      b = '22222222-2222-4222-8222-222222222222';
    for (const [id, mode, token] of [
      [a, 'geminicli', 'cli-test-token'],
      [b, 'antigravity', 'anti-test-token'],
    ])
      await env.DB.prepare(
        'INSERT INTO credentials(id,mode,name,data,created_at,priority)VALUES(?,?,?,?,?,?)',
      )
        .bind(
          id,
          mode,
          mode,
          JSON.stringify({ token, project_id: mode + '-project', expiry: '2099-01-01T00:00:00Z' }),
          Date.now(),
          mode === 'geminicli' ? 10 : 0,
        )
        .run();
    const setting = async (patch) => {
      const r = await mf.dispatchFetch('https://test/admin/settings', {
        method: 'PATCH',
        headers: { authorization: 'Bearer local-panel-only', 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      assert.equal(r.status, 200, await r.clone().text());
    };
    await setting({
      CREDENTIAL_SELECTION: 'priority',
      MAX_CREDENTIAL_ATTEMPTS: 3,
    });
    const list = await mf.dispatchFetch('https://test/v1/models', {
      headers: { authorization: 'Bearer local-master-only' },
    });
    assert.deepEqual(
      (await list.json()).data.map((row) => row.id),
      ['claude-only', 'gemini-shared'],
    );
    const chat = async (path = '/v1/chat/completions', model = 'gemini-shared') =>
      mf.dispatchFetch('https://test' + path, {
        method: 'POST',
        headers: { authorization: 'Bearer local-master-only', 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'local only' }] }),
      });
    let response = await chat();
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-upstream-channel'), 'antigravity');
    await response.json();
    assert.deepEqual(
      seen.map((row) => row.mode),
      ['geminicli', 'antigravity'],
    );
    assert.equal(seen[0].body.project, 'geminicli-project');
    assert.equal(seen[1].body.project, 'antigravity-project');
    assert.equal(seen[1].body.userAgent, 'antigravity');
    let stats = await usageStats(env.DB, new URLSearchParams('fresh=1'), env);
    assert.equal(stats.summary.requests, 1);
    assert.equal(stats.summary.successes, 1);
    assert.equal(stats.summary.total_tokens, 7);
    const logs = await queryCallLogs(env.DB, new URLSearchParams('issues=1'));
    assert.ok(logs.records.some((row) => row.mode === 'geminicli' && row.status === 429));
    assert.ok(logs.records.some((row) => row.mode === 'antigravity' && row.stage === 'completed'));
    assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM request_usage').first('n'), 1);
    await env.DB.exec('DELETE FROM credential_cooldowns');
    scenario = 'network';
    seen.length = 0;
    response = await chat();
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    assert.deepEqual(
      seen.map((row) => row.mode),
      ['geminicli', 'antigravity'],
    );
    scenario = 'bad-request';
    seen.length = 0;
    response = await chat();
    assert.equal(response.status, 400);
    assert.equal(seen.length, 1);
    await response.text();
    scenario = 'all-fail';
    await setting({ MAX_CREDENTIAL_ATTEMPTS: 1 });
    await env.DB.exec('DELETE FROM credential_cooldowns');
    seen.length = 0;
    response = await chat();
    assert.equal(response.status, 503);
    assert.equal(seen.length, 1);
    await response.text();
    scenario = 'ok';
    await env.DB.exec('DELETE FROM credential_cooldowns');
    seen.length = 0;
    response = await chat('/geminicli/v1/chat/completions');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-upstream-channel'), 'geminicli');
    await response.text();
    assert.equal(seen[0].mode, 'geminicli');
    seen.length = 0;
    response = await chat('/v1/chat/completions', 'claude-only');
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    assert.equal(seen[0].mode, 'antigravity');
    await env.DB.prepare('UPDATE credentials SET disabled=1 WHERE id=?').bind(a).run();
    seen.length = 0;
    response = await chat();
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    assert.equal(seen[0].mode, 'antigravity');
  } finally {
    await mf.dispose();
  }
});
