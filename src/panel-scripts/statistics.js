import { analyticsScript } from '../panel-analytics.js';
export const statisticsScript = String.raw`function panelFilters(prefix) {
  const params = new URLSearchParams();
  if (prefix === 'stats' && el('statsApiKey').value)
    params.set('api_key_id', el('statsApiKey').value);
  if (prefix === 'calls' && el('callsScope').value !== 'all') params.set('issues', '1');
  for (const [suffix, key] of [
    ['Email', 'email'],
    ['Model', 'model'],
    ['Mode', 'mode'],
    ...(prefix === 'calls'
      ? [
          ['Status', 'status'],
          ['Stage', 'stage'],
          ['Request', 'request_id'],
        ]
      : []),
  ]) {
    const value = el(prefix + suffix).value.trim();
    if (value) params.set(key, value);
  }
  for (const [suffix, key] of [
    ['From', 'from'],
    ['To', 'to'],
  ]) {
    const value = el(prefix + suffix).value;
    if (value) {
      const time = new Date(value).getTime();
      if (!Number.isFinite(time)) throw new Error('时间格式无效');
      params.set(key, String(time));
    }
  }
  if (prefix === 'calls' && el('callsCredential').value)
    params.set('credential_id', el('callsCredential').value);
  return params;
}
function tableRow(body, values) {
  const tr = document.createElement('tr');
  for (const value of values) {
    const td = document.createElement('td');
    td.textContent = String(value);
    tr.append(td);
  }
  el(body).append(tr);
  return tr;
}
const tokenText = (value) => (value == null ? '未报告' : Number(value).toLocaleString('zh-CN'));
const successRate = (row) =>
  row.requests ? ((100 * row.successes) / row.requests).toFixed(1) + '%' : '—';
${analyticsScript}
function metricsRow(body, label, row) {
  return tableRow(body, [
    label,
    [row.requests, row.successes || 0, row.failures || 0, row.cancellations || 0].join(' / '),
    successRate(row),
    [row.input_tokens, row.output_tokens, row.thought_tokens, row.total_tokens]
      .map(tokenText)
      .join(' / '),
    (row.avg_duration_ms ?? 0) + ' ms',
  ]);
}
async function loadStats(fresh = false) {
  const params = panelFilters('stats');
  if (!params.has('from'))
    params.set('from', String(Math.floor(Date.now() / 300000) * 300000 - 7 * 86400000));
  if (fresh) params.set('fresh', '1');
  const value = await api('/admin/stats?' + params);
  for (const row of value.api_keys || [])
    if (row.api_key_id) statsKeyNames.set(row.api_key_id, row.display_name);
  const chosen = el('statsApiKey').value;
  el('statsApiKey').replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部密钥';
  el('statsApiKey').append(all);
  for (const [id, name] of statsKeyNames) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    el('statsApiKey').append(option);
  }
  if (chosen && !statsKeyNames.has(chosen)) {
    const option = document.createElement('option');
    option.value = chosen;
    option.textContent = '所选密钥';
    el('statsApiKey').append(option);
  }
  el('statsApiKey').value = chosen;
  const s = value.summary;
  el('statsSummary').replaceChildren();
  for (const [label, text] of [
    ['请求数', compact(s.requests)],
    ['成功率', successRate(s)],
    ['失败 / 取消', (s.failures || 0) + ' / ' + (s.cancellations || 0)],
    ['上游报告总 Token', compact(s.total_tokens)],
    ['有用量报告的请求', (s.token_reports || 0) + ' / ' + s.requests],
    ['平均耗时', duration(s.avg_duration_ms)],
  ]) {
    const box = document.createElement('a');
    box.className = 'metric';
    bindMetricLink(
      box,
      label === '失败 / 取消' ? 'logs' : 'overview',
      label === '失败 / 取消'
        ? {
            scope: 'issues',
            status: '',
            model: '',
            mode: '',
            request_id: '',
            email: '',
            stage: '',
            credential_id: '',
            from: '',
            to: '',
          }
        : {},
      label === '失败 / 取消' ? null : 'statsDetails',
    );
    const name = document.createElement('small');
    name.textContent = label;
    const number = document.createElement('strong');
    number.textContent = String(text);
    number.title = label === '上游报告总 Token' ? tokenText(s.total_tokens) : String(text);
    box.append(name, number);
    el('statsSummary').append(box);
  }
  el('statsBuffer').textContent =
    value.storage_mode === 'aggregate' || (!value.storage_mode && value.aggregation_seconds)
      ? '聚合模式 · 5 分钟粒度 · 待落盘累计请求：' +
        value.pending_requests +
        '（已包含在统计中，含同时间桶已落盘部分）'
      : '明细模式 · 逐请求保存';
  renderStatsCharts(value);
  status(
    '统计已刷新；自动加载可复用 60 秒缓存，手动刷新直接查询。' +
      (value.groups_truncated ? '模型、账号或密钥分组超过 200 项，请缩小筛选范围。' : ''),
  );
}
el('statsApiKey').onchange = () =>
  run(async () => {
    const params = new URLSearchParams(location.search || '');
    if (el('statsApiKey').value) params.set('api_key_id', el('statsApiKey').value);
    else params.delete('api_key_id');
    if (typeof history !== 'undefined')
      history.replaceState({}, '', location.pathname + (params.size ? '?' + params : ''));
    await loadStats();
  });
el('statsRefresh').onclick = () => run(() => loadStats(true));
el('statsFlush').onclick = () =>
  run(async () => {
    const value = await api('/admin/telemetry/flush', 'POST');
    await loadStats(true);
    status(
      '已落盘 ' +
        value.buckets_flushed +
        ' 个汇总时间桶。' +
        (value.pending ? '仍有待落盘汇总，将继续自动处理。' : ''),
    );
  });
el('callsExport').onclick = () =>
  run(async () => {
    const value = await api('/admin/calls/export?' + panelFilters('calls'));
    downloadJson(value, 'issue-events-' + Date.now() + '.json');
    status('已导出 ' + value.records.length + ' 条日志。');
  });
el('callsClear').onclick = () => {
  if (confirm('确认清理当前范围及筛选匹配的问题记录？用量统计与健康摘要会保留。'))
    return run(async () => {
      const value = await api('/admin/calls?' + panelFilters('calls'), 'DELETE', {
        confirm: 'delete-matching-logs',
      });
      await loadCalls();
      status('已删除 ' + value.deleted + ' 条问题记录，用量统计和健康摘要已保留。');
    });
};
for (const suffix of [
  'Scope',
  'Email',
  'Model',
  'Mode',
  'Status',
  'Stage',
  'Request',
  'From',
  'To',
])
  el('calls' + suffix).onchange = () => {
    nextCall = null;
    el('callsNext').hidden = true;
    el('callsBody').replaceChildren();
  };
`;
