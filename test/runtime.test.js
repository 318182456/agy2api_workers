import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pruneTelemetry } from '../src/telemetry/maintenance.js';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

// Real Workers runtime and D1, with only Google mocked. No production bindings.
test('Workers runtime: incoming request signal, real D1, quota and OAuth failure handling', async () => {
  const result = await build({
    entryPoints: ['test/runtime.fixture.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  const mf = new Miniflare({
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    d1Databases: { DB: 'runtime-test' },
    log: new Log(LogLevel.NONE),
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of [
      '0001_credentials.sql',
      '0002_oauth.sql',
      '0003_reliability.sql',
      '0004_settings.sql',
      '0005_operations.sql',
      '0006_d1_budget.sql',
      '0007_packed_diagnostics.sql',
      '0008_usage_aggregates.sql',
      '0009_api_keys.sql',
      '0014_telemetry_incremental.sql',
      '0015_request_failure_details.sql',
    ])
      await db.exec((await readFile('migrations/' + name, 'utf8')).replaceAll('\n', ' '));
    const id = '11111111-1111-4111-8111-111111111111';
    const data = { project_id: 'test', token: 'fake-token', expiry: '2099-01-01T00:00:00Z' };
    await db
      .prepare('INSERT INTO credentials (id, mode, name, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, 'antigravity', 'test', JSON.stringify(data), 1)
      .run();
    const chat = (scenario) =>
      mf.dispatchFetch('https://test/antigravity/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-api',
          'content-type': 'application/json',
          'x-test-scenario': scenario || '',
        },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      });
    let response = await chat();
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).choices[0].message.content, 'runtime works');
    response = await mf.dispatchFetch('https://test/admin/credentials/' + id + '/quota', {
      headers: { authorization: 'Bearer local-panel' },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).models[0].remaining, 0.8);
    response = await chat('generation-network-failure');
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.stage, 'generation_fetch');
    await db
      .prepare('UPDATE credentials SET data=? WHERE id=?')
      .bind(
        JSON.stringify({ ...data, expiry: '2000-01-01T00:00:00Z', refresh_token: 'fake-refresh' }),
        id,
      )
      .run();
    response = await mf.dispatchFetch('https://test/admin/credentials/' + id + '/quota', {
      headers: { authorization: 'Bearer local-panel', 'x-test-scenario': 'oauth-network-failure' },
    });
    assert.equal(response.status, 502);
    const failure = await response.json();
    assert.equal(failure.error.stage, 'oauth_refresh');
    assert.equal(failure.error.reason, 'UPSTREAM_CONNECTION_FAILED');
    assert.ok(failure.error.request_id);
    assert.doesNotMatch(JSON.stringify(failure), /fake-refresh|secret-do-not-log/);
  } finally {
    await mf.dispose();
  }
});

test('production Worker entrypoint sends real fetch calls instead of treating ExecutionContext as fetcher', async () => {
  const { Response: OutboundResponse } = await import('miniflare');
  const result = await build({
    entryPoints: ['src/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  const seen = [];
  let failEnrichment = false;
  const mf = new Miniflare({
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: {
      API_PASSWORD: 'local-api',
      PANEL_PASSWORD: 'local-panel',
      ANTIGRAVITY_STREAM2NOSTREAM: false,
      ANTIGRAVITY_CLIENT_ID: 'test-antigravity-client',
      ANTIGRAVITY_CLIENT_SECRET: 'test-antigravity-secret',
    },
    d1Databases: { DB: 'production-entrypoint-test' },
    log: new Log(LogLevel.NONE),
    outboundService: async (request) => {
      seen.push(request.url);
      if (request.url === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(await request.text());
        if (form.get('grant_type') === 'authorization_code') {
          assert.ok(form.get('code_verifier').length >= 43);
          assert.equal(form.get('redirect_uri'), 'http://localhost:11451');
        }
        return new OutboundResponse(
          JSON.stringify({
            access_token: 'fresh-runtime-token',
            expires_in: 3600,
            ...(form.get('grant_type') === 'authorization_code'
              ? { refresh_token: 'oauth-refresh-test' }
              : {}),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      assert.equal(request.headers.get('authorization'), 'Bearer fresh-runtime-token');
      if (request.url.includes('userinfo'))
        return new OutboundResponse(
          JSON.stringify(failEnrichment ? {} : { email: 'account@example.test' }),
          { status: failEnrichment ? 403 : 200, headers: { 'content-type': 'application/json' } },
        );
      if (request.url.includes('loadCodeAssist'))
        return new OutboundResponse(
          JSON.stringify(
            failEnrichment
              ? {}
              : {
                  cloudaicompanionProject: 'discovered-project',
                  currentTier: { id: 'free' },
                  paidTier: { id: 'pro', availableCredits: [{ creditAmount: '25' }] },
                },
          ),
          { status: failEnrichment ? 403 : 200, headers: { 'content-type': 'application/json' } },
        );
      if (request.url.includes('fetchAvailableModels'))
        return new OutboundResponse(
          JSON.stringify({ models: { m: { quotaInfo: { remainingFraction: 0.6 } } } }),
          { headers: { 'content-type': 'application/json' } },
        );
      return new OutboundResponse(
        JSON.stringify({
          response: {
            candidates: [
              { content: { parts: [{ text: 'production entry works' }] }, finishReason: 'STOP' },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of [
      '0001_credentials.sql',
      '0002_oauth.sql',
      '0003_reliability.sql',
      '0004_settings.sql',
      '0005_operations.sql',
      '0006_d1_budget.sql',
      '0007_packed_diagnostics.sql',
      '0008_usage_aggregates.sql',
      '0009_api_keys.sql',
      '0014_telemetry_incremental.sql',
      '0015_request_failure_details.sql',
    ])
      await db.exec((await readFile('migrations/' + name, 'utf8')).replaceAll('\n', ' '));
    const id = '11111111-1111-4111-8111-111111111111';
    await db
      .prepare('INSERT INTO credentials (id, mode, name, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(
        id,
        'antigravity',
        'test',
        JSON.stringify({ project_id: 'p', refresh_token: 'r', client_id: 'c', client_secret: 's' }),
        1,
      )
      .run();
    const login = await mf.dispatchFetch('https://test/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://test' },
      body: JSON.stringify({ password: 'local-panel' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^__Host-gcli_session=/);
    let response = await mf.dispatchFetch('https://test/auth/session', { headers: { cookie } });
    assert.equal((await response.json()).authenticated, true);
    response = await mf.dispatchFetch('https://test/admin/credentials/' + id + '/quota', {
      headers: { cookie },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).models[0].remaining, 0.6);
    response = await mf.dispatchFetch('https://test/antigravity/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer local-api', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).choices[0].message.content, 'production entry works');
    assert.equal(seen.length, 3);
    assert.equal(seen[0], 'https://oauth2.googleapis.com/token');
    assert.match(seen[1], /fetchAvailableModels/);
    assert.match(seen[2], /generateContent/);
    response = await mf.dispatchFetch('https://test/antigravity/v1/models', {
      headers: { authorization: 'Bearer local-api' },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-model-list-source'), 'google');
    assert.equal((await response.json()).data[0].id, 'm');
    response = await mf.dispatchFetch('https://test/admin/models?mode=antigravity', {
      headers: { cookie },
    });
    assert.equal((await response.json()).source, 'google');
    const adminPost = (path, body = {}) =>
      mf.dispatchFetch('https://test' + path, {
        method: 'POST',
        headers: { cookie, origin: 'https://test', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    response = await adminPost('/admin/oauth/start', { mode: 'antigravity' });
    assert.equal(response.status, 200, await response.clone().text());
    const start = await response.json();
    const authUrl = new URL(start.auth_url);
    assert.equal(authUrl.hostname, 'accounts.google.com');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authUrl.searchParams.has('code_verifier'), false);
    const callback =
      'http://localhost:11451/?code=test-code&state=' + authUrl.searchParams.get('state');
    response = await adminPost('/admin/oauth/complete', { callback_url: callback });
    assert.equal(response.status, 200, await response.clone().text());
    const account = await response.json();
    assert.equal(account.user_email, 'account@example.test');
    assert.equal(account.project_id, 'discovered-project');
    assert.deepEqual(account.warnings, []);
    assert.equal(JSON.stringify(account).includes('oauth-refresh-test'), false);
    const beforeReplay = seen.length;
    assert.equal(
      (await adminPost('/admin/oauth/complete', { callback_url: callback })).status,
      400,
    );
    assert.equal(seen.length, beforeReplay);
    response = await mf.dispatchFetch('https://test/admin/credentials', { headers: { cookie } });
    const metadata = (await response.json()).credentials.find((row) => row.id === account.id);
    assert.equal(metadata.user_email, 'account@example.test');
    assert.equal(metadata.subscription_tier, 'pro');
    assert.equal(metadata.credit_amount, '25');
    assert.equal(JSON.stringify(metadata).includes('oauth-refresh-test'), false);
    response = await adminPost('/admin/credentials/' + account.id + '/test');
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).success, true);
    response = await adminPost('/admin/credentials/' + account.id + '/email');
    assert.equal((await response.json()).user_email, 'account@example.test');
    response = await adminPost('/admin/credentials/' + account.id + '/verify');
    assert.equal((await response.json()).project_id, 'discovered-project');
    response = await mf.dispatchFetch(
      'https://test/admin/credentials/' + account.id + '/download',
      { headers: { cookie } },
    );
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.equal((await response.json()).refresh_token, 'oauth-refresh-test');
    // Preserve tokens if optional Google identity/project APIs fail after authorization.
    failEnrichment = true;
    response = await adminPost('/admin/oauth/start', {
      mode: 'antigravity',
      project_id: 'manual-project',
    });
    const again = new URL((await response.json()).auth_url);
    response = await adminPost('/admin/oauth/complete', {
      callback_url: 'http://localhost:11451/?code=another&state=' + again.searchParams.get('state'),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const partial = await response.json();
    assert.equal(partial.warnings.length, 2);
    assert.equal(partial.project_id, 'manual-project');
    const saved = await db
      .prepare('SELECT data FROM credentials WHERE id=?')
      .bind(partial.id)
      .first();
    assert.equal(JSON.parse(saved.data).refresh_token, 'oauth-refresh-test');
    response = await adminPost('/admin/oauth/start', { mode: 'antigravity' });
    const expired = new URL((await response.json()).auth_url);
    await db
      .prepare('UPDATE oauth_flows SET expires_at=0 WHERE state=?')
      .bind(expired.searchParams.get('state'))
      .run();
    assert.equal(
      (
        await adminPost('/admin/oauth/complete', {
          callback_url:
            'http://localhost:11451/?code=expired&state=' + expired.searchParams.get('state'),
        })
      ).status,
      400,
    );
    response = await mf.dispatchFetch('https://test/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://test' },
    });
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    await mf.dispose();
  }
});

test('production Worker: credential failover, model cooldown, trace records and stream interruption', async () => {
  const { Response: OutboundResponse } = await import('miniflare');
  const result = await build({
    entryPoints: ['src/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  let scenario = 'fail-first';
  const calls = [];
  const mf = new Miniflare({
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: { API_PASSWORD: 'a', PANEL_PASSWORD: 'p', ANTIGRAVITY_STREAM2NOSTREAM: false },
    d1Databases: { DB: 'failover-test' },
    log: new Log(LogLevel.NONE),
    outboundService: async (request) => {
      const token = request.headers.get('authorization');
      const body = JSON.parse(await request.text());
      calls.push({ token, model: body.model });
      let status = 200;
      if (scenario === 'fail-first' && token === 'Bearer token-a') status = 429;
      if (scenario === 'transient' && calls.length === 1) status = 503;
      if (scenario === 'forbidden') status = 403;
      if (scenario === 'all-limited') status = 429;
      if (status !== 200)
        return new OutboundResponse(JSON.stringify({ error: { message: 'upstream failure' } }), {
          status,
          headers: { 'content-type': 'application/json', 'retry-after': '120' },
        });
      const value = {
        response: {
          candidates: [
            {
              content: { parts: [{ text: 'ok' }] },
              ...(scenario === 'truncated' ? {} : { finishReason: 'STOP' }),
            },
          ],
        },
      };
      if (body.request.generationConfig?.maxOutputTokens)
        assert.equal(body.request.generationConfig.maxOutputTokens, 10);
      return new OutboundResponse(
        scenario === 'truncated'
          ? 'data: ' + JSON.stringify(value) + '\n\n'
          : JSON.stringify(value),
        {
          headers: {
            'content-type': scenario === 'truncated' ? 'text/event-stream' : 'application/json',
          },
        },
      );
    },
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of [
      '0001_credentials.sql',
      '0002_oauth.sql',
      '0003_reliability.sql',
      '0004_settings.sql',
      '0005_operations.sql',
      '0006_d1_budget.sql',
      '0007_packed_diagnostics.sql',
      '0008_usage_aggregates.sql',
      '0009_api_keys.sql',
      '0014_telemetry_incremental.sql',
      '0015_request_failure_details.sql',
    ])
      await db.exec((await readFile('migrations/' + name, 'utf8')).replaceAll('\n', ' '));
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    for (const [id, token] of [
      [a, 'token-a'],
      [b, 'token-b'],
    ])
      await db
        .prepare(
          'INSERT INTO credentials (id, mode, name, data, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          'antigravity',
          id,
          JSON.stringify({ project_id: 'p', token, expiry: '2099-01-01T00:00:00Z' }),
          1,
        )
        .run();
    const chat = (model = 'm', stream = false) =>
      mf.dispatchFetch('https://test/antigravity/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'secret-prompt-not-to-log' }],
        }),
      });
    const admin = (path, method = 'GET') =>
      mf.dispatchFetch('https://test' + path, { method, headers: { authorization: 'Bearer p' } });
    let response = await chat();
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
      calls.map((call) => call.token),
      ['Bearer token-a', 'Bearer token-b'],
    );
    const requestId = response.headers.get('x-request-id');
    response = await admin('/admin/calls');
    const records = (await response.json()).records;
    assert.deepEqual(
      records.map((row) => row.status),
      [200, 429],
    );
    assert.equal(records[0].stage, 'completed');
    assert.ok(records.every((row) => row.request_id === requestId));
    assert.doesNotMatch(JSON.stringify(records), /token-a|token-b|secret-prompt/);
    const cooldown = await db
      .prepare('SELECT * FROM credential_cooldowns WHERE credential_id=? AND model=?')
      .bind(a, 'm')
      .first();
    assert.equal(cooldown.status, 429);
    assert.ok(cooldown.until_ms > Date.now() + 100000);
    scenario = 'ok';
    calls.length = 0;
    await db.prepare('UPDATE credentials SET last_used=0').run();
    assert.equal((await chat()).status, 200);
    assert.equal(calls[0].token, 'Bearer token-b');
    calls.length = 0;
    await db.prepare('UPDATE credentials SET last_used=0').run();
    assert.equal((await chat('other-model')).status, 200);
    assert.equal(calls[0].token, 'Bearer token-a');
    await db
      .prepare(
        'INSERT INTO credential_cooldowns (credential_id, model, until_ms, status) VALUES (?, ?, ?, ?)',
      )
      .bind(b, 'm', Date.now() + 120000, 429)
      .run();
    calls.length = 0;
    response = await chat();
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal(calls.length, 0);
    assert.equal((await admin('/admin/credentials/' + a + '/cooldowns', 'DELETE')).status, 200);
    assert.equal((await chat()).status, 200);
    scenario = 'transient';
    calls.length = 0;
    await db.prepare('DELETE FROM credential_cooldowns').run();
    await db.prepare('UPDATE credentials SET last_used=0').run();
    assert.equal((await chat()).status, 200);
    assert.equal(calls.length, 2);
    scenario = 'forbidden';
    calls.length = 0;
    await db.prepare('DELETE FROM credential_cooldowns').run();
    response = await chat();
    assert.equal(response.status, 403);
    assert.equal(calls.length, 1);
    assert.equal(
      (await db.prepare('SELECT COUNT(*) AS total FROM credentials WHERE disabled=1').first())
        .total,
      0,
    );
    scenario = 'all-limited';
    calls.length = 0;
    response = await chat();
    assert.equal(response.status, 429);
    assert.equal(calls.length, 2);
    assert.equal(response.headers.get('retry-after'), '120');
    assert.match(await response.text(), /upstream failure/);
    scenario = 'truncated';
    calls.length = 0;
    await db.prepare('DELETE FROM credential_cooldowns').run();
    response = await chat('m', true);
    const streamed = await response.text();
    assert.match(streamed, /upstream_error/);
    assert.doesNotMatch(streamed, /\[DONE\]/);
    assert.equal(calls.length, 1);
    response = await admin('/admin/calls');
    assert.equal((await response.json()).records[0].stage, 'stream_error');
    response = await admin('/admin/calls?credential_id=' + a);
    assert.ok((await response.json()).records.every((row) => row.credential_id === a));
    // Exercise cursor pagination and bounded retention with a real SQLite/D1 index.
    await db.exec(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2050) INSERT INTO call_logs (request_id,mode,model,status,stage,duration_ms,created_at) SELECT 'seed','antigravity','seed',200,'response_headers',0," +
        String(Date.now() - 1000) +
        ' FROM n',
    );
    scenario = 'ok';
    assert.equal((await chat()).status, 200);
    await pruneTelemetry(db);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM call_logs').first()).count, 2000);
    response = await admin('/admin/calls');
    const page = await response.json();
    assert.equal(page.records.length, 50);
    assert.ok(page.next);
    response = await admin('/admin/calls?before=' + page.next);
    assert.ok(
      (await response.json()).records.every(
        (row) =>
          !page.records.some(
            (previous) => previous.id === row.id && previous.event_source === row.event_source,
          ),
      ),
    );
    const target = page.records[0].credential_id;
    const patch = (body) =>
      mf.dispatchFetch('https://test/admin/credentials/' + target, {
        method: 'PATCH',
        headers: { authorization: 'Bearer p', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const originalData = await db
      .prepare('SELECT data FROM credentials WHERE id=?')
      .bind(target)
      .first();
    response = await patch({ name: 'My account' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).name, 'My account');
    assert.equal(
      (await db.prepare('SELECT data FROM credentials WHERE id=?').bind(target).first()).data,
      originalData.data,
    );
    response = await admin('/admin/calls?credential_id=' + target);
    assert.equal((await response.json()).records[0].display_name, 'My account');
    response = await patch({ name: target === a ? b : a });
    assert.equal(response.status, 409);
    const withEmail = { ...JSON.parse(originalData.data), user_email: 'readable@example.test' };
    await db
      .prepare('UPDATE credentials SET data=? WHERE id=?')
      .bind(JSON.stringify(withEmail), target)
      .run();
    response = await admin('/admin/calls?credential_id=' + target);
    let named = (await response.json()).records[0];
    assert.equal(named.display_name, 'readable@example.test');
    assert.equal(named.credential_name, 'My account');
    assert.doesNotMatch(JSON.stringify(named), /token-a|token-b/);
    await db.prepare('UPDATE credentials SET disabled=1 WHERE id<>?').bind(target).run();
    assert.equal((await chat()).status, 200);
    assert.equal((await admin('/admin/credentials/' + target, 'DELETE')).status, 200);
    response = await admin('/admin/calls?credential_id=' + target);
    named = (await response.json()).records[0];
    assert.equal(named.display_name, 'readable@example.test');
  } finally {
    await mf.dispose();
  }
});

test('production Worker: web settings take effect, backups restore state, duplicate grouping stays within channel', async () => {
  const { Response: OutboundResponse } = await import('miniflare');
  const bundle = await build({
    entryPoints: ['src/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  let generations = 0;
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: {
      API_PASSWORD: 'api',
      PANEL_PASSWORD: 'panel',
      MAX_CREDENTIAL_ATTEMPTS: '3',
    },
    d1Databases: { DB: 'settings-backup-test' },
    log: new Log(LogLevel.NONE),
    outboundService: async (request) => {
      if (request.url.includes('fetchAvailableModels'))
        return new OutboundResponse('{}', { status: 403 });
      generations++;
      return new OutboundResponse('{"error":{"message":"limited"}}', { status: 429 });
    },
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of [
      '0001_credentials.sql',
      '0002_oauth.sql',
      '0003_reliability.sql',
      '0004_settings.sql',
      '0005_operations.sql',
      '0006_d1_budget.sql',
      '0007_packed_diagnostics.sql',
      '0008_usage_aggregates.sql',
      '0009_api_keys.sql',
      '0014_telemetry_incremental.sql',
      '0015_request_failure_details.sql',
    ])
      await db.exec((await readFile('migrations/' + name, 'utf8')).replaceAll('\n', ' '));
    const admin = (path, method = 'GET', body) =>
      mf.dispatchFetch('https://test' + path, {
        method,
        headers: { authorization: 'Bearer panel', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let response = await admin('/admin/settings');
    assert.equal((await response.json()).effective.MAX_CREDENTIAL_ATTEMPTS, 3);
    response = await admin('/admin/settings', 'PATCH', {
      MAX_CREDENTIAL_ATTEMPTS: 1,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const setting = await response.json();
    assert.equal(setting.effective.MAX_CREDENTIAL_ATTEMPTS, 1);
    assert.equal(setting.defaults.MAX_CREDENTIAL_ATTEMPTS, 3);
    assert.equal(JSON.stringify(setting).includes('PANEL_PASSWORD'), false);
    response = await admin('/admin/settings', 'PATCH', {
      MAX_CREDENTIAL_ATTEMPTS: 2,
      API_PASSWORD: 'not-allowed',
    });
    assert.equal(response.status, 400);
    assert.equal(
      (await (await admin('/admin/settings')).json()).effective.MAX_CREDENTIAL_ATTEMPTS,
      1,
    );
    response = await mf.dispatchFetch('https://test/geminicli/v1/models', {
      headers: { authorization: 'Bearer api' },
    });
    assert.equal(response.status, 503); // No enabled GeminiCLI credential yet.
    const credential = {
      project_id: 'p',
      token: 'fake-token',
      expiry: '2099-01-01T00:00:00Z',
      user_email: 'ACCOUNT@example.test',
    };
    for (const item of [
      { name: 'active', mode: 'antigravity', disabled: false },
      { name: 'disabled', mode: 'antigravity', disabled: true },
      { name: 'cli', mode: 'geminicli', disabled: false },
    ]) {
      response = await admin('/admin/credentials', 'POST', { ...item, credential });
      assert.equal(response.status, 201, await response.clone().text());
    }
    let rows = (await (await admin('/admin/credentials')).json()).credentials;
    const inactive = rows.find((item) => item.name === 'disabled');
    response = await admin('/admin/duplicates');
    const duplicates = await response.json();
    assert.equal(duplicates.groups.length, 1);
    assert.equal(duplicates.groups[0].keep.name, 'active');
    assert.equal(duplicates.groups[0].duplicates[0].name, 'disabled');
    assert.equal(JSON.stringify(duplicates).includes('fake-token'), false);
    // Restore export through the same individual import endpoint used by the UI batch runner.
    const downloaded = await (
      await admin('/admin/credentials/' + inactive.id + '/download')
    ).json();
    await admin('/admin/credentials/' + inactive.id, 'DELETE');
    assert.equal(
      (
        await admin('/admin/credentials', 'POST', {
          name: 'disabled',
          mode: 'antigravity',
          disabled: true,
          credential: downloaded,
        })
      ).status,
      201,
    );
    rows = (await (await admin('/admin/credentials')).json()).credentials;
    assert.equal(rows.find((item) => item.name === 'disabled').disabled, 1);
    assert.equal(rows.find((item) => item.name === 'disabled').user_email, 'ACCOUNT@example.test');
    // A normal import without disabled must preserve existing manual stop state.
    await admin('/admin/credentials', 'POST', {
      name: 'disabled',
      mode: 'antigravity',
      credential: downloaded,
    });
    rows = (await (await admin('/admin/credentials')).json()).credentials;
    assert.equal(rows.find((item) => item.name === 'disabled').disabled, 1);
    await admin('/admin/credentials/' + rows.find((item) => item.name === 'disabled').id, 'PATCH', {
      disabled: false,
    });
    response = await mf.dispatchFetch('https://test/antigravity/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer api', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 429);
    assert.equal(generations, 1);
    response = await mf.dispatchFetch('https://test/antigravity/v1/models', {
      headers: { authorization: 'Bearer api' },
    });
    assert.equal(response.status, 403); // No manually configured fallback list.
    response = await admin('/admin/settings', 'PATCH', {
      MAX_CREDENTIAL_ATTEMPTS: null,
    });
    assert.equal((await response.json()).effective.MAX_CREDENTIAL_ATTEMPTS, 3);
  } finally {
    await mf.dispose();
  }
});

test('production Worker: Messages works on both channels with SDK headers, SSE, errors and local counts', async () => {
  const { Response: OutboundResponse } = await import('miniflare');
  const bundle = await build({
    entryPoints: ['src/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  let scenario = 'ok';
  let outbound = 0;
  let receivedResult = false;
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: { API_PASSWORD: 'api', PANEL_PASSWORD: 'panel' },
    d1Databases: { DB: 'messages-test' },
    log: new Log(LogLevel.NONE),
    outboundService: async (request) => {
      outbound++;
      const body = JSON.parse(await request.text());
      assert.equal(body.request.generationConfig.maxOutputTokens, 32);
      if (request.url.includes('daily-cloudcode-pa')) {
        assert.equal(request.headers.get('authorization'), 'Bearer anti-token');
        if (body.request.tools) assert.ok(body.request.tools[0].functionDeclarations[0].parameters);
        if (body.model === 'claude-opus-4-6-thinking')
          assert.ok(request.url.includes('streamGenerateContent'));
      } else assert.equal(request.headers.get('authorization'), 'Bearer cli-token');
      if (
        body.request.contents.some((content) => content.parts.some((part) => part.functionResponse))
      )
        receivedResult = true;
      if (scenario === 'limited')
        return new OutboundResponse('{"error":{"message":"test rate limit"}}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        });
      const value = {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'hello' },
                  {
                    functionCall: { name: 'f', args: { x: 1 } },
                    thoughtSignature: 'actual-google-signature',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
        },
      };
      if (request.url.includes('streamGenerateContent')) {
        if (scenario === 'truncated') delete value.response.candidates[0].finishReason;
        return new OutboundResponse('data: ' + JSON.stringify(value) + '\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new OutboundResponse(JSON.stringify(value), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of [
      '0001_credentials.sql',
      '0002_oauth.sql',
      '0003_reliability.sql',
      '0004_settings.sql',
      '0005_operations.sql',
      '0006_d1_budget.sql',
      '0007_packed_diagnostics.sql',
      '0008_usage_aggregates.sql',
      '0009_api_keys.sql',
      '0014_telemetry_incremental.sql',
      '0015_request_failure_details.sql',
    ])
      await db.exec((await readFile('migrations/' + name, 'utf8')).replaceAll('\n', ' '));
    for (const [id, mode, token] of [
      ['11111111-1111-4111-8111-111111111111', 'antigravity', 'anti-token'],
      ['22222222-2222-4222-8222-222222222222', 'geminicli', 'cli-token'],
    ])
      await db
        .prepare(
          'INSERT INTO credentials (id, mode, name, data, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          mode,
          mode,
          JSON.stringify({ project_id: 'p', token, expiry: '2099-01-01T00:00:00Z' }),
          1,
        )
        .run();
    const base = {
      model: 'actual-model',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
    };
    const send = (path, body) =>
      mf.dispatchFetch('https://test' + path, {
        method: 'POST',
        headers: {
          'x-api-key': 'api',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    for (const prefix of ['', '/antigravity']) {
      let response = await send(prefix + '/v1/messages', base);
      assert.equal(response.status, 200, await response.clone().text());
      const message = await response.json();
      assert.equal(message.type, 'message');
      assert.equal(message.stop_reason, 'tool_use');
      assert.equal(message.usage.input_tokens, 10);
      assert.equal(
        message.content[1].extra_content.google.thought_signature,
        'actual-google-signature',
      );
      response = await send(prefix + '/v1/messages', {
        ...base,
        messages: [
          ...base.messages,
          { role: 'assistant', content: message.content },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: message.content[1].id, content: 'done' }],
          },
        ],
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(receivedResult, true);
      response = await send(prefix + '/v1/messages', { ...base, stream: true });
      const sse = await response.text();
      assert.match(sse, /event: message_start/);
      assert.match(sse, /event: content_block_delta/);
      assert.match(sse, /event: message_stop/);
      assert.doesNotMatch(sse, /\[DONE\]/);
    }
    let setting = await mf.dispatchFetch('https://test/admin/settings', {
      method: 'PATCH',
      headers: { authorization: 'Bearer panel', 'content-type': 'application/json' },
      body: JSON.stringify({ ANTIGRAVITY_STREAM2NOSTREAM: true }),
    });
    assert.equal(setting.status, 200);
    for (const [path, body] of [
      ['/v1/messages', base],
      [
        '/v1/chat/completions',
        { model: 'claude-opus-4-6', messages: base.messages, max_tokens: 32 },
      ],
      [
        '/v1beta/models/actual-model:generateContent',
        {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 32 },
        },
      ],
    ]) {
      const collected = await send('/antigravity' + path, body);
      assert.equal(collected.status, 200, await collected.clone().text());
      assert.equal(collected.headers.get('x-upstream-mode'), 'stream-collected');
      assert.match(await collected.text(), /hello/);
    }
    scenario = 'truncated';
    const beforeTruncation = outbound;
    const truncated = await send('/antigravity/v1/messages', base);
    assert.equal(truncated.status, 502);
    assert.equal((await truncated.json()).error.stage, 'stream_collection');
    assert.equal(outbound, beforeTruncation + 1);
    scenario = 'limited';
    let response = await send('/antigravity/v1/messages', base);
    assert.equal(response.status, 429);
    const failure = await response.json();
    assert.equal(failure.type, 'error');
    assert.equal(failure.error.type, 'rate_limit_error');
    assert.equal(failure.error.message, 'test rate limit');
    assert.equal(response.headers.get('retry-after'), '30');
    await db.prepare('DELETE FROM credential_cooldowns').run();
    scenario = 'truncated';
    response = await send('/antigravity/v1/messages', { ...base, stream: true });
    const errorStream = await response.text();
    assert.match(errorStream, /event: error/);
    assert.doesNotMatch(errorStream, /event: message_stop/);
    const countBefore = outbound;
    response = await send('/antigravity/v1/messages/count_tokens', {
      model: 'actual-model',
      messages: base.messages,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-token-count-estimated'), 'true');
    assert.ok((await response.json()).input_tokens > 0);
    assert.equal(outbound, countBefore);
  } finally {
    await mf.dispose();
  }
});

test('active location probe constructs supported Requests inside workerd and refuses upstream redirects', async () => {
  const { Response: RuntimeResponse } = await import('miniflare');
  const bundle = (
    await build({
      entryPoints: ['src/index.js'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    })
  ).outputFiles[0].text;
  let calls = 0,
    redirect = false;
  const mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate: '2025-09-01',
    bindings: { PANEL_PASSWORD: 'local-probe-fixture' },
    log: new Log(LogLevel.NONE),
    outboundService: async (request) => {
      calls++;
      assert.equal(request.url, 'https://www.cloudflare.com/cdn-cgi/trace');
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(request.headers.get('cookie'), null);
      return redirect
        ? new RuntimeResponse('', {
            status: 302,
            headers: { location: 'https://unexpected.example/' },
          })
        : new RuntimeResponse('loc=JP\ncolo=NRT\nip=PRIVATE_IP');
    },
  });
  try {
    const send = () =>
      mf.dispatchFetch('https://test/admin/runtime-location', {
        headers: { authorization: 'Bearer local-probe-fixture' },
      });
    const response = await send();
    assert.equal(response.status, 200, await response.clone().text());
    const value = await response.json();
    assert.equal(value.country, 'JP');
    assert.equal(value.probe_colo, 'NRT');
    assert.equal(value.execution_colo, null);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(value).includes('PRIVATE'));
    redirect = true;
    const rejected = await send();
    assert.equal(rejected.status, 503);
    const error = (await rejected.json()).error;
    assert.equal(error.reason, 'REGION_PROBE_HTTP_302');
    assert.equal(error.stage, 'runtime_location');
    assert.equal(calls, 2); // Do not follow a redirect to another host.
  } finally {
    await mf.dispose();
  }
});
