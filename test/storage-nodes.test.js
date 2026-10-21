import { usageStats } from '../src/telemetry/stats.js';
import { dbCache } from '../src/cache/db.js';
import {
  readNodeCache,
  writeNodeCache,
  nodeSchedule,
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
        mode: 'geminicli',
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

test('statistics cached in a child node avoid primary coordinator reads for a cold Worker instance', () =>
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
      assert.equal(reads, 1);
      assert.equal(second.cache_source, 'storage-node');
      assert.equal(second.storage_node_name, 'stats@example.test');
      await usageStats(env.DB, new URLSearchParams('fresh=1'), env);
      assert.equal(reads, 2);
    } finally {
      await remote.dispose();
    }
  }));
