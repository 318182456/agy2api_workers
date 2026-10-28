import { HttpError, json } from '../core/common.js';
import { storagePagesSource } from './node-worker.js';

// Keep the DO namespace and its internal object names unchanged throughout the rename.
export async function renameStorageNode(env, row, fetcher, cloudflare, check) {
  const fail = (message, status = 409) => {
    throw new HttpError(status, message);
  };
  const target = row.worker_name.replace(/^gcli2api-storage-/, 'agy2api-storage-');
  if (target === row.worker_name) return json({ success: true, unchanged: true });
  if (!/^agy2api-storage-[a-f0-9]{12}$/.test(target)) fail('节点资源名称不符合迁移规则');
  if (!row.api_token) fail('请先补填此节点的 Cloudflare API Token');
  if (!row.deployed) fail('请先完成原节点部署');
  if (
    row.status === 'provisioning' ||
    (row.status === 'renaming' && row.updated_at > Date.now() - 600000)
  )
    fail('节点正在部署或改名，请稍后重试');
  const now = Date.now();
  const claimed = await env.DB.prepare(
    "UPDATE storage_nodes SET status='renaming',updated_at=? WHERE id=? AND updated_at=? AND status=?",
  )
    .bind(now, row.id, row.updated_at, row.status)
    .run();
  if (!claimed.meta.changes) fail('节点状态已变化，请刷新后重试');
  const base = '/accounts/' + row.account_id;
  const call = (path, init = {}, missing = false) =>
    cloudflare(fetcher, row.api_token, base + path, init, missing);
  const settings = (name) => call('/workers/scripts/' + name + '/settings', {}, true);
  const namespaceOf = (state) => {
    if (!state?.bindings?.some((binding) => binding.name === 'NODE_ID' && binding.text === row.id))
      fail('Worker 不属于此节点，已停止修改');
    const id = state.bindings.find((binding) => binding.name === 'STORAGE')?.namespace_id;
    if (!/^[a-f0-9]{32}$/.test(id || '')) fail('无法确认原 DO 命名空间，已停止修改');
    return id;
  };
  try {
    const original = await settings(row.worker_name);
    const renamed = await settings(target);
    if (!original && !renamed) fail('未找到原 Worker，请先检查节点部署');
    const namespace = namespaceOf(original || renamed);
    if (renamed && (namespaceOf(renamed) !== namespace || original))
      fail('目标 Worker 名称已存在，已停止覆盖');
    const pagesPath = '/pages/projects/' + target;
    let project = await call(pagesPath, {}, true);
    if (
      project &&
      (project.deployment_configs?.production?.env_vars?.NODE_ID?.value !== row.id ||
        project.deployment_configs?.production?.durable_object_namespaces?.STORAGE?.namespace_id !==
          namespace)
    )
      fail('目标 Pages 项目不属于此节点或 DO 不一致，已停止覆盖');
    if (!project) {
      const config = {
        compatibility_date: '2025-09-01',
        env_vars: {
          NODE_ID: { type: 'plain_text', value: row.id },
          NODE_SECRET: { type: 'secret_text', value: row.node_secret },
        },
        durable_object_namespaces: { STORAGE: { namespace_id: namespace } },
      };
      project = await call('/pages/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: target,
          production_branch: 'main',
          deployment_configs: { production: config, preview: config },
        }),
      });
    }
    if (project.subdomain !== target + '.pages.dev') fail('新 Pages 域名与节点名称不一致');
    const form = new FormData();
    form.set('manifest', '{}');
    form.set('branch', 'main');
    form.set(
      '_worker.js',
      new Blob([storagePagesSource], { type: 'application/javascript+module' }),
      '_worker.js',
    );
    let deployment = await call(pagesPath + '/deployments', { method: 'POST', body: form });
    if (!deployment?.id) fail('Pages 未返回部署标识，请重试', 502);
    for (let attempt = 0; attempt < 5 && deployment.latest_stage?.status !== 'success'; attempt++) {
      if (['failure', 'canceled'].includes(deployment.latest_stage?.status))
        fail('新 Pages 发布失败，请重试', 502);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      deployment = await call(pagesPath + '/deployments/' + deployment.id);
    }
    if (deployment.latest_stage?.status !== 'success')
      fail('新 Pages 仍在发布，原地址保留，请稍后重试', 503);
    const url = 'https://' + target + '.pages.dev';
    await check({ ...row, worker_name: target, url }, fetcher);
    if (original) {
      const before = await call('/workers/workers/' + row.worker_name);
      const after = await call('/workers/workers/' + row.worker_name, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: target }),
      });
      if (!before?.id || after?.id !== before.id || after.name !== target)
        fail('Worker 改名结果未确认，请重试以继续校验', 502);
    }
    if (namespaceOf(await settings(target)) !== namespace)
      fail('DO 命名空间校验失败，已停止切换', 502);
    const saved = await env.DB.prepare(
      "UPDATE storage_nodes SET worker_name=?,url=?,status='ready',last_error=NULL,checked_at=?,updated_at=? WHERE id=? AND status='renaming' AND updated_at=?",
    )
      .bind(target, url, Date.now(), Date.now(), row.id, now)
      .run();
    if (!saved.meta.changes) fail('节点状态已变化，请刷新后重试以确认新地址');
    return json({
      success: true,
      worker_name: target,
      url,
      namespace_preserved: true,
      old_entry_retained: true,
    });
  } catch (error) {
    // Restore eligibility; the original Pages entry continues to bind the very same namespace.
    await env.DB.prepare(
      "UPDATE storage_nodes SET status=?,last_error=?,updated_at=? WHERE id=? AND status='renaming' AND updated_at=?",
    )
      .bind(
        row.status === 'renaming' ? 'ready' : row.status,
        error instanceof HttpError
          ? '改名未完成：' + error.message
          : '改名未完成，请重试；原入口保留',
        Date.now(),
        row.id,
        now,
      )
      .run();
    if (error instanceof HttpError) throw error;
    fail('节点改名中断，请重试；已创建的新入口会复用', 502);
  }
}
