export const storageScript = String.raw`let storageEditingNode = null;
function resetStorageForm() {
  storageEditingNode = null;
  for (const id of ['storageEmail', 'storageToken', 'storageAccountId']) el(id).value = '';
  el('storageAccount').replaceChildren();
  el('storageAccount').hidden = true;
  el('storageAccount').required = false;
  el('storageAccountLabel').hidden = true;
  el('storageCreate').textContent = '自动创建 Pages 入口和 DO';
  el('storageCancel').hidden = true;
}
function editStorageToken(row) {
  resetStorageForm();
  storageEditingNode = row.id;
  el('storageEmail').value = row.email;
  el('storageAccountId').value = row.account_id;
  el('storageCreate').textContent = '保存 Token 并重新部署';
  el('storageCancel').hidden = false;
  el('storageToken').focus();
  status(
    row.has_token
      ? '填写新 Token 后保存，原 Token 会在账号验证通过后替换。'
      : '此旧节点尚未保存 Token，请补填一次；之后可直接重新部署。',
  );
}
el('storageCancel').onclick = resetStorageForm;
async function loadStorageNodes() {
  const value = await api('/admin/storage-nodes');
  el('storageNodes').replaceChildren();
  for (const row of value.nodes) {
    const tr = document.createElement('tr');
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
        ready: row.id === value.active_node_id ? '使用中 · 缓存节点' : '已接入 · 等待轮换',
        provisioning: '创建中',
        pending: '等待部署完成 / 检查连接',
        error: '需处理',
      }[row.status] || row.status) + (row.last_error ? '：' + row.last_error : '');
    const checked = document.createElement('td');
    checked.textContent = formatReset(row.checked_at);
    const actions = document.createElement('td');
    actions.className = 'actions';
    if (row.url) {
      const check = document.createElement('button');
      check.className = 'secondary';
      check.textContent = '检查连接';
      check.onclick = () =>
        run(async () => {
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
        editStorageToken(row);
        return;
      }
      return run(async () => {
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
    update.onclick = () => editStorageToken(row);
    actions.append(deploy, update);
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = '移除记录';
    remove.onclick = () => {
      if (confirm('移除 ' + row.email + ' 的节点配置？Cloudflare 上的 Pages、Worker 和 DO 保留。'))
        return run(async () => {
          await api('/admin/storage-nodes/' + row.id, 'DELETE');
          await loadStorageNodes();
          status('节点记录已移除，远端资源保留。');
        });
    };
    actions.append(remove);
    tr.append(account, worker, savedToken, state, checked, actions);
    el('storageNodes').append(tr);
  }
  if (!value.nodes.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = '暂无其他账号的存储节点';
    tr.append(td);
    el('storageNodes').append(tr);
  }
}
el('storageRefresh').onclick = () => run(loadStorageNodes);
el('storageForm').onsubmit = (event) => {
  event.preventDefault();
  return run(async () => {
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
