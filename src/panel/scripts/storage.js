export const storageScript = String.raw`let storageEditingNode = null;
let storageTokenView = null;
function resetStorageForm() {
  if (storageTokenView) {
    storageTokenView.inputs.token.value = '';
    storageTokenView.detail.remove();
    storageTokenView = null;
  }
  storageEditingNode = null;
  for (const id of ['storageEmail', 'storageToken', 'storageAccountId']) el(id).value = '';
  el('storageAccount').replaceChildren();
  el('storageAccount').hidden = true;
  el('storageAccount').required = false;
  el('storageAccountLabel').hidden = true;
  el('storageCreate').textContent = '自动创建 Pages 入口和 DO';
  el('storageCancel').hidden = true;
}
function editStorageToken(row, tr) {
  resetStorageForm();
  storageEditingNode = row.id;
  storageTokenView = nearbyEditor(
    tr,
    'storage:' + row.id,
    7,
    row.email + ' · 更新 Token',
    [
      {
        name: 'token',
        label: 'Cloudflare API Token（验证后替换已保存值）',
        type: 'password',
        required: true,
        minLength: 20,
        maxLength: 512,
      },
    ],
    async (inputs) => {
      try {
        status('正在验证 Token 并重新部署此节点…');
        const value = await api('/admin/storage-nodes/' + row.id + '/deploy', 'POST', {
          token: inputs.token.value.trim(),
        });
        await loadStorageNodes();
        status(
          value.deployment_pending
            ? 'Pages 正在发布，请稍后点击检查连接。'
            : 'Token 已更新，节点连接验证通过。',
        );
      } finally {
        inputs.token.value = '';
      }
    },
    () => {
      if (storageTokenView) storageTokenView.inputs.token.value = '';
      storageEditingNode = null;
      storageTokenView = null;
    },
  );
}
el('storageCancel').onclick = resetStorageForm;
function renderPrimaryStorageNode(row) {
  const tr = document.createElement('tr');
  const text = (value) => {
    const td = document.createElement('td');
    td.textContent = value;
    return td;
  };
  const name = text(row.name),
    entry = document.createElement('td'),
    link = document.createElement('a');
  link.href = row.url + '/panel/overview';
  link.textContent = new URL(row.url).hostname;
  entry.append(link);
  const usage = document.createElement('td'),
    data = row.usage;
  const bytes = (n) =>
    n < 1024
      ? n + ' B'
      : n < 1048576
        ? (n / 1024).toFixed(1) + ' KB'
        : (n / 1048576).toFixed(2) + ' MB';
  if (data?.available) {
    const lines = [
      '今日已汇总用量 ' + data.today_requests.toLocaleString() + ' 次',
      '待落盘 ' + data.pending_requests.toLocaleString() + ' 次 / ' + data.pending_buckets + ' 桶',
      '用量缓冲 ' + data.buffer_buckets + ' 桶 · ' + bytes(data.buffer_bytes),
      '额度缓存 ' +
        data.quota_entries +
        ' 条 · ' +
        bytes(data.quota_bytes) +
        '；历史快照 ' +
        bytes(data.history_bytes),
      '本次实例接口读/写 ' +
        data.activity.reads.toLocaleString() +
        '/' +
        data.activity.writes.toLocaleString() +
        ' · 错误 ' +
        data.activity.errors,
      '历史同步：' + formatReset(data.history_synced_at),
    ];
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      usage.append(div);
    }
    usage.title =
      '接口计数起始：' +
      formatReset(data.activity.started_at) +
      '；最近使用：' +
      formatReset(data.activity.last_activity) +
      '；下次落盘：' +
      formatReset(data.next_flush_at);
  } else usage.textContent = data?.reason || '尚未采集';
  const actions = document.createElement('td'),
    overview = document.createElement('a');
  overview.href = '/panel/overview';
  overview.textContent = '用量概览';
  actions.append(overview);
  tr.append(
    name,
    entry,
    text('主账号配置'),
    text('固定主节点 · 汇总 / D1 落盘'),
    usage,
    text(formatReset(data?.sampled_at)),
    actions,
  );
  return tr;
}
let storageLastLoadedAt = 0;
async function loadStorageNodes(fresh = false) {
  const value = await api('/admin/storage-nodes' + (fresh ? '?usage_fresh=1' : ''));
  storageLastLoadedAt = Date.now();
  const nextNode = value.nodes.find((node) => node.id === value.next_node_id);
  el('storageSchedule').textContent = value.active_node_id
    ? '下次调度：' +
      formatReset(value.switches_at) +
      '；预计节点：' +
      (nextNode?.email || '整点前一分钟确定') +
      (value.schedule_basis === 'daily_requests'
        ? '；按当日业务请求数择低值班'
        : value.schedule_basis === 'single_node'
          ? '；单节点值班'
          : '；用量暂不可读时按轮换兜底')
    : '当前没有可用子节点，回退主节点。';
  if (storageTokenView) resetStorageForm();
  el('storageNodes').replaceChildren();
  if (value.primary_node) el('storageNodes').append(renderPrimaryStorageNode(value.primary_node));
  for (const row of value.nodes) {
    const tr = document.createElement('tr');
    const localRun = (action) => runNear('storage:' + row.id, action);
    const account = document.createElement('td');
    account.textContent = row.email + ' · ' + row.account_id;
    const worker = document.createElement('td');
    const link = document.createElement('a');
    link.href =
      'https://dash.cloudflare.com/' +
      encodeURIComponent(row.account_id) +
      '/workers/services/view/' +
      encodeURIComponent(row.worker_name) +
      '/production';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = row.worker_name;
    if (row.url) {
      const entry = document.createElement('a');
      entry.href = row.url;
      entry.target = '_blank';
      entry.rel = 'noopener noreferrer';
      entry.textContent = new URL(row.url).hostname;
      worker.append(entry, document.createElement('br'));
    }
    worker.append(link);
    const savedToken = document.createElement('td');
    savedToken.textContent = row.has_token ? '已保存' : '需补填';
    const state = document.createElement('td');
    state.textContent =
      ({
        ready:
          row.id === value.active_node_id
            ? '当前值班 · 用量 / 日志 / 缓存'
            : row.activated_at > Math.floor(Date.now() / 3600000) * 3600000
              ? '已接入 · 下个整点参与'
              : '已接入 · 等待轮换',
        provisioning: '创建中',
        pending: '等待部署完成 / 检查连接',
        error: '需处理',
      }[row.status] || row.status) + (row.last_error ? '：' + row.last_error : '');
    const usage = document.createElement('td');
    if (row.usage?.available) {
      const data = row.usage,
        today = data.today;
      const reads = today.reads || 0;
      const hitRate = reads ? ((100 * today.hits) / reads).toFixed(1) + '%' : '—';
      const bytes = data.cache_bytes || 0;
      const size =
        bytes < 1024
          ? bytes + ' B'
          : bytes < 1048576
            ? (bytes / 1024).toFixed(1) + ' KB'
            : (bytes / 1048576).toFixed(2) + ' MB';
      const lines = [
        '约 ' +
          today.requests.toLocaleString() +
          ' 次 · 命中 ' +
          today.hits.toLocaleString() +
          '/' +
          reads.toLocaleString() +
          '（' +
          hitRate +
          '）',
        '写入 ' +
          today.writes.toLocaleString() +
          ' · 错误 ' +
          today.errors.toLocaleString() +
          ' · 缓存迁入/出 ' +
          today.imports +
          '/' +
          today.exports,
        '有效缓存 ' + data.cache_entries + ' 条 · ' + size,
        '最近使用：' + formatReset(data.last_activity),
      ];
      if (data.telemetry?.supported)
        lines.unshift(
          '模型用量 ' +
            data.telemetry.today_requests.toLocaleString() +
            ' 次 · 待汇总 ' +
            data.telemetry.pending_requests.toLocaleString() +
            ' 次 / ' +
            data.telemetry.pending_buckets +
            ' 桶',
        );
      else lines.unshift('仅缓存功能 · 需重新部署以接收模型用量');
      if (data.telemetry?.supported)
        lines.push(
          '本节点问题记录 ' + (data.telemetry.events || 0).toLocaleString() + ' 条 · 保留 7 天',
        );
      for (const text of lines) {
        const line = document.createElement('div');
        line.textContent = text;
        usage.append(line);
      }
      usage.title =
        '统计日期：' +
        data.day +
        '；启用：' +
        formatReset(data.started_at) +
        '；采集：' +
        formatReset(data.sampled_at);
    } else usage.textContent = row.usage?.reason || '尚未采集';
    const checked = document.createElement('td');
    checked.textContent = formatReset(row.usage?.available ? row.usage.sampled_at : row.checked_at);
    checked.title = '最近连接检查：' + formatReset(row.checked_at);
    const actions = document.createElement('td');
    actions.className = 'actions';
    if (row.url) {
      const check = document.createElement('button');
      check.className = 'secondary';
      check.textContent = '检查连接';
      check.onclick = () =>
        localRun(async () => {
          try {
            await api('/admin/storage-nodes/' + row.id + '/check', 'POST');
          } finally {
            await loadStorageNodes();
          }
          status('节点 DO 读写检查通过。');
        });
      actions.append(check);
    }
    const deploy = document.createElement('button');
    deploy.className = 'secondary';
    deploy.textContent = '重新部署';
    deploy.disabled = row.status === 'provisioning';
    deploy.onclick = () => {
      if (!row.has_token) {
        editStorageToken(row, tr);
        return;
      }
      return localRun(async () => {
        status('正在使用已保存的 Token 重新部署…');
        let value;
        try {
          value = await api('/admin/storage-nodes/' + row.id + '/deploy', 'POST');
        } finally {
          await loadStorageNodes();
        }
        status(
          value.deployment_pending
            ? 'Pages 正在发布，请稍后点击检查连接，无需再次部署。'
            : 'Pages 节点已重新部署，DO 读写验证通过。',
        );
      });
    };
    const update = document.createElement('button');
    update.className = 'secondary';
    update.textContent = row.has_token ? '更新 Token' : '补填 Token';
    update.disabled = row.status === 'provisioning';
    update.onclick = () => editStorageToken(row, tr);
    actions.append(deploy, update);
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = '移除记录';
    remove.onclick = () => {
      if (confirm('移除 ' + row.email + ' 的节点配置？Cloudflare 上的 Pages、Worker 和 DO 保留。'))
        return localRun(async () => {
          await api('/admin/storage-nodes/' + row.id, 'DELETE');
          await loadStorageNodes();
          status('节点记录已移除，远端资源保留。');
        });
    };
    actions.append(remove);
    tr.append(account, worker, savedToken, state, usage, checked, actions);
    registerNearby('storage:' + row.id, actions);
    el('storageNodes').append(tr);
  }
  if (!value.nodes.length && !value.primary_node) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = '暂无其他账号的存储节点';
    tr.append(td);
    el('storageNodes').append(tr);
  }
}
el('storageRefresh').onclick = () =>
  run(() => {
    resetStorageForm();
    return loadStorageNodes(true);
  });
async function refreshVisibleStorage() {
  if (
    busy ||
    storageEditingNode ||
    Date.now() - storageLastLoadedAt < 30000 ||
    currentSection !== 'storage' ||
    el('workspace').hidden ||
    document.visibilityState !== 'visible'
  )
    return;
  await run(() => loadStorageNodes());
}
if (typeof setInterval === 'function')
  setInterval(() => {
    void refreshVisibleStorage();
  }, 30000);
if (typeof document.addEventListener === 'function')
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshVisibleStorage();
  });

registerNearby('storage-form', el('storageForm'));
el('storageForm').onsubmit = (event) => {
  event.preventDefault();
  return runNear('storage-form', async () => {
    let choose = false;
    try {
      status('正在识别账号并创建存储节点…');
      const value = await api('/admin/storage-nodes', 'POST', {
        node_id: storageEditingNode || undefined,
        redeploy: !!storageEditingNode,
        email: el('storageEmail').value.trim(),
        token: el('storageToken').value.trim(),
        account_id: el('storageAccountId').value.trim() || el('storageAccount').value || undefined,
      });
      if (value.selection_required) {
        choose = true;
        el('storageAccount').replaceChildren();
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '请选择账号';
        el('storageAccount').append(empty);
        for (const account of value.accounts) {
          const option = document.createElement('option');
          option.value = account.id;
          option.textContent = account.name + ' · ' + account.id;
          el('storageAccount').append(option);
        }
        el('storageAccountLabel').hidden = false;
        el('storageAccount').hidden = false;
        el('storageAccount').required = true;
        status('此 Token 可访问多个账号，请选择目标账号后再次创建。');
        return;
      }
      await loadStorageNodes();
      resetStorageForm();
      status(
        value.deployment_pending
          ? 'Pages 正在发布，请稍后点击检查连接，无需再次部署。'
          : value.reused
            ? '该账号已有就绪节点，已复用。'
            : 'Pages 入口和 DO 已创建，读写验证通过；节点已参与缓存轮换。',
      );
    } catch (error) {
      try {
        await loadStorageNodes();
      } catch {}
      throw error;
    } finally {
      if (!choose) el('storageToken').value = '';
    }
  });
};
`;
