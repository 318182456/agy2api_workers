import { renameStorageNode } from './rename.js';
import { timed } from '../core/timing.js';
import { dbCache } from '../cache/db.js';
import { storageSchedule } from './schedule.js';
import { syncNodeTelemetry } from './telemetry.js';
import { nodeUsage, primaryUsage } from './usage.js';
import { HttpError, json, readJson } from '../core/common.js';
import { storageNodeSource, storagePagesSource } from './node-worker.js';

const publicFields =
  'id,email,account_id,worker_name,url,status,deployed,last_error,created_at,updated_at,checked_at,activated_at';
const accountPattern = /^[a-f0-9]{32}$/;
const publicNode = (row) => ({
  ...Object.fromEntries(publicFields.split(',').map((key) => [key, row[key] ?? null])),
  has_token: row.has_token == null ? !!row.api_token : !!row.has_token,
});
function failure(message, status = 400) {
  const error = new HttpError(status, message);
  error.operation = 'storage_node';
  return error;
}
function cloudflareOperation(path, method = 'GET') {
  if (path.includes('/pages/projects')) {
    if (path.includes('/deployments/')) return 'Pages 发布进度查询';
    if (path.endsWith('/deployments')) return 'Pages 发布';
    return method === 'POST'
      ? 'Pages 项目创建'
      : method === 'PATCH'
        ? 'Pages 配置更新'
        : 'Pages 配置读取';
  }
  if (path.includes('/workers/workers/'))
    return method === 'PATCH' ? 'Worker 资源改名' : 'Worker 身份读取';
  if (path.endsWith('/settings')) return 'Worker 配置读取';
  if (path.includes('/workers/scripts/')) return 'Worker 上传';
  return path.startsWith('/accounts?') ? '账号列表读取' : '账号校验';
}
async function cloudflare(fetcher, token, path, options = {}, allowMissing = false) {
  const { retryPermissionOnce = false, ...init } = options;
  const operation = cloudflareOperation(path, init.method);
  let response, value;
  for (let attempt = 0; attempt < (retryPermissionOnce ? 2 : 1); attempt++) {
    try {
      response = await fetcher('https://api.cloudflare.com/client/v4' + path, {
        ...init,
        headers: { authorization: 'Bearer ' + token, ...init.headers },
        signal: AbortSignal.timeout(15000),
        redirect: 'manual',
      });
    } catch {
      throw failure(
        'Cloudflare API 连接失败或超时（操作：' + operation + '）；已创建资源会复用',
        502,
      );
    }
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    try {
      value = await response.json();
    } catch {
      throw failure(
        'Cloudflare API 返回无效响应（操作：' + operation + '，HTTP ' + response.status + '）',
        502,
      );
    }
    // Only the first upload of a new Worker may retry one generic 403. This is bounded;
    // invalid tokens (401), permission-specific errors and other writes are never retried here.
    if (!(
      retryPermissionOnce &&
      attempt === 0 &&
      response.status === 403 &&
      Number(value.errors?.[0]?.code) === 10000
    ))
      break;
    console.warn(
      JSON.stringify({
        event: 'storage_node_initial_upload_retry',
        operation: 'worker_upload',
        status: 403,
        code: 10000,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!response.ok || value.success !== true) {
    const code = Number(value.errors?.[0]?.code) || '未知';
    const ray = response.headers.get('cf-ray') || '';
    const trace = /^[a-f0-9]{16,32}-[a-z]{3}$/i.test(ray) ? '，Ray ID：' + ray : '';
    const details =
      '（操作：' + operation + '，HTTP ' + response.status + '，错误码 ' + code + trace + '）';
    console.warn(
      JSON.stringify({
        event: 'storage_node_cloudflare_failed',
        operation,
        status: response.status,
        code,
      }),
    );
    if ([401, 403].includes(response.status)) {
      const permission = path.includes('/pages/')
        ? 'Cloudflare Pages 编辑'
        : path.includes('/workers/')
          ? 'Workers Scripts 编辑'
          : 'Account Settings 读取及目标账号资源';
      throw failure(
        response.status === 401
          ? 'Cloudflare 鉴权失败' + details + '；请确认 Token 未过期或撤销'
          : 'Cloudflare 拒绝此操作' +
              details +
              '；请检查 ' +
              permission +
              ' 权限和新账号 Workers / Pages 初始化状态',
      );
    }
    if (response.status === 429)
      throw failure('Cloudflare API 触发限流' + details + '，请稍后重试', 503);
    if (code === 10021)
      throw failure(
        'Cloudflare 节点脚本启动校验失败（10021）' +
          details +
          '；请更新主服务后重试部署，现有节点记录可复用',
        502,
      );
    throw failure('Cloudflare 操作失败' + details, 502);
  }
  return value.result;
}
async function check(row, fetcher) {
  if (
    !row.url ||
    !new RegExp(
      '^https://' + row.worker_name + '(?:\\.[a-z0-9-]+\\.workers\\.dev|\\.pages\\.dev)$',
    ).test(row.url)
  )
    throw failure('节点地址尚未创建');
  let response;
  try {
    response = await fetcher(row.url + '/self-test', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + row.node_secret },
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });
  } catch (error) {
    throw failure(
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? '节点连接超时（10 秒），请检查 节点入口路由是否已生效后重试'
        : '节点连接失败，未收到 HTTP 响应；请检查主服务到节点入口的网络及 Worker 间公网请求配置',
      502,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw failure(
      '节点返回重定向（HTTP ' + response.status + '），已停止跟随；请检查节点路由或访问验证',
      502,
    );
  }
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel();
    throw failure(
      response.status === 401
        ? '节点鉴权失败（HTTP 401），请重新部署此节点以恢复通信密钥'
        : '节点拒绝访问（HTTP 403），请检查节点的 Cloudflare Access 或防火墙设置',
      502,
    );
  }
  let text = '';
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const part = value.subarray(0, 8192 - length);
          length += part.length;
          text += decoder.decode(part, { stream: true });
          if (length >= 8192) {
            await reader.cancel();
            break;
          }
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
  } catch {
    throw failure('节点响应正文读取失败（HTTP ' + response.status + '），请重试检查连接', 502);
  }
  if (/Worker threw exception|\b1101\b/i.test(text) && response.status >= 500) {
    const ray = response.headers.get('cf-ray') || '';
    const trace = /^[a-f0-9]{16,32}-[a-z]{3}$/i.test(ray)
      ? ' [Cloudflare Ray ID：' + ray + ']'
      : '';
    throw failure(
      '节点 Worker 运行异常（HTTP ' +
        response.status +
        ' / Cloudflare 1101）；若节点没有调用日志，请检查节点入口路由和账号状态，不能仅凭此响应判断为 DO 代码异常' +
        trace,
      502,
    );
  }
  if (/(?:error code:|error|code)[\s"':=]*1042\b/i.test(text))
    throw failure(
      'Cloudflare 阻止 Worker 间请求（1042），请更新主服务并启用 global_fetch_strictly_public',
      502,
    );
  let structured;
  try {
    structured = JSON.parse(text);
  } catch {}
  const diagnostic = structured?.error;
  if (
    response.status >= 500 &&
    diagnostic?.code === 'NODE_RUNTIME_ERROR' &&
    ['authorization', 'binding', 'durable_object'].includes(diagnostic.phase) &&
    ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'].includes(diagnostic.type)
  ) {
    const phase = {
      authorization: '节点鉴权初始化',
      binding: 'DO 绑定',
      durable_object: 'DO 执行',
    }[diagnostic.phase];
    const symbol = ['__name', '__defProp', 'StorageNode', 'crypto', 'TextEncoder'].includes(
      diagnostic.missing_symbol,
    )
      ? '，未定义符号 ' + diagnostic.missing_symbol
      : '';
    throw failure(
      '节点内部异常（' + phase + ' / ' + diagnostic.type + symbol + '），请检查节点日志',
      502,
    );
  }
  if (!response.ok)
    throw failure(
      response.status === 404
        ? '节点路由尚未就绪（HTTP 404），请稍后检查连接，或重新部署节点'
        : '节点响应失败（HTTP ' + response.status + '），请查看该节点的 Worker 日志',
      502,
    );
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw failure(
      '节点返回非 JSON 响应（HTTP ' + response.status + '），请检查节点入口访问验证或路由',
      502,
    );
  }
  if (
    value?.success !== true ||
    value.node_id !== row.id ||
    value.protocol !== 1 ||
    value.storage !== 'sqlite-do'
  )
    throw failure('节点身份或 DO 读写验证失败，请检查部署状态', 502);
  return value;
}
async function create(env, input, fetcher) {
  let saved;
  if (input.node_id) {
    if (!/^[a-f0-9-]{36}$/.test(input.node_id)) throw failure('节点 ID 无效');
    saved = await env.DB.prepare('SELECT * FROM storage_nodes WHERE id=?')
      .bind(input.node_id)
      .first();
    if (!saved) throw failure('节点不存在', 404);
    if (input.account_id && input.account_id !== saved.account_id)
      throw failure('不能将已有节点改为其他 Cloudflare 账号');
  } else if (input.account_id && accountPattern.test(input.account_id)) {
    saved = await env.DB.prepare('SELECT * FROM storage_nodes WHERE account_id=?')
      .bind(input.account_id)
      .first();
  }
  const email = String(input.email ?? saved?.email ?? '').trim();
  const token = String(input.token || saved?.api_token || '').trim();
  const accountId = saved?.account_id || input.account_id;
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw failure('请填写有效邮箱，作为账号名称');
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token))
    throw failure('此账号尚未保存可用的 API Token，请先补填一次');
  if (accountId && !accountPattern.test(accountId)) throw failure('Account ID 无效');
  // A provided Account ID also supports tokens that cannot list accounts.
  let account;
  if (accountId) {
    account = await cloudflare(fetcher, token, '/accounts/' + accountId);
    if (account?.id !== accountId) throw failure('Cloudflare 账号校验失败');
  } else {
    const accounts = await cloudflare(fetcher, token, '/accounts?per_page=50');
    const candidates = Array.isArray(accounts)
      ? accounts.filter((row) => accountPattern.test(row.id))
      : [];
    if (!candidates.length) throw failure('Token 没有可用账号，请检查账号权限或填写 Account ID');
    if (candidates.length > 1)
      return json({
        selection_required: true,
        accounts: candidates.map(({ id, name }) => ({ id, name })),
      });
    account = candidates[0];
  }
  let row = await env.DB.prepare('SELECT * FROM storage_nodes WHERE account_id=?')
    .bind(account.id)
    .first();
  if (row?.status === 'ready' && !input.redeploy) {
    await env.DB.prepare('UPDATE storage_nodes SET api_token=?,email=?,updated_at=? WHERE id=?')
      .bind(token, email, Date.now(), row.id)
      .run();
    return json({ node: publicNode({ ...row, api_token: token, email }), reused: true });
  }
  if (row?.status === 'renaming' && row.updated_at > Date.now() - 600000)
    throw failure('节点正在改名，请稍后重试', 409);
  const now = Date.now();
  if (!row) {
    const id = crypto.randomUUID();
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
    await env.DB.prepare(
      "INSERT OR IGNORE INTO storage_nodes(id,email,account_id,worker_name,node_secret,created_at,updated_at,status,api_token)VALUES(?,?,?,?,?,?,?,'pending',?)",
    )
      .bind(
        id,
        email,
        account.id,
        'agy2api-storage-' + id.replaceAll('-', '').slice(0, 12),
        secret,
        now,
        now,
        token,
      )
      .run();
    row = await env.DB.prepare('SELECT * FROM storage_nodes WHERE account_id=?')
      .bind(account.id)
      .first();
  }
  const claim = await env.DB.prepare(
    "UPDATE storage_nodes SET status='provisioning',last_error=NULL,email=?,api_token=?,updated_at=? WHERE id=? AND (status!='provisioning' OR updated_at<?)",
  )
    .bind(email, token, now, row.id, now - 120000)
    .run();
  if (!claim.meta.changes) throw failure('该账号正在创建节点，请稍后刷新列表', 409);
  // The verified account token is saved before deployment so failed attempts can retry without re-entry.
  try {
    const base = '/accounts/' + account.id + '/workers';
    // Query existing settings before retrying an upload whose acknowledgement may have been lost.
    let exists = !!row.deployed;
    if (!exists) {
      const state = await cloudflare(
        fetcher,
        token,
        base + '/scripts/' + row.worker_name + '/settings',
        {},
        true,
      );
      if (state) {
        if (
          !state.bindings?.some((binding) => binding.name === 'NODE_ID' && binding.text === row.id)
        )
          throw failure('目标 Worker 名称已存在且不属于此节点，已停止覆盖');
        exists = true;
      }
    }
    const metadata = {
      main_module: 'index.js',
      compatibility_date: '2025-09-01',
      observability: {
        enabled: true,
        head_sampling_rate: 1,
        logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 },
      },
      bindings: [
        { name: 'STORAGE', type: 'durable_object_namespace', class_name: 'StorageNode' },
        { name: 'NODE_ID', type: 'plain_text', text: row.id },
        { name: 'NODE_SECRET', type: 'secret_text', text: row.node_secret },
      ],
      ...(!exists ? { migrations: { new_tag: 'v1', new_sqlite_classes: ['StorageNode'] } } : {}),
    };
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.set(
      'index.js',
      new Blob([storageNodeSource], { type: 'application/javascript+module' }),
      'index.js',
    );
    await cloudflare(fetcher, token, base + '/scripts/' + row.worker_name, {
      retryPermissionOnce: !exists,
      method: 'PUT',
      body: form,
    });
    // Record the DO deployment before creating Pages so retries never recreate its namespace.
    await env.DB.prepare('UPDATE storage_nodes SET deployed=1,updated_at=? WHERE id=?')
      .bind(Date.now(), row.id)
      .run();
    const state = await cloudflare(
      fetcher,
      token,
      base + '/scripts/' + row.worker_name + '/settings',
    );
    const namespace = state?.bindings?.find((binding) => binding.name === 'STORAGE')?.namespace_id;
    if (typeof namespace !== 'string' || !/^[a-f0-9]{32}$/.test(namespace))
      throw failure('无法取得已部署的 DO 命名空间，请稍后重新部署', 502);
    const pagesPath = '/accounts/' + account.id + '/pages/projects';
    const projectPath = pagesPath + '/' + row.worker_name;
    const existingProject = await cloudflare(fetcher, token, projectPath, {}, true);
    if (
      existingProject &&
      existingProject.deployment_configs?.production?.env_vars?.NODE_ID?.value !== row.id
    )
      throw failure('目标 Pages 项目已存在且不属于此节点，已停止覆盖');
    const config = {
      compatibility_date: '2025-09-01',
      env_vars: {
        NODE_ID: { type: 'plain_text', value: row.id },
        NODE_SECRET: { type: 'secret_text', value: row.node_secret },
      },
      durable_object_namespaces: { STORAGE: { namespace_id: namespace } },
    };
    const project = await cloudflare(fetcher, token, existingProject ? projectPath : pagesPath, {
      method: existingProject ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: row.worker_name,
        production_branch: 'main',
        deployment_configs: { production: config, preview: config },
      }),
    });
    if (project?.subdomain !== row.worker_name + '.pages.dev')
      throw failure('Pages 返回的节点域名与项目不匹配，已停止连接', 502);
    const pagesForm = new FormData();
    pagesForm.set('manifest', '{}');
    pagesForm.set('branch', 'main');
    pagesForm.set(
      '_worker.js',
      new Blob([storagePagesSource], { type: 'application/javascript+module' }),
      '_worker.js',
    );
    let deployment = await cloudflare(fetcher, token, projectPath + '/deployments', {
      method: 'POST',
      body: pagesForm,
    });
    if (!deployment?.id || deployment.latest_stage?.status === 'failure')
      throw failure('Pages 部署未成功，请稍后重新部署节点', 502);
    const url = 'https://' + project.subdomain;
    await env.DB.prepare('UPDATE storage_nodes SET url=?,updated_at=? WHERE id=?')
      .bind(url, Date.now(), row.id)
      .run();
    row = { ...row, url, deployed: 1 };
    for (let attempt = 0; deployment.latest_stage?.status !== 'success' && attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      deployment = await cloudflare(fetcher, token, projectPath + '/deployments/' + deployment.id);
      if (
        deployment.latest_stage?.status === 'failure' ||
        deployment.latest_stage?.status === 'canceled'
      )
        throw failure('Pages 部署未成功，请稍后重新部署节点', 502);
    }
    if (deployment.latest_stage?.status !== 'success') {
      await env.DB.prepare(
        "UPDATE storage_nodes SET status='pending',last_error=NULL,updated_at=? WHERE id=?",
      )
        .bind(Date.now(), row.id)
        .run();
      return json(
        {
          node: publicNode({ ...row, api_token: token, status: 'pending', last_error: null }),
          deployment_pending: true,
        },
        202,
      );
    }
    await check(row, fetcher);
    await env.DB.prepare(
      "UPDATE storage_nodes SET activated_at=CASE WHEN status='ready' AND activated_at IS NOT NULL THEN activated_at ELSE ? END,status='ready',last_error=NULL,checked_at=?,updated_at=? WHERE id=?",
    )
      .bind(Date.now(), Date.now(), Date.now(), row.id)
      .run();
  } catch (error) {
    const message =
      error instanceof HttpError
        ? error.message
        : '节点创建中断，请点击重新部署；已保存 Token 和已创建资源会复用';
    await env.DB.prepare(
      "UPDATE storage_nodes SET status='error',last_error=?,updated_at=? WHERE id=?",
    )
      .bind(message, Date.now(), row.id)
      .run();
    if (error instanceof HttpError) throw error;
    throw failure(message, 502);
  }
  return json(
    {
      node: publicNode(
        await env.DB.prepare('SELECT * FROM storage_nodes WHERE id=?').bind(row.id).first(),
      ),
    },
    201,
  );
}
export async function storageNodesRoute(request, env, url, fetcher) {
  if (url.pathname === '/admin/storage-nodes') {
    if (request.method === 'GET') {
      const cache = dbCache(env.DB),
        fresh = url.searchParams.get('usage_fresh') === '1';
      if (
        !fresh &&
        cache.storagePanel?.origin === url.origin &&
        cache.storagePanel?.until > Date.now()
      )
        return json(cache.storagePanel.value);
      if (cache.storagePanelFlight && cache.storagePanelFlightOrigin === url.origin)
        return json(await cache.storagePanelFlight);
      const flight = (async () => {
        const primaryFlight = timed(env, 'monitor_primary', () =>
          primaryUsage(env, url.searchParams.get('usage_fresh') === '1'),
        );
        const rows = (
          await timed(env, 'monitor_d1', () =>
            env.DB.prepare(
              'SELECT ' +
                publicFields +
                ',node_secret,(api_token IS NOT NULL AND length(api_token)>0) AS has_token FROM storage_nodes ORDER BY created_at',
            ).all(),
          )
        ).results;
        const nodes = rows.map(publicNode);
        // Keep concurrency bounded; refreshing a page never records metrics in D1.
        await timed(env, 'monitor_nodes', async () => {
          for (let offset = 0; offset < rows.length; offset += 5) {
            await Promise.all(
              rows.slice(offset, offset + 5).map(async (row, index) => {
                nodes[offset + index].usage = await nodeUsage(
                  env,
                  row,
                  fetcher,
                  url.searchParams.get('usage_fresh') === '1',
                );
              }),
            );
          }
        });
        const eligible = nodes
          .filter(
            (row) =>
              row.status === 'ready' && row.url === 'https://' + row.worker_name + '.pages.dev',
          )
          .sort((a, b) => a.id.localeCompare(b.id));
        const schedule = await storageSchedule(
          env,
          rows.filter((row) => eligible.some((node) => node.id === row.id)),
        );
        return {
          primary_node: {
            id: 'primary',
            kind: 'primary',
            name: '主节点（当前账号）',
            url: url.origin,
            usage: await primaryFlight,
          },
          nodes,
          rotation_enabled: !!eligible.length,
          active_node_id: schedule.current?.id || null,
          next_node_id: schedule.next?.id || null,
          preheating: schedule.warming,
          schedule_basis: schedule.basis || 'fallback',
          switches_at: schedule.switches_at,
          cache_only: false,
        };
      })();
      cache.storagePanelFlight = flight;
      cache.storagePanelFlightOrigin = url.origin;
      try {
        const value = await flight;
        if (cache.storagePanelFlight === flight)
          cache.storagePanel = {
            until: Math.min(
              Date.now() + 30000,
              value.switches_at || Infinity,
              Math.floor(Date.now() / 3600000) * 3600000 + 3540000 > Date.now()
                ? Math.floor(Date.now() / 3600000) * 3600000 + 3540000
                : Infinity,
            ),
            value,
            origin: url.origin,
          };
        return json(value);
      } finally {
        if (cache.storagePanelFlight === flight) {
          delete cache.storagePanelFlight;
          delete cache.storagePanelFlightOrigin;
        }
      }
    }
    if (request.method === 'POST') return create(env, await readJson(request), fetcher);
  }
  const match = url.pathname.match(
    /^\/admin\/storage-nodes\/([a-f0-9-]{36})(\/(?:check|deploy|rename))?$/,
  );
  if (!match) throw failure('接口不存在', 404);
  const row = await env.DB.prepare('SELECT * FROM storage_nodes WHERE id=?').bind(match[1]).first();
  if (!row) throw failure('节点不存在', 404);
  if (match[2] === '/rename' && request.method === 'POST')
    return renameStorageNode(env, row, fetcher, cloudflare, check);
  if (row.status === 'renaming' && row.updated_at > Date.now() - 600000)
    throw failure('节点正在改名，请稍后重试', 409);
  if (match[2] === '/deploy' && request.method === 'POST') {
    const input = request.body ? await readJson(request) : {};
    return create(env, { ...input, node_id: row.id, redeploy: true }, fetcher);
  }
  if (match[2] === '/check' && request.method === 'POST') {
    try {
      await check(row, fetcher);
      await env.DB.prepare(
        "UPDATE storage_nodes SET activated_at=CASE WHEN status='ready' AND activated_at IS NOT NULL THEN activated_at ELSE ? END,status='ready',last_error=NULL,checked_at=?,updated_at=? WHERE id=?",
      )
        .bind(Date.now(), Date.now(), Date.now(), row.id)
        .run();
    } catch (error) {
      await env.DB.prepare(
        "UPDATE storage_nodes SET status='error',last_error=?,updated_at=? WHERE id=?",
      )
        .bind(error.message, Date.now(), row.id)
        .run();
      throw error;
    }
    return json({ success: true });
  }
  if (!match[2] && request.method === 'DELETE') {
    if (row.status === 'provisioning' && row.updated_at > Date.now() - 120000)
      throw failure('节点正在创建，请完成后再移除', 409);
    await syncNodeTelemetry(env, [row]);
    await env.DB.prepare('DELETE FROM storage_nodes WHERE id=?').bind(row.id).run();
    return json({ success: true, remote_deleted: false });
  }
  throw failure('请求方法不支持', 405);
}
