export const keysScript = String.raw`let keyPage = 0;
let keysLoadVersion = 0;
let keysUsageFlight = Promise.resolve();
let selectedApiKey = null;
let revealedKeyId = null;
const masterKeyId = '00000000-0000-0000-0000-000000000000';
function clearKeySecret() {
  el('keyCreatedValue').textContent = '';
  el('keyCreatedArea').hidden = true;
  el('keyRevealValue').textContent = '';
  el('keyRevealArea').hidden = true;
  revealedKeyId = null;
}
function resetKeys() {
  keysLoadVersion++;
  clearKeySecret();
  keyPage = 0;
  selectedApiKey = null;
  for (const id of [
    'keyCreateName',
    'keyCreateExpiry',
    'keyImportData',
    'keyImportFile',
    'keysSearch',
  ])
    el(id).value = '';
  for (const id of ['keysBody', 'keyUsageModels', 'keyUsageDaily', 'keyUsageSummary'])
    el(id).replaceChildren();
  el('keyUsageArea').hidden = true;
}
function keyExpiry(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isSafeInteger(time)) throw new Error('到期时间格式无效');
  return time;
}
function keyAction(label, action, danger = false) {
  const button = document.createElement('button');
  button.textContent = label;
  button.className = danger ? 'danger' : 'secondary';
  button.onclick = () => run(action);
  return button;
}
async function loadKeys() {
  const version = ++keysLoadVersion;
  const params = new URLSearchParams({
    page: String(keyPage),
    search: el('keysSearch').value.trim(),
  });
  const value = await api('/admin/api-keys?' + params);
  if (version !== keysLoadVersion) return;
  el('keysBody').replaceChildren();
  el('keysCompatibility').textContent = value.master_enabled
    ? '原总密钥仍可使用，建议逐步为各项目配置独立密钥。'
    : '当前未配置总密钥，使用下方独立密钥访问接口。';
  const rows =
    value.master_enabled && keyPage === 0 && !params.get('search')
      ? [
          {
            id: masterKeyId,
            name: '总密钥（兼容）',
            masked_key: 'Cloudflare Secret',
            state: 'enabled',
            expires_at: null,
            master: true,
          },
          ...value.keys,
        ]
      : value.keys;
  const cells = new Map();
  el('keysUsageNote').textContent = rows.length ? '密钥列表已加载，正在读取最新用量…' : '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const text of [
      row.name,
      row.masked_key,
      { enabled: '启用', disabled: '已停用', expired: '已到期' }[row.state],
      row.expires_at == null ? '永不过期' : formatReset(row.expires_at),
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    const consumption = document.createElement('td');
    renderKeyConsumption(consumption, null, 'loading');
    cells.set(row.id, consumption);
    tr.insertBefore(consumption, tr.children[1]);
    const actions = document.createElement('td');
    actions.append(
      keyAction('用量明细', async () => {
        selectedApiKey = { id: row.id, name: row.name };
        await loadKeyUsage(true);
        el('keyUsageArea').scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      }),
    );
    if (!row.master) {
      const more = document.createElement('details');
      more.className = 'row-menu';
      const summary = document.createElement('summary');
      summary.textContent = '更多';
      more.append(summary);
      const extraActions = document.createElement('div');
      extraActions.className = 'action-menu';
      more.append(extraActions);
      if (row.can_reveal)
        actions.append(
          keyAction('查看密钥', async () => {
            clearKeySecret();
            const value = await api('/admin/api-keys/' + row.id + '/reveal', 'POST');
            revealedKeyId = row.id;
            el('keyRevealName').textContent = row.name + ' · 完整密钥';
            el('keyRevealValue').textContent = value.key;
            el('keyRevealArea').hidden = false;
          }),
        );
      extraActions.append(
        keyAction('改名', async () => {
          const name = prompt('输入密钥名称', row.name);
          if (name == null) return;
          await api('/admin/api-keys/' + row.id, 'PATCH', { name });
          if (selectedApiKey?.id === row.id) {
            selectedApiKey.name = name.trim();
            el('keyUsageTitle').textContent = selectedApiKey.name + ' · 用量统计';
          }
          await loadKeys();
        }),
      );
      extraActions.append(
        keyAction('到期时间', async () => {
          const local =
            row.expires_at == null
              ? ''
              : new Date(row.expires_at - new Date(row.expires_at).getTimezoneOffset() * 60000)
                  .toISOString()
                  .slice(0, 16);
          const value = prompt(
            '输入到期时间（本地时间，例如 2026-12-31T23:59）；留空表示永不过期',
            local,
          );
          if (value == null) return;
          await api('/admin/api-keys/' + row.id, 'PATCH', { expires_at: keyExpiry(value.trim()) });
          await loadKeys();
        }),
      );
      actions.append(
        keyAction(row.enabled ? '停用' : '启用', async () => {
          await api('/admin/api-keys/' + row.id, 'PATCH', { enabled: !row.enabled });
          await loadKeys();
          status(
            row.enabled
              ? '密钥已停用，后续请求将被拒绝。'
              : '密钥已启用；到期密钥仍需修改到期时间。',
          );
        }),
      );
      extraActions.append(
        keyAction(
          '删除',
          async () => {
            if (!confirm('确认删除密钥“' + row.name + '”？后续请求将被拒绝，历史用量会保留。'))
              return;
            await api('/admin/api-keys/' + row.id, 'DELETE');
            if (revealedKeyId === row.id) clearKeySecret();
            if (selectedApiKey?.id === row.id) {
              selectedApiKey = null;
              el('keyUsageArea').hidden = true;
            }
            await loadKeys();
          },
          true,
        ),
      );
      actions.append(more);
    }
    tr.append(actions);
    el('keysBody').append(tr);
  }
  el('keysEmpty').hidden = !!rows.length;
  el('keysPrev').disabled = keyPage === 0;
  el('keysNext').disabled = !value.has_next;
  el('keysPageInfo').textContent = '第 ' + (keyPage + 1) + ' 页 · 每页 50 个独立密钥';
  status('API 密钥列表已加载。');
  keysUsageFlight = (async () => {
    if (!rows.length) return;
    try {
      const params = new URLSearchParams({
        api_key_ids: rows.map((row) => row.id).join(','),
        from: String(Math.floor(Date.now() / 300000) * 300000 - 30 * 86400000),
      });
      const totals = await api('/admin/stats?' + params);
      if (version !== keysLoadVersion) return;
      const usage = new Map(totals.api_keys.map((row) => [row.api_key_id, row]));
      for (const [id, cell] of cells) renderKeyConsumption(cell, usage.get(id), 'ready');
      el('keysUsageNote').textContent =
        '消耗统计：最近 30 天，上游报告总 Token，包含 DO 待落盘用量；未报告部分不估算，非 Google 账号剩余额度。';
    } catch {
      if (version !== keysLoadVersion) return;
      for (const cell of cells.values()) renderKeyConsumption(cell, null, 'failed');
      el('keysUsageNote').textContent = '用量暂不可用，可刷新列表重试；密钥管理仍可使用。';
    }
  })();
}
function renderKeyConsumption(cell, metric, state) {
  const amount = document.createElement('div'),
    coverage = document.createElement('small');
  coverage.className = 'data-note';
  amount.textContent =
    state === 'loading'
      ? '读取中…'
      : state === 'failed'
        ? '暂不可用'
        : !metric?.requests
          ? '0 Token'
          : metric.total_tokens == null
            ? '未报告'
            : tokenText(metric.total_tokens) + ' Token';
  coverage.textContent =
    state === 'loading'
      ? '正在汇总最新用量'
      : state === 'failed'
        ? '统计获取失败'
        : (metric?.requests || 0).toLocaleString('zh-CN') +
          ' 次请求' +
          (metric?.requests > (metric?.token_reports || 0) ? ' · 部分用量未报告' : '');
  cell.replaceChildren(amount, coverage);
}
async function loadKeyUsage(fresh = false) {
  if (!selectedApiKey) return;
  el('keyUsageArea').hidden = false;
  el('keyUsageTitle').textContent = selectedApiKey.name + ' · 用量统计';
  for (const id of ['keyUsageSummary', 'keyUsageModels', 'keyUsageDaily']) el(id).replaceChildren();
  el('keyUsageNote').textContent = '正在查询用量…';
  const params = new URLSearchParams({
    api_key_id: selectedApiKey.id,
    from: String(
      Math.floor(Date.now() / 300000) * 300000 - Number(el('keyUsageDays').value || 7) * 86400000,
    ),
  });
  if (fresh) params.set('fresh', '1');
  const value = await api('/admin/api-keys/usage?' + params),
    s = value.summary;
  for (const [label, text] of [
    ['请求数', s.requests],
    ['成功 / 失败 / 取消', [s.successes, s.failures, s.cancellations].join(' / ')],
    ['总 Token', tokenText(s.total_tokens)],
  ]) {
    const box = document.createElement('a');
    box.className = 'metric';
    bindMetricLink(
      box,
      'keys',
      {},
      label === '总 Token' ? 'keyUsageModelsHeading' : 'keyUsageDailyDetails',
    );
    const name = document.createElement('small');
    name.textContent = label;
    const number = document.createElement('strong');
    number.textContent = text;
    box.append(name, number);
    el('keyUsageSummary').append(box);
  }
  for (const row of value.models) metricsRow('keyUsageModels', row.mode + ' / ' + row.model, row);
  for (const row of value.days) metricsRow('keyUsageDaily', row.day, row);
  el('keyUsageNote').textContent =
    (value.aggregation_seconds ? '5 分钟聚合，已包含 DO 待落盘数据。' : '明细模式。') +
    '未报告的 Token 不作估算。' +
    (value.groups_truncated ? '分组过多，部分模型未显示。' : '');
  status('密钥用量已刷新。');
}
el('keyCreateForm').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    clearKeySecret();
    const value = await api('/admin/api-keys', 'POST', {
      name: el('keyCreateName').value.trim(),
      expires_at: keyExpiry(el('keyCreateExpiry').value),
    });
    el('keyCreatedValue').textContent = value.key;
    el('keyCreatedArea').hidden = false;
    el('keyCreateName').value = '';
    el('keyCreateExpiry').value = '';
    keyPage = 0;
    await loadKeys();
    status('密钥已创建，可在列表中重新查看。');
  });
};
el('keyDismiss').onclick = clearKeySecret;
el('keyRevealDismiss').onclick = clearKeySecret;
el('keyRevealCopy').onclick = () =>
  run(async () => {
    const value = el('keyRevealValue').textContent;
    if (!value) return;
    if (!navigator.clipboard?.writeText) {
      status('请手动复制上方密钥。');
      return;
    }
    await navigator.clipboard.writeText(value);
    status('密钥已复制。');
  });
el('keyCopy').onclick = () =>
  run(async () => {
    if (!el('keyCreatedValue').textContent) return;
    if (!navigator.clipboard?.writeText) {
      status('请选中上方密钥手动复制。');
      return;
    }
    await navigator.clipboard.writeText(el('keyCreatedValue').textContent);
    status('密钥已复制。');
  });
el('keyImportFile').onchange = () =>
  run(async () => {
    const file = el('keyImportFile').files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      el('keyImportFile').value = '';
      throw new Error('导入文件不能超过 4 MiB');
    }
    el('keyImportData').value = await file.text();
    el('keyImportFile').value = '';
  });
el('keyImport').onclick = () =>
  run(async () => {
    const value = await api('/admin/api-keys/import', 'POST', {
      data: el('keyImportData').value,
      format: el('keyImportFormat').value || 'plain',
    });
    el('keyImportData').value = '';
    el('keyImportFile').value = '';
    keyPage = 0;
    await loadKeys();
    status('已导入 ' + value.imported + ' 个密钥，跳过 ' + value.duplicates + ' 个重复项。');
  });
el('keysRefresh').onclick = () => run(loadKeys);
el('keysSearchButton').onclick = () =>
  run(async () => {
    keyPage = 0;
    await loadKeys();
  });
el('keysPrev').onclick = () =>
  run(async () => {
    if (keyPage > 0) {
      keyPage--;
      await loadKeys();
    }
  });
el('keysNext').onclick = () =>
  run(async () => {
    if (!el('keysNext').disabled) {
      keyPage++;
      await loadKeys();
    }
  });
el('keyUsageRefresh').onclick = () => run(() => loadKeyUsage(true));
el('keyUsageDays').onchange = () => run(() => loadKeyUsage(true));
`;
