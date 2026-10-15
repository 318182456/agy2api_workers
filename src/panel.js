import { panelStyle } from './panel-style.js';
import { panelPages, panelFrame } from './panel-views.js';
export { isPanelPath } from './panel-views.js';

export const panel = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GCLI2API Workers</title><style>${panelStyle}</style></head><body>
${panelFrame}
<script>
const pageDefinitions = ${JSON.stringify(panelPages)};
const el = id => document.getElementById(id);
const status = text => { el('status').textContent = text; };
let credentialsSnapshot = [];
let oauthClientModes = {};
const selectedCredentials = new Set();
let stopBatch = false;
let duplicateSnapshot = [];
let settingsLoaded = false;
let busy = false;

let currentPage = 'overview';
const loadedPages = new Set();
function pageFromLocation() { const path = (location.pathname || '/').replace(/\/$/, ''); return pageDefinitions.find(page => page.path === path)?.id || 'overview'; }
function showPage(id, historyMode = 'push') {
  const page = pageDefinitions.find(page => page.id === id) || pageDefinitions[0];
  currentPage = page.id;
  for (const item of pageDefinitions) {
    el('page-'+item.id).hidden = item.id !== page.id;
    if (item.id === page.id) el('nav-'+item.id).setAttribute('aria-current','page'); else el('nav-'+item.id).removeAttribute('aria-current');
  }
  el('pageTitle').textContent = page.title; el('pageDescription').textContent = page.description; el('pageBreadcrumb').textContent = page.title;
  document.title = page.title+' · GCLI2API Workers';
  if (historyMode && typeof scrollTo === 'function') scrollTo({top:0,behavior:'auto'});
  if (historyMode && typeof history !== 'undefined' && location.pathname !== page.path) history[historyMode === 'replace' ? 'replaceState' : 'pushState']({page:page.id},'',page.path);
}
async function loadPage(id) {
  if (loadedPages.has(id)) return;
  status('正在加载'+(pageDefinitions.find(page=>page.id===id)?.title || '页面')+'…');
  if (id === 'overview') { await refresh(); await loadStats(); }
  else if (id === 'credentials') await refresh();
  else if (id === 'logs') { await refresh(); await loadCalls(); }
  else if (id === 'import') { const value = await api('/admin/credentials'); oauthClientModes = value.oauth_clients || {}; status('页面已就绪。'); }
  else if (id === 'settings') { fillSettings(await api('/admin/settings')); status('设置已加载。'); }
  else status('页面已就绪。');
  loadedPages.add(id);
}
async function openWorkspace() {
  el('loginCard').hidden = true; el('workspace').hidden = false;
  showPage(pageFromLocation(), 'replace'); await loadPage(currentPage);
}
function followPage(id, event) {
  if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || (event.button != null && event.button !== 0))) return;
  event?.preventDefault();
  if (busy) { status('当前操作进行中，请完成或停止后再切换页面。'); return; }
  showPage(id); el('pageTitle').focus?.(); return run(()=>loadPage(id));
}
for (const page of pageDefinitions) el('nav-'+page.id).onclick = event => followPage(page.id,event);
for (const link of document.querySelectorAll('[data-page-link]')) link.onclick = event => followPage(link.dataset.pageLink,event);
if (typeof addEventListener !== 'undefined') addEventListener('popstate',()=>{ showPage(pageFromLocation(),null); if (!el('workspace').hidden) run(()=>loadPage(currentPage)); });
function selectStatsTab(id) {
  for (const key of ['days','models','credentials']) {
    el('stats-view-'+key).hidden = key !== id;
    el('stats-tab-'+key).setAttribute('aria-selected',String(key===id));
    el('stats-tab-'+key).tabIndex = key === id ? 0 : -1;
  }
}
for (const id of ['days','models','credentials']) {
  el('stats-tab-'+id).onclick = ()=>selectStatsTab(id);
  el('stats-tab-'+id).onkeydown = event => {
    const keys=['days','models','credentials']; let index=keys.indexOf(id);
    if (event.key==='ArrowRight') index=(index+1)%keys.length;
    else if (event.key==='ArrowLeft') index=(index+2)%keys.length;
    else if (event.key==='Home') index=0;
    else if (event.key==='End') index=2; else return;
    event.preventDefault(); selectStatsTab(keys[index]); el('stats-tab-'+keys[index]).focus?.();
  };
}
selectStatsTab('days');
for (const button of document.querySelectorAll('[data-copy]')) button.onclick = ()=>run(async()=>{
  const text=el(button.dataset.copy).textContent;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); status('接口地址已复制。'); }
  else status('请复制接口地址：'+text);
});

async function api(path, method = 'GET', body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (response.status === 401) { loadedPages.clear(); el('workspace').hidden = true; el('loginCard').hidden = false; }
  if (!response.ok) throw new Error((value.error?.message || 'HTTP ' + response.status) + (value.error?.stage ? ' [阶段：' + value.error.stage + ']' : '') + (value.error?.request_id ? ' [请求ID：' + value.error.request_id + ']' : ''));
  return value;
}
async function run(action) {
  if (busy) return; busy = true;
  const buttons = Array.from(document.querySelectorAll('button'));
  buttons.forEach(button => { button.disabled = true; });
  try { await action(); } catch (error) { status(error.message); }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
async function refresh() {
  const value = await api('/admin/credentials');
  credentialsSnapshot = value.credentials;
  oauthClientModes = value.oauth_clients || {};
  for (const id of selectedCredentials) if (!value.credentials.some(c => c.id === id)) selectedCredentials.delete(id);
  const selectedFilter = el('callsCredential').value;
  el('callsCredential').replaceChildren();
  const all = document.createElement('option'); all.value = ''; all.textContent = '全部凭证'; el('callsCredential').append(all);
  for (const item of value.credentials) { const option = document.createElement('option'); option.value = item.id; option.textContent = (item.user_email || item.name) + (item.user_email ? ' · ' + item.name : '') + ' · ' + item.mode; el('callsCredential').append(option); }
  el('callsCredential').value = value.credentials.some(c => c.id === selectedFilter) ? selectedFilter : '';
  renderCredentials();
  for (const target of ['overviewAccounts','credentialSummary']) {
    el(target).replaceChildren();
    for (const [label, count] of [['全部账号',value.credentials.length],['已启用',value.credentials.filter(c=>!c.disabled).length],['模型冷却中',value.credentials.filter(c=>c.cooling_models).length],['最近异常',value.credentials.filter(c=>c.last_failure>(c.last_success || 0)).length]]) {
      const box=document.createElement('div'); box.className='metric'; const title=document.createElement('small');title.textContent=label;const number=document.createElement('strong');number.textContent=String(count);box.append(title,number);el(target).append(box);
    }
  }
  status('已加载 '+value.credentials.length+' 个凭证。');
}
let credentialPage = 0;
function filteredCredentials() {
  const search=el('credentialSearch').value.trim().toLowerCase(),mode=el('credentialMode').value,state=el('credentialState').value;
  return credentialsSnapshot.filter(c=>(!search || [c.name,c.user_email,c.project_id].filter(Boolean).join(' ').toLowerCase().includes(search)) && (!mode || c.mode===mode)
    && (!state || (state==='enabled' && !c.disabled) || (state==='disabled' && c.disabled) || (state==='cooling' && c.cooling_models) || (state==='error' && c.last_failure>(c.last_success || 0))));
}
function visibleCredentials() { return filteredCredentials().slice(credentialPage*25,(credentialPage+1)*25); }
function renderCredentials() {
  const filtered=filteredCredentials(); credentialPage=Math.min(credentialPage,Math.max(0,Math.ceil(filtered.length/25)-1));
  el('credentials').replaceChildren(); el('credentialsEmpty').hidden=filtered.length>0;
  el('credentialCount').textContent='共 '+credentialsSnapshot.length+' 个账号 · 匹配 '+filtered.length+' 个';
  el('credentialPageInfo').textContent=filtered.length ? '第 '+(credentialPage+1)+' / '+Math.ceil(filtered.length/25)+' 页 · 每页 25 个' : '暂无账号';
  el('credentialsPrev').hidden=credentialPage===0; el('credentialsNext').hidden=(credentialPage+1)*25>=filtered.length;
  for (const credential of visibleCredentials()) {
    const tr = document.createElement('tr');
    const selection = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'credential-select'; checkbox.dataset.id = credential.id; checkbox.checked = selectedCredentials.has(credential.id); checkbox.setAttribute('aria-label', '选择 ' + (credential.user_email || credential.name)); checkbox.onchange = () => { if (checkbox.checked) selectedCredentials.add(credential.id); else selectedCredentials.delete(credential.id); updateSelection(); }; selection.append(checkbox); tr.append(selection);
    const testStatus = credential.last_test ? (credential.last_test.limited ? '；测试限流' : credential.last_test.success ? '；测试通过' : '；测试失败') : '';
    const observed = credential.last_failure && credential.last_failure > (credential.last_success || 0) ? '最近异常（HTTP ' + credential.last_failure_status + '）' : credential.last_success ? '最近成功' : '尚无生成观察';
    const values = [(credential.user_email || credential.name)+(credential.user_email ? '\n'+credential.name : ''), credential.mode,
      (credential.disabled ? '停用' : '启用')+' · '+observed+(credential.cooling_models ? '\n'+credential.cooling_models+' 个模型冷却中' : '')+testStatus,
      credential.last_success ? formatReset(credential.last_success) : '—'];
    for (const [index,text] of values.entries()) {
      const td=document.createElement('td');td.textContent=text;
      if (index===0) td.title='项目：'+(credential.project_id || '待校验')+' · 优先级 '+(credential.priority ?? 0)+' · 权重 '+(credential.weight ?? 1)+(credential.subscription_tier ? ' · 等级 '+credential.subscription_tier : '')+(credential.credit_amount != null ? ' · 积分 '+credential.credit_amount : '');
      tr.append(td);
    }
    const actions = document.createElement('td');
    const menu=document.createElement('details');menu.className='row-menu';const menuTitle=document.createElement('summary');menuTitle.textContent='更多操作';menu.append(menuTitle);const extraActions=document.createElement('div');extraActions.className='action-menu';menu.append(extraActions);
    const email = document.createElement('button'); email.className = 'secondary'; email.textContent = '获取邮箱';
    email.onclick = () => run(async () => { const result = await api('/admin/credentials/' + credential.id + '/email', 'POST', {}); await refresh(); status('邮箱：' + result.user_email); });
    const verify = document.createElement('button'); verify.className = 'secondary'; verify.textContent = '校验项目';
    verify.onclick = () => run(async () => { const result = await api('/admin/credentials/' + credential.id + '/verify', 'POST', {}); await refresh(); status('项目校验成功：' + result.project_id); });
    const test = document.createElement('button'); test.className = 'secondary'; test.textContent = '测试调用'; test.title = '向指定凭证发起一次 hi 请求，最多生成 1 token，会消耗少量额度';
    test.onclick = () => { if (confirm('将使用此凭证发起一次最小聊天请求，消耗少量额度，是否继续？')) run(async () => { const result = await api('/admin/credentials/' + credential.id + '/test', 'POST', {}); await refresh(); status(result.limited ? 'Google 返回 429：当前限流，不能证明本次生成可用。' : '指定凭证测试通过，模型：' + result.model); }); };
    const download = document.createElement('button'); download.className = 'secondary'; download.textContent = '下载凭证';
    download.onclick = () => run(async () => { const credentialData = await api('/admin/credentials/' + credential.id + '/download'); const url = URL.createObjectURL(new Blob([JSON.stringify(credentialData, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = credential.name.endsWith('.json') ? credential.name : credential.name + '.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); status('已下载凭证，请妥善保管，其中包含令牌。'); });
    const rename = document.createElement('button'); rename.className = 'secondary'; rename.textContent = '修改名称';
    rename.onclick = () => {
      const name = prompt('输入凭证名称（同渠道内不能重名）', credential.name);
      if (name === null || name.trim() === credential.name) return;
      run(async () => { await api('/admin/credentials/' + credential.id, 'PATCH', { name }); await refresh(); el('callsBody').replaceChildren(); status('凭证名称已更新，调用记录会优先显示邮箱；无邮箱时显示新名称。'); });
    };
    const health = document.createElement('button'); health.className = 'secondary'; health.textContent = '健康详情';
    health.onclick = () => run(async () => {
      const value = await api('/admin/credentials/' + credential.id + '/health');
      const h = value.health;
      el('healthDetails').textContent = [(credential.user_email || credential.name) + ' · ' + credential.mode + (credential.disabled ? ' · 已停用' : ' · 启用'),
        '最后成功：' + (h?.last_success ? formatReset(h.last_success) : '无'),
        '最后失败：' + (h?.last_failure ? formatReset(h.last_failure) + ' · HTTP ' + h.last_status + ' · ' + h.last_stage + ' · ' + (h.last_code || '未知原因') : '无'),
        '连续失败事件：' + (h?.failure_streak || 0), '当前模型冷却：',
        ...value.cooldowns.map(q => q.model + ' · HTTP ' + q.status + ' · 截止 ' + formatReset(q.until_ms)),
        ...(!value.cooldowns.length ? ['无'] : [])].join('\n');
      el('healthPanel').open = true;
      el('healthDetails').scrollIntoView({ behavior: 'smooth', block: 'center' }); status('已加载凭证健康详情。');
    });
    const scheduling = document.createElement('button'); scheduling.className = 'secondary'; scheduling.textContent = '调度设置';
    scheduling.onclick = () => {
      const priority = prompt('优先级（-100～100），仅优先级策略使用，数值越大越优先', String(credential.priority ?? 0)); if (priority === null) return;
      const weight = prompt('权重（1～100），仅权重随机策略使用', String(credential.weight ?? 1)); if (weight === null) return;
      if (!priority.trim() || !weight.trim()) { status('优先级和权重不能留空。'); return; }
      run(async () => { await api('/admin/credentials/' + credential.id, 'PATCH', { priority: Number(priority), weight: Number(weight) }); await refresh(); status('已保存调度设置。全局策略可在“网页配置”中切换。'); });
    };
    actions.append(health); extraActions.append(rename, scheduling, email, verify, test, download);
    const history = document.createElement('button'); history.className = 'secondary'; history.textContent = '调用记录'; history.onclick = () => run(async () => { showPage('logs'); el('callsCredential').value = credential.id; await loadCalls(); loadedPages.add('logs'); el('callsBody').scrollIntoView({ behavior: 'smooth', block: 'center' }); }); extraActions.append(history);
    if (credential.cooling_models) { const clear = document.createElement('button'); clear.className = 'secondary'; clear.textContent = '清除冷却'; clear.onclick = () => run(async () => { await api('/admin/credentials/' + credential.id + '/cooldowns', 'DELETE'); await refresh(); status('已清除该凭证的模型冷却；若 Google 仍限流，再次调用仍可能失败。'); }); extraActions.append(clear); }
    const toggle = document.createElement('button');
    toggle.textContent = credential.disabled ? '启用' : '停用'; toggle.className = 'secondary';
    toggle.onclick = () => run(async () => { await api('/admin/credentials/' + credential.id, 'PATCH', { disabled: !credential.disabled }); await refresh(); });
    const remove = document.createElement('button'); remove.textContent = '删除'; remove.className = 'danger';
    remove.onclick = () => { if (confirm('确认删除凭证 ' + credential.name + '？')) run(async () => { await api('/admin/credentials/' + credential.id, 'DELETE'); await refresh(); }); };
    if (credential.detected_mode && credential.detected_mode !== credential.mode) {
      const repair = document.createElement('button'); repair.textContent = '纠正为 ' + credential.detected_mode;
      repair.onclick = () => { if (confirm('将该凭证从 ' + credential.mode + ' 移至 ' + credential.detected_mode + '？请同步修改客户端 Base URL。')) run(async () => {
        await api('/admin/credentials/' + credential.id, 'PATCH', { mode: credential.detected_mode }); await refresh();
        status('渠道已纠正。Antigravity 的 OpenAI Base URL 为 ' + location.origin + '/antigravity/v1');
      }); }; extraActions.append(repair);
    }
    if (credential.mode === 'antigravity') {
      const quota = document.createElement('button'); quota.textContent = '查看额度';
      quota.onclick = () => run(() => showQuota(credential)); actions.append(quota);
    }
    extraActions.append(toggle, remove); actions.append(menu); tr.append(actions); el('credentials').append(tr);
    const details = document.createElement('tr'); details.id = 'quota-' + credential.id; details.className = 'quota-details'; details.hidden = true;
    const cell = document.createElement('td'); cell.colSpan = 6; details.append(cell); el('credentials').append(details);
  }
  updateSelection();
  el('batchPanel').open ||= selectedCredentials.size>0;
}
for (const id of ['credentialSearch','credentialMode','credentialState']) el(id).oninput = el(id).onchange = ()=>{ credentialPage=0;renderCredentials(); };
el('credentialsPrev').onclick=()=>{if(credentialPage>0)credentialPage--;renderCredentials();};
el('credentialsNext').onclick=()=>{if((credentialPage+1)*25<filteredCredentials().length)credentialPage++;renderCredentials();};
el('clearSelection').onclick=()=>{selectedCredentials.clear();updateSelection();};
function formatReset(value) {
  if (!value) return '未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}
async function showQuota(credential) {
  const details = el('quota-' + credential.id);
  const cell = details.firstChild; details.hidden = false; cell.textContent = '正在查询额度…';
  status('正在查询 ' + credential.name + ' 的 Antigravity 额度…');
  try {
    const value = await api('/admin/credentials/' + credential.id + '/quota');
    cell.replaceChildren();
    const heading = document.createElement('p');
    heading.textContent = '查询时间：' + formatReset(value.queriedAt) + '（北京时间）。剩余比例由 Google 返回，不等同于剩余调用次数。';
    cell.append(heading);
    const controls = document.createElement('div');
    const reload = document.createElement('button'); reload.textContent = '刷新额度'; reload.onclick = () => run(() => showQuota(credential));
    const hide = document.createElement('button'); hide.className = 'secondary'; hide.textContent = '收起'; hide.onclick = () => { details.hidden = true; };
    controls.append(reload, hide); cell.append(controls);
    if (!value.models.length) { const empty = document.createElement('p'); empty.textContent = 'Google 未返回模型信息，无法确定额度。'; cell.append(empty); }
    else {
      const table = document.createElement('table');
      const head = document.createElement('tr');
      for (const text of ['模型', '剩余额度', '重置时间（北京时间）']) { const th = document.createElement('th'); th.textContent = text; head.append(th); }
      const thead = document.createElement('thead'); thead.append(head); table.append(thead);
      const tbody = document.createElement('tbody');
      for (const model of value.models) {
        const tr = document.createElement('tr');
        const name = document.createElement('td'); name.textContent = model.id;
        const balance = document.createElement('td');
        if (model.remaining === null) balance.textContent = '未知（上游未提供）';
        else { const progress = document.createElement('progress'); progress.max = 1; progress.value = model.remaining; balance.append(progress, document.createTextNode((model.remaining * 100).toFixed(1) + '%')); }
        const reset = document.createElement('td'); reset.textContent = formatReset(model.resetTime);
        tr.append(name, balance, reset); tbody.append(tr);
      }
      table.append(tbody); const scroll = document.createElement('div'); scroll.className = 'scroll'; scroll.append(table); cell.append(scroll);
    }
    status('已更新 ' + credential.name + ' 的额度。');
  } catch (error) { cell.textContent = '查询失败：' + error.message; throw error; }
}
el('loginForm').onsubmit = event => { event.preventDefault(); run(async () => {
  const password = el('password').value;
  await api('/auth/login', 'POST', { password }); el('password').value = '';
  await openWorkspace();
}); };
el('logout').onclick = () => run(async () => { await api('/auth/logout', 'POST'); el('workspace').hidden = true; el('loginCard').hidden = false; el('credentials').replaceChildren(); el('credential').value = ''; el('file').value = ''; selectedCredentials.clear(); credentialsSnapshot = []; loadedPages.clear(); credentialPage=0; duplicateSnapshot = []; settingsLoaded = false; quotaOverviewResults = []; el('quotaSummary').replaceChildren(); el('quotaOverviewBody').replaceChildren(); el('quotaOverviewState').textContent = ''; el('healthDetails').textContent = ''; el('statsSummary').replaceChildren(); for (const id of ['statsDays','statsModels','statsCredentials']) el(id).replaceChildren(); el('batchFiles').value = ''; el('batchResults').textContent = ''; el('duplicateResults').textContent = ''; el('callsBody').replaceChildren(); el('callbackUrl').value = ''; el('oauthLink').removeAttribute('href'); el('oauthLinkArea').hidden = true; status('已退出。'); });
el('refresh').onclick = () => run(refresh);
let nextCall = null;
async function loadCalls(before = null) {
  const params = panelFilters('calls');
  if (before) params.set('before', before);
  if (el('callsCredential').value) params.set('credential_id', el('callsCredential').value);
  const value = await api('/admin/calls?' + params);
  el('callsBody').replaceChildren(); nextCall = value.next; el('callsNext').hidden = !nextCall;
  for (const record of value.records) {
    const tr = document.createElement('tr');
    for (const text of [formatReset(record.created_at), (record.display_name || record.credential_name) + (record.credential_email && record.credential_name !== record.credential_email ? '\n' + record.credential_name : '') + '\n' + record.mode, record.model, record.status + '\n' + record.stage + (record.detail_code ? '\n' + record.detail_code : ''), record.duration_ms + ' ms', record.request_id]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
    el('callsBody').append(tr);
  }
  status(value.records.length ? '已加载 ' + value.records.length + ' 条调用记录。' : '暂无调用记录。');
}
el('callsRefresh').onclick = () => run(() => loadCalls());
el('callsNext').onclick = () => run(() => loadCalls(nextCall));
el('callsCredential').onchange = () => { nextCall = null; el('callsNext').hidden = true; el('callsBody').replaceChildren(); };
function updateSelection() {
  el('selectionCount').textContent = '已选 ' + selectedCredentials.size + ' 个（可跨页）';
  const visible=visibleCredentials(); const count=visible.filter(c=>selectedCredentials.has(c.id)).length;
  el('selectAll').checked=!!visible.length && count===visible.length; el('selectAll').indeterminate=count>0 && count<visible.length;
  document.querySelectorAll('.credential-select').forEach(input => { input.checked = selectedCredentials.has(input.dataset.id); });
}
el('selectAll').onchange = () => { for (const row of visibleCredentials()) { if (el('selectAll').checked) selectedCredentials.add(row.id); else selectedCredentials.delete(row.id); } el('batchPanel').open=selectedCredentials.size>0; updateSelection(); };
el('batchStop').onclick = () => { stopBatch = true; status('将停止后续操作，正在进行的这一项会完成。'); };
function startBatch() { stopBatch = false; el('batchResults').textContent = ''; el('batchStop').hidden = false; el('batchStop').disabled = false; }
function batchLine(text) { el('batchResults').textContent += text + '\n'; }
function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  if (value.format === 'gcli2api-workers-credentials-v1' && blob.size > 4 * 1024 * 1024) throw new Error('备份超过 4 MiB，请减少选中项后分批导出。');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
el('batchRun').onclick = () => {
  const rows = credentialsSnapshot.filter(row => selectedCredentials.has(row.id));
  if (!rows.length) { status('请先勾选凭证。'); return; }
  const action = el('batchAction').value;
  if (action === 'export' && rows.length > 1000) { status('单份备份最多 1000 个凭证，请分批导出。'); return; }
  if (action === 'delete' && !confirm('确认删除选中的 ' + rows.length + ' 个凭证？')) return;
  if (action === 'test' && !confirm('将逐个发起最小聊天请求，会消耗额度，继续？')) return;
  return run(async () => {
    startBatch(); const exported = []; let success = 0;
    try {
      for (const row of rows) {
        if (stopBatch) break;
        const label = row.user_email || row.name; status('正在处理 ' + label);
        try {
          const root = '/admin/credentials/' + row.id;
          if (action === 'export') exported.push({ name: row.name, mode: row.mode, disabled: !!row.disabled, priority: row.priority ?? 0, weight: row.weight ?? 1, credential: await api(root + '/download') });
          else if (action === 'enable' || action === 'disable') await api(root, 'PATCH', { disabled: action === 'disable' });
          else if (action === 'delete') await api(root, 'DELETE');
          else if (action === 'cooldowns') await api(root + '/cooldowns', 'DELETE');
          else { const value = await api(root + '/' + action, 'POST', {}); if (value.limited) { batchLine(label + '：当前限流'); continue; } }
          success++; batchLine(label + '：完成');
        } catch (error) { batchLine(label + '：失败 — ' + error.message); }
      }
      if (action === 'export' && exported.length && !stopBatch) downloadJson({ format: 'gcli2api-workers-credentials-v1', credentials: exported }, 'gcli2api-credentials-' + Date.now() + '.json');
      await refresh(); status((stopBatch ? '已停止后续操作。' : '批量操作完成。') + '成功 ' + success + '/' + rows.length + '，详情见批量结果。');
    } finally { el('batchStop').hidden = true; }
  });
};
function inferMode(data) {
  return oauthClientModes[data?.client_id];
}
el('batchImportForm').onsubmit = event => { event.preventDefault(); const files = Array.from(el('batchFiles').files); if (!files.length) return;
  return run(async () => {
    startBatch(); let success = 0; let total = 0;
    try {
      for (const file of files) {
        if (stopBatch) break;
        let entries;
        try {
          if (file.size > 4 * 1024 * 1024) throw new Error('单个文件不能超过 4 MiB');
          const value = JSON.parse(await file.text());
          entries = value.format === 'gcli2api-workers-credentials-v1' && Array.isArray(value.credentials) ? value.credentials : [{ name: file.name, credential: value }];
          if (entries.length > 1000) throw new Error('单份备份最多 1000 个凭证');
        } catch (error) { batchLine(file.name + '：读取失败 — ' + error.message); continue; }
        for (const entry of entries) {
          if (stopBatch) break; total++;
          try {
            if (!entry || typeof entry !== 'object') throw new Error('备份条目格式无效');
            const credential = entry.credential;
            const mode = entry.mode || inferMode(credential) || el('batchMode').value;
            await api('/admin/credentials', 'POST', { name: entry.name || file.name, mode, credential, ...(typeof entry.disabled === 'boolean' ? { disabled: entry.disabled } : {}), ...(entry.priority !== undefined ? { priority: entry.priority } : {}), ...(entry.weight !== undefined ? { weight: entry.weight } : {}) });
            success++; batchLine((entry.name || file.name) + '：导入完成');
          } catch (error) { batchLine((entry?.name || file.name) + '：失败 — ' + error.message); }
        }
      }
      el('batchFiles').value = ''; await refresh(); showPage('credentials'); loadedPages.add('credentials'); status('导入成功 ' + success + '/' + total + '。详情见批量结果。');
    } finally { el('batchStop').hidden = true; }
  });
};
el('findDuplicates').onclick = () => run(async () => {
  const value = await api('/admin/duplicates'); duplicateSnapshot = value.groups;
  const lines = ['发现 ' + value.groups.length + ' 组重复，' + value.unknown_email_count + ' 个凭证没有邮箱，未参与查重。'];
  for (const group of value.groups) lines.push(group.email + ' · ' + group.mode + '\n  建议保留：' + group.keep.name + '\n  重复项：' + group.duplicates.map(row => row.name).join('、'));
  el('duplicateResults').textContent = lines.join('\n'); el('selectDuplicates').hidden = !value.groups.length;
  status('查重完成，未删除任何凭证。');
});
el('selectDuplicates').onclick = () => {
  selectedCredentials.clear(); for (const group of duplicateSnapshot) for (const row of group.duplicates) if (credentialsSnapshot.some(c => c.id === row.id)) selectedCredentials.add(row.id);
  showPage('credentials'); el('batchPanel').open=true; updateSelection(); status('已选中建议清理的重复项，可在批量操作中停用或删除。');
};
function fillSettings(value) {
  el('settingsStrategy').value = value.effective.CREDENTIAL_SELECTION;
  el('settingsAttempts').value = value.effective.MAX_CREDENTIAL_ATTEMPTS;
  el('settingsCliModels').value = value.effective.GEMINICLI_MODELS;
  el('settingsAntiModels').value = value.effective.ANTIGRAVITY_MODELS;
  el('settingsCollect').checked = value.effective.ANTIGRAVITY_STREAM2NOSTREAM;
  settingsLoaded = true;
}
el('settingsLoad').onclick = () => run(async () => { fillSettings(await api('/admin/settings')); status('已加载当前生效配置。'); });
el('settingsForm').onsubmit = event => { event.preventDefault(); run(async () => {
  if (!settingsLoaded) throw new Error('请先加载当前配置。');
  fillSettings(await api('/admin/settings', 'PATCH', { CREDENTIAL_SELECTION: el('settingsStrategy').value, ANTIGRAVITY_STREAM2NOSTREAM: el('settingsCollect').checked, MAX_CREDENTIAL_ATTEMPTS: Number(el('settingsAttempts').value), GEMINICLI_MODELS: el('settingsCliModels').value, ANTIGRAVITY_MODELS: el('settingsAntiModels').value })); status('配置已保存，新的调用立即生效。');
}); };
el('settingsReset').onclick = () => run(async () => { fillSettings(await api('/admin/settings', 'PATCH', { CREDENTIAL_SELECTION: null, ANTIGRAVITY_STREAM2NOSTREAM: null, MAX_CREDENTIAL_ATTEMPTS: null, GEMINICLI_MODELS: null, ANTIGRAVITY_MODELS: null })); status('已恢复使用 vars 中的配置。'); });

function panelFilters(prefix) {
  const params = new URLSearchParams();
  for (const [suffix,key] of [['Email','email'],['Model','model'],['Mode','mode'], ...(prefix === 'calls' ? [['Status','status'],['Stage','stage'],['Request','request_id']] : [])]) {
    const value = el(prefix+suffix).value.trim(); if (value) params.set(key,value);
  }
  for (const [suffix,key] of [['From','from'],['To','to']]) {
    const value = el(prefix+suffix).value;
    if (value) { const time = new Date(value).getTime(); if (!Number.isFinite(time)) throw new Error('时间格式无效'); params.set(key, String(time)); }
  }
  if (prefix === 'calls' && el('callsCredential').value) params.set('credential_id', el('callsCredential').value);
  return params;
}
function tableRow(body, values) { const tr = document.createElement('tr'); for (const value of values) { const td = document.createElement('td'); td.textContent = String(value); tr.append(td); } el(body).append(tr); }
const tokenText = value => value == null ? '未报告' : Number(value).toLocaleString('zh-CN');
const successRate = row => row.requests ? (100*row.successes/row.requests).toFixed(1)+'%' : '—';
function metricsRow(body, label, row) {
  tableRow(body, [label, [row.requests,row.successes || 0,row.failures || 0,row.cancellations || 0].join(' / '), successRate(row),
    [row.input_tokens,row.output_tokens,row.thought_tokens,row.total_tokens].map(tokenText).join(' / '), (row.avg_duration_ms ?? 0)+' ms']);
}
async function loadStats() {
  const params = panelFilters('stats'); if (!params.has('from')) params.set('from', String(Date.now()-7*86400000));
  const value = await api('/admin/stats?'+params); const s = value.summary;
  el('statsSummary').replaceChildren();
  for (const [label,text] of [['请求数',s.requests],['成功率',successRate(s)],['失败 / 取消',(s.failures || 0)+' / '+(s.cancellations || 0)],['上游报告总 Token',tokenText(s.total_tokens)],['有用量报告的请求',(s.token_reports || 0)+' / '+s.requests],['平均耗时',(s.avg_duration_ms ?? 0)+' ms']]) {
    const box = document.createElement('div'); box.className = 'metric'; const name = document.createElement('small'); name.textContent = label; const number = document.createElement('strong'); number.textContent = String(text); box.append(name,number); el('statsSummary').append(box);
  }
  for (const body of ['statsDays','statsModels','statsCredentials']) el(body).replaceChildren();
  for (const row of value.days) metricsRow('statsDays', row.day,row);
  for (const row of value.models) metricsRow('statsModels', row.model+' · '+row.mode,row);
  for (const row of value.credentials) metricsRow('statsCredentials', row.display_name,row);
  status('统计已刷新。'+(value.groups_truncated ? '模型或账号分组超过 200 项，请缩小筛选范围。' : ''));
}
el('statsRefresh').onclick = ()=>run(loadStats);
el('callsExport').onclick = () => run(async () => { const value = await api('/admin/calls/export?'+panelFilters('calls')); downloadJson(value,'call-logs-'+Date.now()+'.json'); status('已导出 '+value.records.length+' 条日志。'); });
el('callsClear').onclick = () => { if (confirm('确认删除当前筛选匹配的调用日志？没有筛选条件时将删除全部事件日志。用量统计与健康摘要会保留。')) return run(async () => { const value = await api('/admin/calls?'+panelFilters('calls'),'DELETE',{ confirm:'delete-matching-logs' }); await loadCalls(); status('已删除 '+value.deleted+' 条调用日志，用量统计和健康摘要已保留。'); }); };
for (const suffix of ['Email','Model','Mode','Status','Stage','Request','From','To']) el('calls'+suffix).onchange = () => { nextCall = null; el('callsNext').hidden = true; el('callsBody').replaceChildren(); };
let quotaOverviewResults = [];
let stopQuotaOverview = false;
function renderQuotaOverview() {
  el('quotaOverviewBody').replaceChildren(); el('quotaSummary').replaceChildren(); const groups = new Map();
  for (const entry of quotaOverviewResults) {
    const label = entry.credential.user_email || entry.credential.name;
    if (entry.error) { tableRow('quotaOverviewBody',[label,'—','未知','—',entry.error]); continue; }
    if (!entry.value.models.length) tableRow('quotaOverviewBody',[label,'上游未返回模型','未知','—',formatReset(entry.value.queriedAt)]);
    for (const model of entry.value.models) {
      tableRow('quotaOverviewBody',[label,model.id,model.remaining == null ? '未知' : (model.remaining*100).toFixed(1)+'%',formatReset(model.resetTime),formatReset(entry.value.queriedAt)]);
      if (!groups.has(model.id)) groups.set(model.id,{ values:[],unknown:0 }); const group = groups.get(model.id);
      if (model.remaining == null) group.unknown++; else group.values.push(model.remaining);
    }
  }
  for (const [id,g] of [...groups.entries()].sort(([a],[b]) => a.localeCompare(b))) tableRow('quotaSummary',[id,g.values.length+' / '+g.unknown,
    g.values.length ? (100*g.values.reduce((a,b)=>a+b,0)/g.values.length).toFixed(1)+'%' : '未知',g.values.length ? (100*Math.min(...g.values)).toFixed(1)+'%' : '未知']);
}
el('quotaOverviewStop').onclick = () => { stopQuotaOverview = true; status('将停止后续额度查询，当前账号查询完成后停止。'); };
el('quotaOverviewRefresh').onclick = () => run(async () => {
  await refresh(); const rows = credentialsSnapshot.filter(c => c.mode === 'antigravity' && (!c.disabled || el('quotaIncludeDisabled').checked));
  quotaOverviewResults = []; stopQuotaOverview = false; renderQuotaOverview(); el('quotaOverviewStop').hidden = false; el('quotaOverviewStop').disabled = false;
  try {
    for (const credential of rows) {
      if (stopQuotaOverview) break; el('quotaOverviewState').textContent = '查询中 '+(quotaOverviewResults.length+1)+' / '+rows.length+' · '+(credential.user_email || credential.name);
      try { quotaOverviewResults.push({ credential, value:await api('/admin/credentials/'+credential.id+'/quota') }); }
      catch (error) { quotaOverviewResults.push({ credential,error:error.message }); }
      renderQuotaOverview();
    }
    const failed = quotaOverviewResults.filter(r => r.error).length;
    el('quotaOverviewState').textContent = (stopQuotaOverview ? '已停止。' : '查询完成。')+'已查 '+quotaOverviewResults.length+' / '+rows.length+'，失败 '+failed+'。失败账号、未查询账号和未返回该模型的账号不参与该模型平均值。';
    status('额度总览已更新。');
  } finally { el('quotaOverviewStop').hidden = true; }
});

el('modelsForm').onsubmit = event => { event.preventDefault(); run(async () => {
  el('modelsSource').textContent = '正在查询…'; el('modelsResult').textContent = '';
  try {
    const value = await api('/admin/models?mode=' + el('modelsMode').value);
    const labels = { google: 'Google 实时返回', vars: 'vars 配置', fallback: '备用 vars 配置（动态查询失败）' };
    el('modelsSource').textContent = '来源：' + labels[value.source] + '；共 ' + value.ids.length + ' 个模型。' + (value.warning || '');
    el('modelsResult').textContent = value.ids.length ? value.ids.join('\n') : '未返回模型';
    status('模型列表已更新。');
  } catch (error) { el('modelsSource').textContent = '查询失败：' + error.message; throw error; }
}); };
el('oauthStart').onsubmit = event => { event.preventDefault(); run(async () => {
  el('oauthLinkArea').hidden = true;
  const value = await api('/admin/oauth/start', 'POST', { mode: el('oauthMode').value, name: el('oauthName').value, project_id: el('oauthProject').value });
  el('oauthLink').href = value.auth_url; el('oauthLinkArea').hidden = false; el('callbackUrl').value = '';
  status('授权链接已生成。打开 Google 完成授权，将最后的 localhost 回调 URL 粘贴回来。');
}); };
el('oauthComplete').onsubmit = event => { event.preventDefault(); run(async () => {
  const value = await api('/admin/oauth/complete', 'POST', { callback_url: el('callbackUrl').value.trim() });
  el('callbackUrl').value = ''; el('oauthLinkArea').hidden = true; await refresh(); showPage('credentials'); loadedPages.add('credentials');
  status('Google 凭证已保存：' + value.name + (value.user_email ? '，邮箱：' + value.user_email : '') + (value.warnings.length ? '\n' + value.warnings.join('；') : ''));
}); };
function detectImportMode(credential) {
  const mode = inferMode(credential);
  if (mode) { el('mode').value = mode; status('已根据 client_id 识别渠道为 ' + mode + '。'); }
}
el('credential').addEventListener('input', () => { try { detectImportMode(JSON.parse(el('credential').value)); } catch {} });
el('file').onchange = () => run(async () => {
  const file = el('file').files[0]; if (!file) return;
  if (file.size > 4 * 1024 * 1024) throw new Error('文件不能超过 4 MiB');
  el('credential').value = await file.text(); el('name').value = file.name;
  try { detectImportMode(JSON.parse(el('credential').value)); } catch { throw new Error('JSON 格式错误'); }
});
el('importForm').onsubmit = event => { event.preventDefault(); run(async () => {
  let credential; try { credential = JSON.parse(el('credential').value); } catch { throw new Error('JSON 格式错误'); }
  await api('/admin/credentials', 'POST', { name: el('name').value, mode: el('mode').value, credential });
  el('credential').value = ''; el('file').value = ''; await refresh(); showPage('credentials'); loadedPages.add('credentials'); status('导入成功。');
}); };
el('openaiUrl').textContent = location.origin + '/v1';
el('antiUrl').textContent = location.origin + '/antigravity/v1';
el('geminiUrl').textContent = location.origin;
el('anthropicUrl').textContent = location.origin;
el('antiAnthropicUrl').textContent = location.origin + '/antigravity';
run(async () => {
  status('正在检查登录状态…');
  const session = await api('/auth/session');
  if (session.authenticated) await openWorkspace();
  else status('请先登录管理页。');
});
</script></body></html>`;
