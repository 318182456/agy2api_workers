import { groupQuotaModels } from '../quota/groups.js';
// Embedded into the panel script; all upstream labels are rendered as text nodes.
export const analyticsScript = String.raw`
${groupQuotaModels.toString()}
function accountQuota(entry) { return groupQuotaModels(entry.value.models,entry.credential.mode); }
function quotaWindows(model) { return model.family ? '5 小时额度：上游未单独提供 · 周额度：上游未单独提供'+(model.inconsistent ? ' · 同组报告不同，暂显示最低剩余、最晚重置；不代表全部模型共享同一额度' : '') : ''; }
function ui(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}
const compact = value => value == null ? '未报告' : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const duration = value => value == null ? '—' : value >= 1000 ? (value/1000).toFixed(1)+' 秒' : value+' ms';
const quotaTone = value => value == null ? 'unknown' : value <= 0 ? 'empty' : value <= .2 ? 'low' : 'healthy';
const quotaPercent = value => value == null ? '未知' : (value*100).toFixed(1)+'%';
function meter(value, label) {
  const track = ui('div', 'balance-track '+quotaTone(value));
  track.setAttribute('role','meter'); track.setAttribute('aria-label', label);
  track.setAttribute('aria-valuemin','0'); track.setAttribute('aria-valuemax','100');
  if (value != null) track.setAttribute('aria-valuenow',String(Math.round(value*100)));
  track.setAttribute('aria-valuetext',quotaPercent(value));
  const fill = ui('span'); fill.setAttribute('style','width:'+Math.max(0,Math.min(100,(value || 0)*100))+'%');
  track.append(fill); return track;
}
function emptyInto(id, text) { el(id).append(ui('div','empty-state',text)); }
let statsSnapshot = { days:[], models:[], credentials:[], api_keys:[] };
const statsKeyNames = new Map();
const statsPages = { days:0, models:0, credentials:0, api_keys:0 };
function renderStatsTables() {
  for (const [key,body] of [['days','statsDays'],['models','statsModels'],['credentials','statsCredentials'],['api_keys','statsApiKeys']]) {
    const rows = statsSnapshot[key] || []; const page = statsPages[key];
    el(body).replaceChildren();
    for (const row of rows.slice(page*10,page*10+10)) {
      const tr = metricsRow(body, key === 'days' ? row.day : key === 'models' ? row.model+' · '+row.mode : row.display_name, row);
      if (key === 'api_keys' && row.api_key_id) { const link = ui('a','',row.display_name); const params = panelFilters('stats'); params.set('api_key_id',row.api_key_id); bindMetricLink(link,'overview',Object.fromEntries(params),'statsDetails'); tr.children[0].replaceChildren(link); }
    }
    el(body+'Page').textContent = rows.length ? (page+1)+' / '+Math.ceil(rows.length/10)+' 页 · '+rows.length+' 项' : '暂无请求记录';
    el(body+'Prev').disabled = page === 0;
    el(body+'Next').disabled = (page+1)*10 >= rows.length;
  }
}
for (const [key,body] of [['days','statsDays'],['models','statsModels'],['credentials','statsCredentials'],['api_keys','statsApiKeys']]) {
  el(body+'Prev').onclick = () => { if (statsPages[key]>0) statsPages[key]--; renderStatsTables(); };
  el(body+'Next').onclick = () => { if ((statsPages[key]+1)*10<(statsSnapshot[key] || []).length) statsPages[key]++; renderStatsTables(); };
}
function rankings(id, rows, label, field) {
  el(id).replaceChildren();
  const sorted = [...rows].sort((a,b)=>(b[field] || 0)-(a[field] || 0)).slice(0,6);
  const max = Math.max(1,...sorted.map(r=>r[field] || 0));
  for (const [i,row] of sorted.entries()) {
    const item = ui(id === 'statsKeyRank' && row.api_key_id ? 'a' : 'div','ranking-row');
    if (id === 'statsKeyRank' && row.api_key_id) { const params = panelFilters('stats'); params.set('api_key_id',row.api_key_id); bindMetricLink(item,'overview',Object.fromEntries(params),'statsDetails'); item.title = '查看 ' + label(row) + ' 的模型、日期和账号消耗'; }
    const name = ui('div','ranking-name'); name.append(ui('span','rank-number',String(i+1).padStart(2,'0')),ui('span','',label(row)));
    const number = ui('strong','',field === 'requests' ? compact(row.requests)+' 次' : compact(row.total_tokens));
    const bar = ui('div','rank-track'); const fill = ui('span'); fill.setAttribute('style','width:'+100*(row[field] || 0)/max+'%'); bar.append(fill);
    item.append(name,number,bar); el(id).append(item);
  }
  if (!sorted.length) emptyInto(id,'当前范围内暂无数据');
}
function renderStatsCharts(value) {
  const assignedAccounts = value.credentials.filter(row => row.credential_id);
  statsSnapshot = { ...value, credentials: assignedAccounts };
  for (const key of Object.keys(statsPages)) statsPages[key]=0;
  renderStatsTables();
  el('statsTrend').replaceChildren();
  const rows = [...value.days].sort((a,b)=>a.day.localeCompare(b.day));
  const maximum = Math.max(1,...rows.map(row=>row.requests));
  for (const row of rows) {
    const column = ui('div','trend-column');
    const tip = row.day+'：'+row.requests+' 次请求，成功 '+(row.successes || 0)+'，失败 '+(row.failures || 0)+'，取消 '+(row.cancellations || 0);
    column.title = tip; column.setAttribute('aria-label',tip); column.tabIndex=0;
    const bar = ui('div','trend-stack');
    bar.setAttribute('style','height:'+Math.max(2,140*row.requests/maximum)+'px');
    for (const [field,tone] of [['successes','success'],['failures','failure'],['cancellations','cancelled']]) {
      const part = ui('span',tone); part.setAttribute('style','height:'+(row.requests ? 100*(row[field] || 0)/row.requests : 0)+'%'); bar.append(part);
    }
    column.append(ui('strong','',compact(row.requests)),bar,ui('small','',row.day.slice(5))); el('statsTrend').append(column);
  }
  if (!rows.length) emptyInto('statsTrend','当前范围内暂无请求，发起调用后可查看趋势');
  rankings('statsModelRank',value.models,row=>row.model+' · '+row.mode,'requests');
  const unassignedRequests = value.credentials.filter(row => !row.credential_id).reduce((total,row) => total + row.requests,0);
  rankings('statsAccountRank',assignedAccounts,row=>row.display_name,'total_tokens');
  rankings('statsKeyRank',value.api_keys || [],row=>row.display_name,'total_tokens');
  el('statsCoverage').textContent = '用量报告覆盖 '+(value.summary.token_reports || 0)+' / '+value.summary.requests+' 次请求；账号排行仅比较已分配凭证的上游报告总 Token。'+(unassignedRequests ? '其中 '+unassignedRequests+' 次请求在选中凭证前结束，已计入总体请求数与失败统计，不列入账号排行和按账号明细。' : '');
}
let quotaModelPage = 0;
let quotaAccountPage = 0;
function quotaGroups() {
  const groups = new Map();
  for (const entry of quotaOverviewResults) {
    if (entry.error) continue;
    for (const model of accountQuota(entry)) {
      const key = JSON.stringify([entry.credential.mode,model.id,null,model.tokenType ?? null,model.bucketIndex ?? null]);
      if (!groups.has(key)) groups.set(key,{ id:model.id,mode:entry.credential.mode,tokenType:model.tokenType || null,accounts:[],values:[],unknown:0 });
      const group = groups.get(key); group.accounts.push({ credential:entry.credential,...model });
      if (model.remaining == null) group.unknown++; else group.values.push(model.remaining);
    }
  }
  return [...groups.values()].map(g=>({ ...g, average:g.values.length ? g.values.reduce((a,b)=>a+b,0)/g.values.length : null, minimum:g.values.length ? Math.min(...g.values) : null }));
}
function modelMatches(group) {
  const query = el('quotaSearch').value.trim().toLowerCase();
  const state = el('quotaStateFilter').value;
  const nameMatches = !query || group.id.toLowerCase().includes(query) || group.accounts.some(a=>(a.credential.user_email || a.credential.name).toLowerCase().includes(query));
  const statusMatches = !state || state === 'all' || (state === 'unknown' ? group.unknown>0 : state === 'low_or_empty' ? group.values.some(v=>v<=.2) : state === 'low' ? group.values.some(v=>v>0 && v<=.2) : state === 'empty' ? group.values.some(v=>v===0) : group.values.some(v=>v>.2));
  const channel = el('quotaChannelFilter').value;
  return nameMatches && statusMatches && (!channel || group.mode === channel);
}
function quotaAmount(model) {
  return model.remainingAmount != null ? '可用数量 '+model.remainingAmount+(model.tokenType ? ' · '+model.tokenType : '') : model.tokenType ? '配额类型 '+model.tokenType : '';
}
function quotaAccountLine(account) {
  const row = ui('div','quota-account-line');
  const identity = ui('div'); identity.append(ui('strong','',account.credential.user_email || account.credential.name),ui('small','',account.credential.disabled ? '已停用' : '已启用'));
  const balance = ui('div','quota-line-balance'); balance.append(ui('strong',quotaTone(account.remaining),quotaPercent(account.remaining)),meter(account.remaining, '账号剩余额度'));
  row.append(identity,balance,ui('small','',[quotaAmount(account),'当前报告重置 '+formatReset(account.resetTime),quotaWindows(account)].filter(Boolean).join(' · '))); return row;
}
function renderSingleQuota(container, models, mode) {
  models = groupQuotaModels(models,mode);
  let page = 0;
  const search = ui('input'); search.type='search'; search.placeholder='筛选 Gemini / Claude'; search.setAttribute('aria-label','筛选该账号的模型');
  const grid = ui('div','quota-model-grid');
  const navigation = ui('div','pagination'); const info = ui('span'); const buttons = ui('div');
  const previous = ui('button','secondary','上一页'); const next = ui('button','secondary','下一页'); buttons.append(previous,next); navigation.append(info,buttons);
  const render = () => {
    const filtered = models.filter(model=>model.id.toLowerCase().includes(search.value.trim().toLowerCase())).sort((a,b)=>(a.remaining ?? 2)-(b.remaining ?? 2) || a.id.localeCompare(b.id));
    grid.replaceChildren();
    for (const model of filtered.slice(page*8,page*8+8)) {
      const card = ui('article','quota-model-card'); const heading = ui('div','quota-card-heading');
      heading.append(ui('h3','',model.id+(model.tokenType?' · '+model.tokenType:'')),ui('strong',quotaTone(model.remaining),quotaPercent(model.remaining)));
      card.append(heading,meter(model.remaining,model.id+' 剩余额度'),ui('small','',[quotaAmount(model),'当前报告重置 '+formatReset(model.resetTime)+'（北京时间）',quotaWindows(model)].filter(Boolean).join(' · '))); grid.append(card);
    }
    if (!filtered.length) grid.append(ui('div','empty-state','没有匹配的模型'));
    info.textContent = filtered.length ? '第 '+(page+1)+' / '+Math.ceil(filtered.length/8)+' 页 · '+filtered.length+' 个模型' : '0 个模型';
    previous.disabled = page===0; next.disabled = (page+1)*8>=filtered.length;
  };
  previous.onclick = () => { if (page>0) page--; render(); };
  next.onclick = () => { page++; render(); };
  search.oninput = () => { page=0; render(); };
  container.append(search,grid,navigation); render();
}
function paginationState(prefix,page,size,total) {
  el(prefix+'Page').textContent = total ? '第 '+(page+1)+' / '+Math.ceil(total/size)+' 页 · 共 '+total+' 项' : '0 项';
  el(prefix+'Prev').disabled = page===0; el(prefix+'Next').disabled = (page+1)*size>=total;
}
function renderQuotaOverview() {
  const entries = quotaOverviewResults.filter(entry=>!el('quotaChannelFilter').value || entry.credential.mode===el('quotaChannelFilter').value);
  const groups = quotaGroups().filter(g=>!el('quotaChannelFilter').value || g.mode===el('quotaChannelFilter').value);
  const failed = entries.filter(e=>e.error).length;
  const low = groups.filter(g=>g.values.some(v=>v<=.2)).length;
  el('quotaKpis').replaceChildren();
  for (const [name,value,hint] of [['已查询账号',entries.length,'成功 '+(entries.length-failed)+' · 失败 '+failed],['返回额度项',groups.length,'按 Gemini / Claude 共享配额分别统计'],['存在低额度的配额项',low,'任一已知账号剩余 ≤ 20%'],['未知额度',groups.filter(g=>g.unknown>0).length,'上游未报告剩余比例']]) {
    const box = ui('a','metric metric-link'); box.setAttribute('href',name==='已查询账号'?'#quotaAccountDetails':'#quotaSummary');
    box.onclick=event=>{ event?.preventDefault(); if(busy) return; const target=el(name==='已查询账号'?'quotaAccountDetails':'quotaSummary'); if(name!=='已查询账号') { el('quotaSearch').value=''; el('quotaStateFilter').value=name==='未知额度'?'unknown':name==='存在低额度的配额项'?'low_or_empty':'all'; quotaModelPage=0; renderQuotaOverview(); } target.scrollIntoView?.({block:'start',behavior:'smooth'}); };
    box.append(ui('small','',name),ui('strong','',value),ui('small','',hint)); el('quotaKpis').append(box);
  }
  const filtered = groups.filter(modelMatches).sort((a,b)=>el('quotaSort').value === 'name' ? a.id.localeCompare(b.id) : (a.minimum ?? 2)-(b.minimum ?? 2) || a.id.localeCompare(b.id));
  quotaModelPage = Math.min(quotaModelPage,Math.max(0,Math.ceil(filtered.length/8)-1));
  el('quotaSummary').replaceChildren();
  for (const group of filtered.slice(quotaModelPage*8,quotaModelPage*8+8)) {
    const card = ui('article','quota-model-card');
    const heading = ui('div','quota-card-heading'); heading.append(ui('h3','',group.id+' · '+group.mode+(group.tokenType?' · '+group.tokenType:'')),ui('span','pill '+quotaTone(group.minimum),group.minimum == null ? '未报告' : group.minimum===0 ? '存在耗尽账号' : group.minimum<=.2 ? '存在低额度账号' : '额度充足'));
    const balance = ui('div','quota-balance'); balance.append(ui('strong','',quotaPercent(group.average)),ui('span','','平均剩余'));
    const meta = ui('div','quota-meta'); meta.append(ui('span','','最低 '+quotaPercent(group.minimum)),ui('span','',group.values.length+' 个已知 · '+group.unknown+' 个未知'));
    const details = ui('details','quota-breakdown'); details.append(ui('summary','','查看 '+group.accounts.length+' 个账号的额度与重置时间'));
    const list = ui('div','quota-account-list');
    for (const account of [...group.accounts].sort((a,b)=>(a.remaining ?? 2)-(b.remaining ?? 2))) list.append(quotaAccountLine(account));
    details.append(list); card.append(heading,balance,meter(group.average,group.id+' 平均剩余额度'),meta,details); el('quotaSummary').append(card);
  }
  if (!filtered.length) emptyInto('quotaSummary',quotaOverviewResults.length ? '没有匹配的模型；可更改筛选，或在下方查看查询失败的账号。' : '点击“查询全部账号额度”开始；查询不会发起聊天。');
  paginationState('quotaModels',quotaModelPage,8,filtered.length);
  const accounts = entries.filter(entry=>{
    const query = el('quotaSearch').value.trim().toLowerCase();
    return !query || (entry.credential.user_email || entry.credential.name).toLowerCase().includes(query) || (!entry.error && accountQuota(entry).some(m=>m.id.toLowerCase().includes(query)));
  }).sort((a,b)=>Number(!!b.error)-Number(!!a.error));
  quotaAccountPage = Math.min(quotaAccountPage,Math.max(0,Math.ceil(accounts.length/6)-1));
  el('quotaOverviewBody').replaceChildren();
  for (const entry of accounts.slice(quotaAccountPage*6,quotaAccountPage*6+6)) {
    const card = ui('details','quota-account-card'); card.open = !!entry.error;
    const title = ui('summary'); title.append(ui('strong','',(entry.credential.user_email || entry.credential.name)+' · '+entry.credential.mode),ui('span','pill '+(entry.error ? 'empty' : 'healthy'),entry.error ? '查询失败' : accountQuota(entry).length+' 个额度组'));
    card.append(title);
    if (entry.error) card.append(ui('p','error-message',entry.error));
    else {
      card.append(ui('small','','查询于 '+formatReset(entry.value.queriedAt)+'（北京时间）'+(entry.value.cached?' · DO 缓存（最多 10 分钟）':'')));
      if (!entry.value.models.length) card.append(ui('p','','上游未返回模型，额度未知。'));
      for (const model of accountQuota(entry)) { const row = ui('div','account-model-line'); row.append(ui('strong','',model.id),ui('span',quotaTone(model.remaining),quotaPercent(model.remaining)),meter(model.remaining, model.id+' 剩余额度'),ui('small','',[quotaAmount(model),'当前报告重置 '+formatReset(model.resetTime),quotaWindows(model)].filter(Boolean).join(' · '))); card.append(row); }
    }
    el('quotaOverviewBody').append(card);
  }
  if (!accounts.length) emptyInto('quotaOverviewBody','暂无账号查询结果');
  paginationState('quotaAccounts',quotaAccountPage,6,accounts.length);
}
for (const id of ['quotaSearch','quotaStateFilter','quotaSort','quotaChannelFilter']) el(id).oninput = el(id).onchange = () => { quotaModelPage=0; quotaAccountPage=0; renderQuotaOverview(); };
el('quotaModelsPrev').onclick = () => { if (quotaModelPage>0) quotaModelPage--; renderQuotaOverview(); };
el('quotaModelsNext').onclick = () => { if ((quotaModelPage+1)*8<quotaGroups().filter(modelMatches).length) quotaModelPage++; renderQuotaOverview(); };
el('quotaAccountsPrev').onclick = () => { if (quotaAccountPage>0) quotaAccountPage--; renderQuotaOverview(); };
el('quotaAccountsNext').onclick = () => { if ((quotaAccountPage+1)*6<quotaOverviewResults.length) quotaAccountPage++; renderQuotaOverview(); };
`;
