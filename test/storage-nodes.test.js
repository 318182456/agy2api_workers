import { StorageScheduler, leastUsedNode, storageSchedule } from '../src/storage/schedule.js';
import { nodeUsage } from '../src/storage/usage.js';
import { usageStats } from '../src/telemetry/stats.js';
import { dbCache } from '../src/cache/db.js';
import {
  readNodeCache,
  writeNodeCache,
  nodeSchedule,
  storageNodes,
  resetStorageNodes,
  invalidateNodeCaches,
} from '../src/storage/client.js';
import { cachedQuota, saveQuotaCache } from '../src/telemetry/client.js';
import { build } from 'esbuild';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { handleRequest } from '../src/index.js';
import { storageNodeSource, storagePagesSource } from '../src/storage/node-worker.js';
globalThis.crypto ||= webcrypto;
const account = 'a'.repeat(32),
  token = 'fixture_token_12345678901234567890';
async function database(fn) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2025-09-01',
    d1Databases: ['DB'],
    log: new Log(LogLevel.NONE),
  });
  try {
    const DB = await mf.getD1Database('DB');
    for (const file of (await readdir('migrations')).filter((f) => f.endsWith('.sql')).sort())
      await DB.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
    await fn({ DB, PANEL_PASSWORD: 'fixture-panel' });
  } finally {
    await mf.dispose();
  }
}
const request = (path = '', method = 'GET', body) =>
  new Request('https://test/admin/storage-nodes' + path, {
    method,
    headers: { authorization: 'Bearer fixture-panel', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
function cloudMock(options = {}) {
  const calls = [];
  let metadata;
  let pages;
  const namespace = 'c'.repeat(32);
  let probeFailed = false;
  let uploadAttempts = 0;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || 'GET' });
    if (url.startsWith('https://api.cloudflare.com/')) {
      assert.equal(init.headers.authorization, 'Bearer ' + (options.token || token));
      if (options.denied)
        return Response.json(
          { success: false, errors: [{ code: 10000, message: token }] },
          { status: 403 },
        );
      if (path.endsWith('/accounts'))
        return Response.json({
          success: true,
          result: options.accounts || [{ id: account, name: 'fixture' }],
        });
      if (path.endsWith('/accounts/' + account))
        return Response.json({ success: true, result: { id: account } });
      if (path.endsWith('/workers/subdomain'))
        return Response.json({ success: true, result: { subdomain: 'fixture-storage' } });
      if (path.endsWith('/settings'))
        return metadata
          ? Response.json({
              success: true,
              result: { bindings: [{ name: 'STORAGE', namespace_id: namespace }] },
            })
          : Response.json({ success: false }, { status: 404 });
      if (path.includes('/pages/projects')) {
        if (options.pagesDenied)
          return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 });
        if (path.includes('/deployments/'))
          return Response.json({
            success: true,
            result: {
              id: 'fixture-deployment',
              latest_stage: { status: options.pagesPending ? 'active' : 'success' },
            },
          });
        if (path.endsWith('/deployments')) {
          assert.equal(init.body.get('manifest'), '{}');
          assert.equal(init.body.get('branch'), 'main');
          assert.equal(await init.body.get('_worker.js').text(), storagePagesSource);
          return Response.json({
            success: true,
            result: {
              id: 'fixture-deployment',
              latest_stage: { status: options.pagesPending ? 'active' : 'success' },
            },
          });
        }
        if (!init.method || init.method === 'GET')
          return pages || options.foreignPages
            ? Response.json({
                success: true,
                result: pages || {
                  deployment_configs: {
                    production: { env_vars: { NODE_ID: { value: 'foreign' } } },
                  },
                },
              })
            : Response.json({ success: false }, { status: 404 });
        pages = JSON.parse(init.body);
        assert.equal(
          pages.deployment_configs.production.durable_object_namespaces.STORAGE.namespace_id,
          namespace,
        );
        assert.equal(pages.deployment_configs.production.env_vars.NODE_SECRET.type, 'secret_text');
        assert.equal(pages.deployment_configs.preview.env_vars.NODE_SECRET.type, 'secret_text');
        pages.subdomain = pages.name + '.pages.dev';
        return Response.json({ success: true, result: pages });
      }
      if (init.method === 'PUT' && path.includes('/scripts/')) {
        uploadAttempts++;
        if (options.uploadDenied || (options.firstUploadDenied && uploadAttempts === 1))
          return Response.json(
            { success: false, errors: [{ code: 10000, message: token }] },
            { status: options.uploadStatus || 403, headers: { 'cf-ray': '0123456789abcdef-HKG' } },
          );

        metadata = JSON.parse(await init.body.get('metadata').text());
        assert.equal(await init.body.get('index.js').text(), storageNodeSource);
        assert.ok(!JSON.stringify(metadata).includes(options.token || token));
        return Response.json({ success: true, result: { id: 'deployed' } });
      }
      if (init.method === 'POST' && path.endsWith('/subdomain'))
        return Response.json({ success: true, result: { enabled: true } });
      throw new Error('unexpected Cloudflare request ' + path);
    }
    assert.ok(url.endsWith('.pages.dev/self-test'));
    if (options.failProbe && !probeFailed) {
      probeFailed = true;
      throw new Error('network');
    }
    if (options.probeResponse) return options.probeResponse();
    const secret = metadata.bindings.find((b) => b.name === 'NODE_SECRET').text;
    assert.equal(init.headers.authorization, 'Bearer ' + secret);
    return Response.json({
      success: true,
      node_id: metadata.bindings.find((b) => b.name === 'NODE_ID').text,
      protocol: 1,
      storage: 'sqlite-do',
    });
  };
  return { fetcher, calls, metadata: () => metadata };
}
test('storage nodes save the API Token in D1, omit secrets from responses, and reuse an existing account', () =>
  database(async (env) => {
    const mock = cloudMock();
    let response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      mock.fetcher,
    );
    assert.equal(response.status, 201, await response.clone().text());
    const value = await response.json();
    assert.equal(value.node.status, 'ready');
    assert.equal(value.node.url, 'https://' + value.node.worker_name + '.pages.dev');
    assert.ok(!mock.calls.some((call) => call.path.endsWith('/subdomain')));
    assert.equal(value.node.node_secret, undefined);
    assert.equal(mock.metadata().observability.enabled, true);
    assert.equal(mock.metadata().observability.logs.invocation_logs, true);
    assert.deepEqual(mock.metadata().migrations, {
      new_tag: 'v1',
      new_sqlite_classes: ['StorageNode'],
    });
    const rows = (await env.DB.prepare('SELECT * FROM storage_nodes').all()).results;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].node_secret.length, 64);
    assert.equal(rows[0].api_token, token);
    assert.equal(value.node.api_token, undefined);
    assert.equal(value.node.has_token, true);
    response = await handleRequest(request(), env, mock.fetcher);
    const body = await response.text();
    assert.ok(!body.includes(rows[0].node_secret));
    assert.ok(!body.includes(token));
    assert.equal(JSON.parse(body).nodes[0].has_token, true);
    const before = mock.calls.length;
    response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      mock.fetcher,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reused, true);
    assert.equal(mock.calls.length, before + 1);
    response = await handleRequest(request('/' + rows[0].id + '/check', 'POST'), env, mock.fetcher);
    assert.equal(response.status, 200);
    response = await handleRequest(request('/' + rows[0].id, 'DELETE'), env, mock.fetcher);
    assert.equal((await response.json()).remote_deleted, false);
  }));
test('storage nodes require admin authentication, choose among accounts, and sanitize Cloudflare permission errors', () =>
  database(async (env) => {
    const mock = cloudMock({
      accounts: [
        { id: account, name: 'one' },
        { id: 'b'.repeat(32), name: 'two' },
      ],
    });
    const anonymous = await handleRequest(
      new Request('https://test/admin/storage-nodes'),
      env,
      mock.fetcher,
    );
    assert.equal(anonymous.status, 401);
    assert.equal(mock.calls.length, 0);
    let response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      mock.fetcher,
    );
    assert.equal((await response.json()).selection_required, true);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM storage_nodes').first()).n, 0);
    const denied = cloudMock({ denied: true });
    response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      denied.fetcher,
    );
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes(token));
  }));
test('storage node deployment retries reuse a deployed DO after a failed probe without a second migration', () =>
  database(async (env) => {
    const mock = cloudMock({ failProbe: true });
    let response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      mock.fetcher,
    );
    assert.equal(response.status, 502);
    const row = await env.DB.prepare('SELECT * FROM storage_nodes').first();
    assert.equal(row.deployed, 1);
    assert.equal(row.status, 'error');
    response = await handleRequest(request('/' + row.id + '/deploy', 'POST'), env, mock.fetcher);
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(mock.metadata().migrations, undefined);
    assert.equal((await response.json()).node.id, row.id);
  }));
test('deployed storage module runs in workerd, rejects wrong secrets, and verifies actual SQLite write/read/delete', async () => {
  const mf = new Miniflare({
    modules: true,
    script: storageNodeSource,
    compatibilityDate: '2025-09-01',
    bindings: { NODE_ID: 'fixture-node', NODE_SECRET: 'fixture-secret' },
    durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
    log: new Log(LogLevel.NONE),
  });
  try {
    assert.equal(
      (await mf.dispatchFetch('https://test/self-test', { method: 'POST' })).status,
      401,
    );
    const response = await mf.dispatchFetch('https://test/self-test', {
      method: 'POST',
      headers: { authorization: 'Bearer fixture-secret' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    assert.equal(
      (
        await mf.dispatchFetch('https://test/admin/credentials', {
          headers: { authorization: 'Bearer fixture-secret' },
        })
      ).status,
      404,
    );
  } finally {
    await mf.dispose();
  }
});

test('uploaded node source survives main-service bundling with keepNames and minification', async () => {
  for (const minify of [false, true]) {
    const bundle = await build({
      entryPoints: ['src/storage/node-worker.js'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      keepNames: true,
      minify,
    });
    const module = await import(
      'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
    );
    assert.equal(
      module.storageNodeSource,
      storageNodeSource,
      'main-service bundling must not transform the uploaded script',
    );
    const mf = new Miniflare({
      modules: true,
      script: module.storageNodeSource,
      compatibilityDate: '2025-09-01',
      bindings: { NODE_ID: 'bundled-node', NODE_SECRET: 'bundled-secret' },
      durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
      log: new Log(LogLevel.NONE),
    });
    try {
      const response = await mf.dispatchFetch('https://test/self-test', {
        method: 'POST',
        headers: { authorization: 'Bearer bundled-secret' },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).success, true);
    } finally {
      await mf.dispose();
    }
  }
});

test('node connection checks distinguish non-JSON responses, authorization, routing, and Worker-to-Worker rejection', () =>
  database(async (env) => {
    const cases = [
      [() => new Response('Unauthorized', { status: 401 }), /节点鉴权失败.*401/],
      [() => new Response('<html>blocked</html>', { status: 403 }), /节点拒绝访问.*403/],
      [() => new Response('not found', { status: 404 }), /节点路由尚未就绪.*404/],
      [
        () =>
          Response.json(
            {
              success: false,
              error: {
                code: 'NODE_RUNTIME_ERROR',
                phase: 'authorization',
                type: 'ReferenceError',
                missing_symbol: '__name',
                message: token,
              },
            },
            { status: 500 },
          ),
        /节点内部异常.*节点鉴权初始化.*ReferenceError.*__name/,
      ],
      [
        () =>
          new Response('<title>Worker threw exception</title>' + 'x'.repeat(10000), {
            status: 500,
            headers: { 'cf-ray': '0123456789abcdef-HKG' },
          }),
        /Worker 运行异常.*1101.*节点入口.*Cloudflare Ray ID：0123456789abcdef-HKG/,
      ],
      [() => new Response('error code: 1042', { status: 530 }), /Worker 间请求.*1042/],
      [() => new Response('<html>challenge</html>', { status: 200 }), /非 JSON.*200/],
      [
        () => new Response(null, { status: 302, headers: { location: 'https://other.invalid/' } }),
        /重定向.*302/,
      ],
    ];
    for (const [probeResponse, expected] of cases) {
      const mock = cloudMock({ probeResponse });
      const response = await handleRequest(
        request('', 'POST', { email: 'cf@example.test', token }),
        env,
        mock.fetcher,
      );
      assert.equal(response.status, 502);
      const body = await response.text();
      assert.match(body, expected);
      assert.ok(!body.includes(token));
    }
    const config = await readFile('wrangler.jsonc', 'utf8');
    assert.match(config, /"compatibility_flags"\s*:\s*\[[^\]]*"global_fetch_strictly_public"/);
  }));

test('node diagnostics report missing bindings and asynchronous DO exceptions without exposing secrets', async () => {
  for (const [source, bindings, durableObjects, phase, type] of [
    [storageNodeSource, { NODE_SECRET: 'fixture-private' }, {}, 'binding', 'TypeError'],
    [
      storageNodeSource.replace(
        "const key = 'probe:' + crypto.randomUUID();",
        "throw new ReferenceError('__name is not defined');",
      ),
      { NODE_SECRET: 'fixture-private', NODE_ID: 'fixture-node' },
      { STORAGE: { className: 'StorageNode', useSQLite: true } },
      'durable_object',
      'ReferenceError',
    ],
  ]) {
    const mf = new Miniflare({
      modules: true,
      script: source,
      compatibilityDate: '2025-09-01',
      bindings,
      durableObjects,
      log: new Log(LogLevel.NONE),
    });
    try {
      const response = await mf.dispatchFetch('https://test/self-test', {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-private' },
      });
      assert.equal(response.status, 500);
      const value = await response.json();
      assert.equal(value.error.code, 'NODE_RUNTIME_ERROR');
      assert.equal(value.error.phase, phase);
      assert.equal(value.error.type, type);
      assert.ok(!JSON.stringify(value).includes('fixture-private'));
    } finally {
      await mf.dispose();
    }
  }
});

test('stored node tokens support redeploying ready nodes, replacement, missing legacy tokens, and invalid replacement protection', () =>
  database(async (env) => {
    const initial = cloudMock();
    let response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      initial.fetcher,
    );
    const node = (await response.json()).node;
    response = await handleRequest(
      request('/' + node.id + '/deploy', 'POST'),
      env,
      initial.fetcher,
    );
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(initial.metadata().migrations, undefined);
    const replacement = 'fixture_replacement_123456789012345';
    const changed = cloudMock({ token: replacement });
    response = await handleRequest(
      request('/' + node.id + '/deploy', 'POST', { token: replacement }),
      env,
      changed.fetcher,
    );
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(
      (await env.DB.prepare('SELECT api_token FROM storage_nodes WHERE id=?').bind(node.id).first())
        .api_token,
      replacement,
    );
    const denied = cloudMock({ denied: true });
    response = await handleRequest(
      request('/' + node.id + '/deploy', 'POST', { token }),
      env,
      denied.fetcher,
    );
    assert.equal(response.status, 400);
    assert.equal(
      (await env.DB.prepare('SELECT api_token FROM storage_nodes WHERE id=?').bind(node.id).first())
        .api_token,
      replacement,
    );
    await env.DB.prepare('UPDATE storage_nodes SET api_token=NULL WHERE id=?').bind(node.id).run();
    response = await handleRequest(request(), env, initial.fetcher);
    assert.equal((await response.json()).nodes[0].has_token, false);
    const before = initial.calls.length;
    response = await handleRequest(
      request('/' + node.id + '/deploy', 'POST'),
      env,
      initial.fetcher,
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /补填一次/);
    assert.equal(initial.calls.length, before);
    response = await handleRequest(
      request('/' + node.id + '/deploy', 'POST', { account_id: 'b'.repeat(32), token }),
      env,
      initial.fetcher,
    );
    assert.equal(response.status, 400);
    assert.equal(initial.calls.length, before);
    response = await handleRequest(
      request('/' + node.id + '/deploy', 'POST', { token }),
      env,
      initial.fetcher,
    );
    assert.equal(response.status, 201);
    assert.equal(
      (await env.DB.prepare('SELECT api_token FROM storage_nodes WHERE id=?').bind(node.id).first())
        .api_token,
      token,
    );
  }));

test('Pages permission failures retain the deployed DO for retry and foreign projects are never overwritten', () =>
  database(async (env) => {
    const denied = cloudMock({ pagesDenied: true });
    let response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      denied.fetcher,
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /Cloudflare Pages/);
    const row = await env.DB.prepare('SELECT * FROM storage_nodes').first();
    assert.equal(row.deployed, 1);
    assert.equal(row.status, 'error');
    const foreign = cloudMock({ foreignPages: true });
    response = await handleRequest(request('/' + row.id + '/deploy', 'POST'), env, foreign.fetcher);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /不属于此节点/);
    assert.ok(
      !foreign.calls.some(
        (call) => call.path.includes('/pages/') && ['PATCH', 'POST'].includes(call.method),
      ),
    );
    const retry = cloudMock();
    response = await handleRequest(request('/' + row.id + '/deploy', 'POST'), env, retry.fetcher);
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(retry.metadata().migrations, undefined);
  }));

test('Pages handler reaches the existing Worker DO through a binding without using workers.dev', async () => {
  const mf = new Miniflare({
    workers: [
      {
        name: 'node-do',
        modules: true,
        script: storageNodeSource,
        compatibilityDate: '2025-09-01',
        bindings: { NODE_ID: 'pages-fixture', NODE_SECRET: 'private-fixture' },
        durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
      },
      {
        name: 'pages-entry',
        modules: true,
        script: storagePagesSource,
        compatibilityDate: '2025-09-01',
        bindings: { NODE_ID: 'pages-fixture', NODE_SECRET: 'private-fixture' },
        durableObjects: {
          STORAGE: { className: 'StorageNode', scriptName: 'node-do', useSQLite: true },
        },
      },
    ],
    log: new Log(LogLevel.NONE),
  });
  try {
    const worker = await mf.getWorker('pages-entry');
    assert.equal((await worker.fetch('https://test/self-test', { method: 'POST' })).status, 401);
    const r = await worker.fetch('https://test/self-test', {
      method: 'POST',
      headers: { authorization: 'Bearer private-fixture' },
    });
    assert.equal(r.status, 200);
    const value = await r.json();
    assert.equal(value.node_id, 'pages-fixture');
    assert.equal(value.success, true);
  } finally {
    await mf.dispose();
  }
});

test('Pages asynchronous publication stays pending until an authenticated DO check succeeds', () =>
  database(async (env) => {
    const mock = cloudMock({ pagesPending: true });
    let response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      mock.fetcher,
    );
    assert.equal(response.status, 202, await response.clone().text());
    const value = await response.json();
    assert.equal(value.deployment_pending, true);
    assert.equal(value.node.status, 'pending');
    assert.ok(!mock.calls.some((call) => call.path === '/self-test'));
    response = await handleRequest(
      request('/' + value.node.id + '/check', 'POST'),
      env,
      mock.fetcher,
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await env.DB.prepare('SELECT status FROM storage_nodes').first()).status,
      'ready',
    );
  }));

test('child caches enforce authorization, expiration and transfer bounds through Pages bindings', async () => {
  const mf = new Miniflare({
    modules: true,
    script: storageNodeSource,
    compatibilityDate: '2025-09-01',
    bindings: { NODE_ID: 'cache-fixture', NODE_SECRET: 'cache-secret' },
    durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
    log: new Log(LogLevel.NONE),
  });
  const key = 'a'.repeat(64),
    headers = { authorization: 'Bearer cache-secret', 'content-type': 'application/json' };
  const put = (expires_at, value = { total: 42 }) =>
    mf.dispatchFetch('https://node/cache/' + key, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expires_at, value }),
    });
  try {
    assert.equal(
      (await mf.dispatchFetch('https://node/cache/' + key, { method: 'PUT', body: '{}' })).status,
      401,
    );
    assert.equal((await put(Date.now() + 6000010)).status, 400);
    assert.equal((await put(Date.now() - 1)).status, 200);
    assert.equal((await mf.dispatchFetch('https://node/cache/' + key, { headers })).status, 404);
    const expires = Date.now() + 60000;
    assert.equal((await put(expires)).status, 200);
    assert.equal((await put(expires - 1000, { total: 1 })).status, 200);
    let value = await (await mf.dispatchFetch('https://node/cache/' + key, { headers })).json();
    assert.equal(value.value.total, 42);
    const exported = await (
      await mf.dispatchFetch('https://node/cache-transfer', { headers })
    ).json();
    assert.equal(exported.entries.length, 1);
    assert.equal(exported.entries[0].expires_at, expires);
    assert.equal(
      (
        await mf.dispatchFetch('https://node/cache-transfer', {
          method: 'POST',
          headers,
          body: JSON.stringify({ entries: Array(129).fill(exported.entries[0]) }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await mf.dispatchFetch('https://node/cache-transfer', { method: 'DELETE', headers })).status,
      200,
    );
    assert.equal((await mf.dispatchFetch('https://node/cache/' + key, { headers })).status, 404);
    assert.equal(
      (
        await mf.dispatchFetch('https://node/cache-transfer', {
          method: 'POST',
          headers,
          body: JSON.stringify({ entries: exported.entries }),
        })
      ).status,
      200,
    );
    assert.equal((await mf.dispatchFetch('https://node/cache/' + key, { headers })).status, 200);
  } finally {
    await mf.dispose();
  }
});

test('hourly node routing preheats during the last minute and handles any number of accounts', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    hour = 3600000;
  assert.equal(nodeSchedule([]).current, null);
  assert.equal(nodeSchedule(nodes, hour * 3).current.id, 'a');
  assert.equal(nodeSchedule(nodes, hour * 3 + hour - 60001).warming, false);
  assert.equal(nodeSchedule(nodes, hour * 3 + hour - 60000).warming, true);
  assert.equal(nodeSchedule(nodes, hour * 4).current.id, 'b');
  assert.equal(nodeSchedule(nodes, hour * 5).current.id, 'c');
  assert.equal(nodeSchedule([nodes[0]], hour - 1).warming, false);
});

test('node quota cache bypasses primary DO, scopes keys, invalidates and falls back on failures', () =>
  database(async (env) => {
    const id = '11111111-1111-4111-8111-111111111111',
      name = 'gcli2api-storage-111111111111',
      secret = 'd'.repeat(64);
    await env.DB.prepare(
      "INSERT INTO storage_nodes(id,email,account_id,worker_name,node_secret,url,status,deployed,created_at,updated_at)VALUES(?,?,?,?,?,?,'ready',1,1,1)",
    )
      .bind(id, 'cache@example.test', account, name, secret, 'https://' + name + '.pages.dev')
      .run();
    const remote = new Miniflare({
      modules: true,
      script: storageNodeSource,
      compatibilityDate: '2025-09-01',
      bindings: { NODE_ID: id, NODE_SECRET: secret },
      durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
      log: new Log(LogLevel.NONE),
    });
    let configReads = 0,
      primaryReads = 0,
      primaryWrites = 0,
      calls = 0;
    const db = env.DB;
    env.DB = {
      prepare(sql) {
        if (sql.includes("FROM storage_nodes WHERE status='ready'")) configReads++;
        return db.prepare(sql);
      },
    };
    env.TELEMETRY = {
      idFromName: () => '',
      get: () => ({
        fetch: async (url, init = {}) => {
          if (init.method === 'POST') primaryWrites++;
          else primaryReads++;
          return Response.json({ cached: false }, { status: 404 });
        },
      }),
    };
    env.STORAGE_NODE_FETCH = async (url, init) => {
      calls++;
      return remote.dispatchFetch(url, init);
    };
    try {
      const quota = {
        credentialId: id,
        mode: 'antigravity',
        queriedAt: new Date().toISOString(),
        models: [{ id: 'gemini-test', remaining: 0.5, access_token: 'must-not-store' }],
        access_token: 'must-not-store',
      };
      await saveQuotaCache(env, id, quota);
      let cached = await cachedQuota(env, id);
      assert.equal(cached.cache_source, 'storage-node');
      assert.equal(cached.models[0].remaining, 0.5);
      assert.ok(!JSON.stringify(cached).includes('must-not-store'));
      assert.equal(primaryReads, 0);
      assert.equal(primaryWrites, 0);
      assert.equal(configReads, 1);
      assert.equal(
        await readNodeCache({ ...env, PANEL_PASSWORD: 'other-scope' }, 'quota', id),
        null,
      );
      await invalidateNodeCaches(env);
      assert.equal(await readNodeCache(env, 'quota', id), null);
      resetStorageNodes(env);
      await readNodeCache(env, 'quota', id);
      assert.equal(configReads, 2);
      env.STORAGE_NODE_FETCH = async () => {
        calls++;
        throw new Error('offline');
      };
      assert.equal(await cachedQuota(env, id), null);
      const failedCalls = calls;
      assert.equal(await cachedQuota(env, id), null);
      assert.equal(calls, failedCalls);
      assert.equal(primaryReads, 2);
      await saveQuotaCache(env, id, quota);
      assert.equal(primaryWrites, 1);
    } finally {
      await remote.dispose();
    }
  }));

test('live statistics query child buffers and bypass old result caches', () =>
  database(async (env) => {
    const id = '22222222-2222-4222-8222-222222222222',
      name = 'gcli2api-storage-222222222222',
      secret = 'e'.repeat(64);
    await env.DB.prepare(
      "INSERT INTO storage_nodes(id,email,account_id,worker_name,node_secret,url,status,deployed,created_at,updated_at)VALUES(?,?,?,?,?,?,'ready',1,1,1)",
    )
      .bind(id, 'stats@example.test', account, name, secret, 'https://' + name + '.pages.dev')
      .run();
    const remote = new Miniflare({
      modules: true,
      script: storageNodeSource,
      compatibilityDate: '2025-09-01',
      bindings: { NODE_ID: id, NODE_SECRET: secret },
      durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
      log: new Log(LogLevel.NONE),
    });
    let reads = 0;
    env.USAGE_STORAGE_MODE = 'aggregate';
    env.TELEMETRY = {
      idFromName: () => '',
      get: () => ({
        fetch: async () => {
          reads++;
          return Response.json({
            summary: { requests: 42 },
            api_keys: [],
            cached_at: Date.now(),
            cache_seconds: 60,
            query_source: 'durable-object',
          });
        },
      }),
    };
    env.STORAGE_NODE_FETCH = (url, init) => remote.dispatchFetch(url, init);
    try {
      const first = await usageStats(env.DB, new URLSearchParams(), env);
      assert.equal(first.summary.requests, 42);
      assert.equal(reads, 1);
      dbCache(env.DB).stats.clear();
      const second = await usageStats(env.DB, new URLSearchParams(), env);
      assert.equal(second.summary.requests, 42);
      assert.equal(reads, 2);
      assert.notEqual(second.cache_source, 'storage-node');
      await usageStats(env.DB, new URLSearchParams('fresh=1'), env);
      assert.equal(reads, 3);
    } finally {
      await remote.dispose();
    }
  }));

test('adding nodes mid-hour never changes selection, including a cold instance and lower sorted IDs', () => {
  const hour = 3600000,
    start = hour * 3;
  const old = [
    { id: 'b', activated_at: 0 },
    { id: 'c', activated_at: 0 },
  ];
  const added = { id: 'a', activated_at: start + 1000 };
  const before = nodeSchedule(old, start + 2000);
  const after = nodeSchedule([added, ...old], start + 2000);
  assert.equal(after.current.id, before.current.id);
  assert.equal(
    nodeSchedule(structuredClone([added, ...old]), start + 2500).current.id,
    before.current.id,
  );
  const warming = nodeSchedule([added, ...old], start + hour - 60000);
  const boundary = nodeSchedule([added, ...old], start + hour);
  assert.equal(warming.current.id, before.current.id);
  assert.equal(warming.next.id, boundary.current.id);
  assert.equal(warming.switches_at, start + hour);
  assert.equal(nodeSchedule([added], start + 2000).current.id, added.id);
  assert.equal(
    nodeSchedule([added, { id: '0', activated_at: start + 1500 }], start + 3000).current.id,
    added.id,
  );
});

test('node directory refreshes at preheat and hour boundaries instead of retaining a five-minute old roster', async () => {
  const original = Date.now;
  let now = 3600000 * 3 + 3539000,
    reads = 0;
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    worker_name: 'gcli2api-storage-111111111111',
    node_secret: 'a'.repeat(64),
    url: 'https://gcli2api-storage-111111111111.pages.dev',
  };
  const env = {
    DB: {
      prepare: () => ({
        all: async () => {
          reads++;
          return { results: [row] };
        },
      }),
    },
  };
  try {
    Date.now = () => now;
    await storageNodes(env);
    await storageNodes(env);
    assert.equal(reads, 1);
    now = 3600000 * 4 - 60000;
    await storageNodes(env);
    assert.equal(reads, 2);
    now = 3600000 * 4;
    await storageNodes(env);
    assert.equal(reads, 3);
  } finally {
    Date.now = original;
  }
});

test('healthy checks preserve node activation while recovery waits for the next hour', () =>
  database(async (env) => {
    const mock = cloudMock();
    const response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      mock.fetcher,
    );
    assert.equal(response.status, 201);
    const node = (await response.json()).node;
    const old = Date.now() - 7200000;
    await env.DB.prepare('UPDATE storage_nodes SET activated_at=? WHERE id=?')
      .bind(old, node.id)
      .run();
    let check = await handleRequest(request('/' + node.id + '/check', 'POST'), env, mock.fetcher);
    assert.equal(check.status, 200);
    assert.equal(
      (
        await env.DB.prepare('SELECT activated_at FROM storage_nodes WHERE id=?')
          .bind(node.id)
          .first()
      ).activated_at,
      old,
    );
    await env.DB.prepare("UPDATE storage_nodes SET status='error' WHERE id=?").bind(node.id).run();
    const started = Date.now();
    check = await handleRequest(request('/' + node.id + '/check', 'POST'), env, mock.fetcher);
    assert.equal(check.status, 200);
    assert.ok(
      (
        await env.DB.prepare('SELECT activated_at FROM storage_nodes WHERE id=?')
          .bind(node.id)
          .first()
      ).activated_at >= started,
    );
    const listed = await (await handleRequest(request(), env, mock.fetcher)).json();
    assert.ok(listed.switches_at > Date.now());
    assert.equal(listed.active_node_id, node.id);
  }));

test('node usage records cache hits, misses and writes without counting probes or usage reads', async () => {
  const mf = new Miniflare({
    modules: true,
    script: storageNodeSource,
    compatibilityDate: '2025-09-01',
    bindings: { NODE_ID: 'usage-node', NODE_SECRET: 'usage-secret' },
    durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
    log: new Log(LogLevel.NONE),
  });
  const headers = { authorization: 'Bearer usage-secret', 'content-type': 'application/json' },
    key = 'f'.repeat(64);
  const get = (path) => mf.dispatchFetch('https://node' + path, { headers });
  try {
    assert.equal((await mf.dispatchFetch('https://node/usage')).status, 401);
    const empty = await (await get('/usage')).json();
    assert.equal(empty.today.requests, 0);
    await mf.dispatchFetch('https://node/self-test', { method: 'POST', headers });
    await get('/cache/' + key);
    await mf.dispatchFetch('https://node/cache/' + key, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expires_at: Date.now() + 60000, value: { quota: 0.5 } }),
    });
    await get('/cache/' + key);
    let metrics = await (await get('/usage')).json();
    assert.equal(metrics.today.requests, 3);
    assert.equal(metrics.today.reads, 2);
    assert.equal(metrics.today.hits, 1);
    assert.equal(metrics.today.misses, 1);
    assert.equal(metrics.today.writes, 1);
    assert.equal(metrics.cache_entries, 1);
    assert.ok(metrics.cache_bytes > 0);
    assert.ok(metrics.started_at <= metrics.sampled_at);
    assert.equal((await (await get('/usage')).json()).today.requests, 3);
  } finally {
    await mf.dispose();
  }
});

test('node usage lookup caches results, sanitizes response fields, and does not mislabel failures as zero usage', () =>
  database(async (env) => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111',
      worker_name: 'gcli2api-storage-111111111111',
      url: 'https://gcli2api-storage-111111111111.pages.dev',
      node_secret: 'private-fixture',
    };
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return Response.json({
        success: true,
        node_id: row.id,
        day: '2026-10-21',
        today: {
          requests: 123,
          reads: 100,
          hits: 80,
          misses: 20,
          writes: 23,
          imports: 0,
          exports: 0,
          errors: 0,
          access_token: 'private-fixture',
        },
        sampled_at: Date.now(),
        started_at: Date.now() - 1000,
        cache_entries: 4,
        cache_bytes: 200,
        node_secret: 'private-fixture',
      });
    };
    let metrics = await nodeUsage(env, row, fetcher);
    assert.equal(metrics.available, true);
    assert.equal(metrics.today.hits, 80);
    assert.ok(!JSON.stringify(metrics).includes('private-fixture'));
    await nodeUsage(env, row, fetcher);
    assert.equal(calls, 1);
    await nodeUsage(env, row, fetcher, true);
    assert.equal(calls, 2);
    metrics = await nodeUsage(
      env,
      row,
      async () => new Response('old node', { status: 404 }),
      true,
    );
    assert.equal(metrics.available, false);
    assert.match(metrics.reason, /重新部署/);
    assert.equal(metrics.today, undefined);
    metrics = await nodeUsage(
      env,
      row,
      async () => Response.json({ success: true, node_id: 'wrong' }),
      true,
    );
    assert.equal(metrics.available, false);
  }));

test('node usage checkpoints survive a Durable Object restart without counting twice', async () => {
  const script = storageNodeSource.replace(
    "if(path==='/usage' && request.method==='GET'){",
    "if(path==='/usage' && request.method==='POST'){this.flushUsage();return Response.json({success:true});} if(path==='/usage' && request.method==='GET'){",
  );
  assert.notEqual(script, storageNodeSource);
  const options = {
    modules: true,
    script,
    compatibilityDate: '2025-09-01',
    bindings: { NODE_ID: 'checkpoint', NODE_SECRET: 'checkpoint-secret' },
    durableObjects: { STORAGE: { className: 'StorageNode', useSQLite: true } },
    log: new Log(LogLevel.NONE),
  };
  const mf = new Miniflare(options),
    headers = { authorization: 'Bearer checkpoint-secret' };
  try {
    await mf.dispatchFetch('https://node/cache/' + 'a'.repeat(64), { headers });
    await mf.dispatchFetch('https://node/usage', { method: 'POST', headers });
    await mf.dispatchFetch('https://node/usage', { method: 'POST', headers });
    await mf.setOptions({ ...options, bindings: { ...options.bindings, RESTART: 'yes' } });
    const usage = await (await mf.dispatchFetch('https://node/usage', { headers })).json();
    assert.equal(usage.today.requests, 1);
    assert.equal(usage.today.misses, 1);
  } finally {
    await mf.dispose();
  }
});

test('primary node appears separately from rotating children and cannot be removed', () =>
  database(async (env) => {
    let response = await handleRequest(request(), env, async () => {
      throw Error('No public node fetch expected');
    });
    let value = await response.json();
    assert.equal(value.nodes.length, 0);
    assert.equal(value.primary_node.id, 'primary');
    assert.equal(value.primary_node.usage.available, false);
    assert.equal(value.active_node_id, null);
    let calls = 0;
    env.TELEMETRY = {
      idFromName: () => '',
      get: () => ({
        fetch: async () => {
          calls++;
          return Response.json({
            available: true,
            kind: 'primary',
            today_requests: 11,
            pending_buckets: 1,
            pending_requests: 2,
            buffer_buckets: 4,
            buffer_bytes: 200,
            quota_entries: 3,
            quota_bytes: 100,
            history_bytes: 300,
            sampled_at: Date.now(),
            activity: { started_at: Date.now(), requests: 12, reads: 5, writes: 7, errors: 0 },
            node_secret: 'must-not-return',
          });
        },
      }),
    };
    response = await handleRequest(request('?usage_fresh=1'), env, async () => {
      throw Error('No public node fetch expected');
    });
    value = await response.json();
    assert.equal(value.primary_node.usage.available, true);
    assert.equal(value.primary_node.usage.today_requests, 11);
    assert.equal(value.nodes.length, 0);
    assert.equal(value.next_node_id, null);
    assert.ok(!JSON.stringify(value).includes('must-not-return'));
    assert.equal(calls, 1);
    response = await handleRequest(request('/primary', 'DELETE'), env);
    assert.equal(response.status, 404);
  }));

test('new Worker upload retries one generic 403 and surfaces precise permanent failures without exposing secrets', () =>
  database(async (env) => {
    const recovering = cloudMock({ firstUploadDenied: true });
    let response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      recovering.fetcher,
    );
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(
      recovering.calls.filter((call) => call.method === 'PUT' && call.path.includes('/scripts/'))
        .length,
      2,
    );
    const node = (await response.json()).node;
    const denied = cloudMock({ uploadDenied: true });
    response = await handleRequest(request('/' + node.id + '/deploy', 'POST'), env, denied.fetcher);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.match(text, /Worker 上传.*HTTP 403.*10000.*0123456789abcdef-HKG/);
    assert.ok(!text.includes(token));
    assert.equal(
      denied.calls.filter((call) => call.method === 'PUT' && call.path.includes('/scripts/'))
        .length,
      1,
    );
  }));

test('permanent new-worker 403 stops after two attempts and invalid-token 401 is never retried', () =>
  database(async (env) => {
    const denied = cloudMock({ uploadDenied: true });
    let response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      denied.fetcher,
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /Worker 上传.*HTTP 403.*10000/);
    assert.equal(
      denied.calls.filter((call) => call.method === 'PUT' && call.path.includes('/scripts/'))
        .length,
      2,
    );
    const invalid = cloudMock({ uploadDenied: true, uploadStatus: 401 });
    response = await handleRequest(
      request('', 'POST', { email: 'cf@example.test', token }),
      env,
      invalid.fetcher,
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /鉴权失败.*HTTP 401/);
    assert.equal(
      invalid.calls.filter((call) => call.method === 'PUT' && call.path.includes('/scripts/'))
        .length,
      1,
    );
  }));

test('node monitoring coalesces concurrent reads, caches metadata and metrics, and explicit refresh bypasses the cache', () =>
  database(async (env) => {
    const id = '77777777-7777-4777-8777-777777777777',
      name = 'gcli2api-storage-777777777777',
      secret = 'f'.repeat(64);
    await env.DB.prepare(
      "INSERT INTO storage_nodes(id,email,account_id,worker_name,node_secret,url,status,deployed,created_at,updated_at)VALUES(?,?,?,?,?,?,'ready',1,1,1)",
    )
      .bind(id, 'monitor@example.test', account, name, secret, 'https://' + name + '.pages.dev')
      .run();
    let calls = 0,
      release;
    const gate = new Promise((resolve) => (release = resolve));
    const fetcher = async () => {
      calls++;
      await gate;
      return Response.json({
        success: true,
        node_id: id,
        day: '2026-10-21',
        sampled_at: Date.now(),
        started_at: Date.now() - 1000,
        cache_entries: 0,
        cache_bytes: 0,
        today: {
          requests: 0,
          reads: 0,
          hits: 0,
          misses: 0,
          writes: 0,
          imports: 0,
          exports: 0,
          errors: 0,
        },
      });
    };
    const first = handleRequest(request(), env, fetcher),
      second = handleRequest(request(), env, fetcher);
    for (let attempt = 0; attempt < 100 && !calls; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    await handleRequest(request(), env, fetcher);
    assert.equal(calls, 1);
    await handleRequest(request('?usage_fresh=1'), env, fetcher);
    assert.equal(calls, 2);
    resetStorageNodes(env);
    await handleRequest(request(), env, fetcher);
    assert.equal(calls, 2, 'metadata invalidation retains the independent 30-second metric cache');
  }));

test('hourly scheduling balances daily business traffic and freezes a durable preheat decision', async () => {
  const hour = Date.parse('2026-10-23T05:00:00Z');
  const nodes = [1, 2, 3].map((n) => ({
    id: `${n}`.repeat(8) + '-0000-0000-0000-000000000000',
    worker_name: 'gcli2api-storage-' + `${n}`.repeat(12),
    url: 'https://gcli2api-storage-' + `${n}`.repeat(12) + '.pages.dev',
    node_secret: `${n}`.repeat(64),
    activated_at: 0,
  }));
  const counts = [1000, 10, 100];
  let sampled = hour + 1000,
    calls = 0,
    writes = 0;
  const states = new Map();
  const owner = {
    history: {
      state: (key) => states.get(key),
      putState: (key, value) => {
        states.set(key, value);
        writes++;
      },
    },
    env: {
      DB: {},
      STORAGE_NODE_FETCH: async (url) => {
        calls++;
        const i = nodes.findIndex((n) => url === n.url + '/usage');
        if (counts[i] === null) return new Response('', { status: 503 });
        return Response.json({
          success: true,
          node_id: nodes[i].id,
          day: new Date(sampled + 8 * 3600000).toISOString().slice(0, 10),
          sampled_at: sampled,
          started_at: hour,
          cache_entries: 0,
          cache_bytes: 0,
          today: {
            requests: counts[i],
            reads: 0,
            hits: 0,
            misses: 0,
            writes: 0,
            imports: 0,
            exports: 0,
            errors: 0,
          },
        });
      },
    },
  };
  const scheduler = new StorageScheduler(owner);
  const first = await scheduler.resolve(nodes, sampled);
  assert.equal(first.current_id, nodes[1].id);
  assert.equal(first.basis, 'daily_requests');
  assert.equal(first.next_id, null);
  assert.equal(calls, 3);
  counts[1] = 9000;
  const restarted = new StorageScheduler(owner);
  assert.equal((await restarted.resolve(nodes, hour + 2000)).current_id, first.current_id);
  assert.equal(calls, 3, 'frozen decisions do not resample on restart');
  sampled = hour + 3590000;
  counts[2] = 0;
  counts[0] = null; // An unhealthy node must not be considered idle.
  const [warm, concurrent] = await Promise.all([
    restarted.resolve(nodes, sampled),
    restarted.resolve(nodes, sampled),
  ]);
  assert.equal(warm.current_id, first.current_id);
  assert.equal(warm.next_id, nodes[2].id);
  assert.equal(warm.warming, true);
  assert.deepEqual(concurrent, warm);
  assert.equal(calls, 6, 'concurrent preheat planning samples once');
  counts[2] = 50000;
  sampled = hour + 3600000;
  assert.equal((await new StorageScheduler(owner).resolve(nodes, sampled)).current_id, nodes[2].id);
  assert.equal(calls, 6, 'hour boundary reuses the node that was preheated');
  assert.equal(writes, 3);
  assert.ok(![...states.values()].join('').includes(nodes[0].node_secret));
  // Membership changes mid-hour never add a newer node ahead of existing candidates.
  const added = { ...nodes[0], activated_at: sampled + 1000 };
  assert.equal(
    (await restarted.resolve([added, nodes[1]], sampled + 2000)).current_id,
    nodes[1].id,
  );
});

test('daily scheduling handles midnight reset, unavailable metrics and same-hour membership', async () => {
  const now = Date.parse('2026-10-23T15:59:30Z');
  const nodes = ['a', 'b'].map((id) => ({ id, activated_at: 0 }));
  const metric = (requests, day = '2026-10-23', sampled_at = now) => ({
    available: true,
    day,
    sampled_at,
    today: { requests },
  });
  const metrics = new Map([
    ['a', metric(200)],
    ['b', metric(0)],
  ]);
  assert.equal(leastUsedNode(nodes, metrics, now).id, 'b');
  metrics.set('b', { available: false });
  assert.equal(leastUsedNode(nodes, metrics, now).id, 'a');
  metrics.set('a', metric(0, '2026-10-22'));
  assert.equal(leastUsedNode(nodes, metrics, now).basis, 'fallback');
  assert.equal(leastUsedNode([], new Map(), now).id, null);
  // Previous-day values are not used to rank the new day.
  assert.equal(
    leastUsedNode(
      nodes,
      new Map([
        ['a', metric(1)],
        ['b', metric(20)],
      ]),
      Date.parse('2026-10-23T16:00:00Z'),
    ).basis,
    'fallback',
  );
});

test('Worker instances coalesce and cache coordinator schedules until preheat or membership changes', async () => {
  const now = Date.parse('2026-10-23T05:01:00Z'),
    end = Date.parse('2026-10-23T06:00:00Z');
  const nodes = [
    { id: 'a', activated_at: 0 },
    { id: 'b', activated_at: 0 },
  ];
  let calls = 0;
  const env = {
    DB: {},
    TELEMETRY: {
      idFromName: () => '',
      get: () => ({
        fetch: async () => {
          calls++;
          return Response.json({
            current_id: 'b',
            next_id: null,
            basis: 'daily_requests',
            switches_at: end,
            warming: false,
          });
        },
      }),
    },
  };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => storageSchedule(env, nodes, now)),
  );
  assert.equal(calls, 1);
  assert.ok(results.every((s) => s.current.id === 'b'));
  await storageSchedule(env, nodes, now + 1000);
  assert.equal(calls, 1);
  await storageSchedule(env, nodes, end - 30000);
  assert.equal(calls, 2);
});
function renameMock(row, options = {}) {
  const namespace = 'c'.repeat(32);
  const target = row.worker_name.replace('gcli2api-', 'agy2api-');
  let moved = !!options.alreadyMoved;
  let project;
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push([init.method || 'GET', path]);
    const ok = (result) => Response.json({ success: true, result });
    const missing = () => Response.json({ success: false }, { status: 404 });
    if (url.startsWith('https://api.cloudflare.com/')) {
      assert.equal(init.headers.authorization, 'Bearer ' + token);
      if (path.endsWith('/settings')) {
        const current = path.includes('/' + target + '/');
        if (current ? !moved && !options.collision : moved) return missing();
        return ok({
          bindings: [
            { name: 'NODE_ID', text: options.collision && current ? 'another-node' : row.id },
            { name: 'STORAGE', namespace_id: namespace },
          ],
        });
      }
      if (path.endsWith('/workers/workers/' + row.worker_name)) {
        if (init.method === 'PATCH') {
          assert.deepEqual(JSON.parse(init.body), { name: target });
          moved = true;
          if (options.lostAcknowledgement && !options.failedOnce) {
            options.failedOnce = true;
            throw new Error('network');
          }
          return ok({ id: 'unchanged-worker-id', name: target });
        }
        return ok({ id: 'unchanged-worker-id', name: row.worker_name });
      }
      if (path.endsWith('/deployments') && init.method === 'POST') {
        assert.equal(await init.body.get('_worker.js').text(), storagePagesSource);
        return ok({ id: 'new-deployment', latest_stage: { status: 'success' } });
      }
      if (path.endsWith('/pages/projects') && init.method === 'POST') {
        project = JSON.parse(init.body);
        assert.equal(
          project.deployment_configs.production.durable_object_namespaces.STORAGE.namespace_id,
          namespace,
        );
        return ok({ ...project, subdomain: target + '.pages.dev' });
      }
      if (path.endsWith('/pages/projects/' + target))
        return project ? ok({ ...project, subdomain: target + '.pages.dev' }) : missing();
      throw new Error('unexpected request ' + path);
    }
    assert.equal(url, 'https://' + target + '.pages.dev/self-test');
    assert.equal(init.headers.authorization, 'Bearer ' + row.node_secret);
    if (options.badProbe) return Response.json({ success: false }, { status: 500 });
    return Response.json({ success: true, node_id: row.id, protocol: 1, storage: 'sqlite-do' });
  };
  return { fetcher, calls };
}
async function legacyStorageNode(env) {
  const setup = cloudMock();
  const response = await handleRequest(
    request('', 'POST', { email: 'cf@example.test', token }),
    env,
    setup.fetcher,
  );
  assert.equal(response.status, 201);
  const row = await env.DB.prepare('SELECT * FROM storage_nodes').first();
  row.worker_name = row.worker_name.replace('agy2api-', 'gcli2api-');
  row.url = 'https://' + row.worker_name + '.pages.dev';
  await env.DB.prepare('UPDATE storage_nodes SET worker_name=?,url=? WHERE id=?')
    .bind(row.worker_name, row.url, row.id)
    .run();
  return row;
}
test('node resource rename preserves namespace, identity, activation and secrets; repeats are harmless', () =>
  database(async (env) => {
    const row = await legacyStorageNode(env);
    const mock = renameMock(row);
    let response = await handleRequest(
      request('/' + row.id + '/rename', 'POST'),
      env,
      mock.fetcher,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.namespace_preserved, true);
    assert.ok(!JSON.stringify(result).includes(token));
    const saved = await env.DB.prepare('SELECT * FROM storage_nodes WHERE id=?')
      .bind(row.id)
      .first();
    assert.equal(saved.worker_name, row.worker_name.replace('gcli2api-', 'agy2api-'));
    assert.equal(saved.activated_at, row.activated_at);
    assert.equal(saved.node_secret, row.node_secret);
    assert.equal(saved.status, 'ready');
    assert.ok(!mock.calls.some(([method]) => method === 'DELETE' || method === 'PUT'));
    const count = mock.calls.length;
    response = await handleRequest(request('/' + row.id + '/rename', 'POST'), env, mock.fetcher);
    assert.equal((await response.json()).unchanged, true);
    assert.equal(mock.calls.length, count);
  }));
test('node rename stops at name collision or failed probe without changing the original address', () =>
  database(async (env) => {
    const row = await legacyStorageNode(env);
    for (const options of [{ collision: true }, { badProbe: true }]) {
      const mock = renameMock(row, options);
      const response = await handleRequest(
        request('/' + row.id + '/rename', 'POST'),
        env,
        mock.fetcher,
      );
      assert.ok(response.status >= 400);
      const saved = await env.DB.prepare('SELECT * FROM storage_nodes WHERE id=?')
        .bind(row.id)
        .first();
      assert.equal(saved.worker_name, row.worker_name);
      assert.equal(saved.url, row.url);
      assert.equal(saved.status, 'ready');
      assert.ok(!mock.calls.some(([method]) => method === 'PATCH'));
      Object.assign(row, saved);
    }
  }));
test('node rename recovers after Worker rename succeeds but its acknowledgement is lost', () =>
  database(async (env) => {
    let row = await legacyStorageNode(env);
    const mock = renameMock(row, { lostAcknowledgement: true });
    let response = await handleRequest(
      request('/' + row.id + '/rename', 'POST'),
      env,
      mock.fetcher,
    );
    assert.equal(response.status, 502);
    row = await env.DB.prepare('SELECT * FROM storage_nodes WHERE id=?').bind(row.id).first();
    assert.ok(row.worker_name.startsWith('gcli2api-'));
    response = await handleRequest(request('/' + row.id + '/rename', 'POST'), env, mock.fetcher);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(mock.calls.filter(([method]) => method === 'PATCH').length, 1);
  }));
