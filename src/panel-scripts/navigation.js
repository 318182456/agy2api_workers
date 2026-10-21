import { panelPages, panelTabs } from '../panel-views.js';
export const navigationScript = String.raw`const pageDefinitions = ${JSON.stringify(panelPages)};
const tabDefinitions = ${JSON.stringify(panelTabs)};
const el = (id) => document.getElementById(id);
const status = (text) => {
  el('status').textContent = text;
};
let credentialsSnapshot = [];
let credentialsLoaded = false;
let oauthClientModes = {};
const selectedCredentials = new Set();
let stopBatch = false;
let duplicateSnapshot = [];
let settingsLoaded = false;
let busy = false;

let currentPage = 'overview';
let currentSection = 'overview';
const loadedPages = new Set();
function parentPage(id) {
  return (
    Object.entries(tabDefinitions).find(([, tabs]) => tabs.some((tab) => tab.id === id))?.[0] || id
  );
}
function pageFromLocation() {
  const path = (location.pathname || '/').replace(/\/$/, '');
  const ids = [
    ...pageDefinitions.map((page) => page.id),
    ...Object.values(tabDefinitions)
      .flat()
      .map((tab) => tab.id),
  ];
  return ids.find((id) => '/panel/' + id === path) || 'overview';
}
function restoreFilter(id, value) {
  if (['statsFrom', 'statsTo', 'callsFrom', 'callsTo'].includes(id) && value) {
    const date = new Date(/^\d+$/.test(value) ? Number(value) : value);
    value = Number.isFinite(date.getTime())
      ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : '';
  }
  el(id).value = value;
}
function applyTargetFilters(params) {
  if (currentPage === 'overview') {
    for (const [key, id] of [
      ['model', 'statsModel'],
      ['mode', 'statsMode'],
      ['email', 'statsEmail'],
      ['from', 'statsFrom'],
      ['to', 'statsTo'],
    ])
      if (params.has(key)) restoreFilter(id, params.get(key));
  }
  if (currentPage === 'overview' && params.has('api_key_id')) {
    const id = params.get('api_key_id');
    if (id && !Array.from(el('statsApiKey').children).some((option) => option.value === id)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = '所选密钥';
      el('statsApiKey').append(option);
    }
    el('statsApiKey').value = id;
  }
  if (currentPage === 'credentials') {
    for (const [key, id] of [
      ['state', 'credentialState'],
      ['mode', 'credentialMode'],
      ['search', 'credentialSearch'],
    ])
      if (params.has(key)) restoreFilter(id, params.get(key));
    credentialPage = 0;
  }
  if (currentPage === 'logs') {
    for (const [key, id] of [
      ['scope', 'callsScope'],
      ['status', 'callsStatus'],
      ['model', 'callsModel'],
      ['mode', 'callsMode'],
      ['request_id', 'callsRequest'],
      ['email', 'callsEmail'],
      ['stage', 'callsStage'],
      ['credential_id', 'callsCredential'],
      ['from', 'callsFrom'],
      ['to', 'callsTo'],
    ])
      if (params.has(key)) restoreFilter(id, params.get(key));
  }
}
function showPage(id, historyMode = 'push', params) {
  const page = pageDefinitions.find((page) => page.id === parentPage(id)) || pageDefinitions[0];
  if (currentPage === 'keys' && page.id !== 'keys') {
    clearKeySecret();
    el('keyImportData').value = '';
    el('keyImportFile').value = '';
  }
  currentPage = page.id;
  currentSection = tabDefinitions[page.id]?.some((tab) => tab.id === id) ? id : page.id;
  for (const item of pageDefinitions) {
    el('page-' + item.id).hidden = item.id !== page.id;
    if (item.id === page.id) el('nav-' + item.id).setAttribute('aria-current', 'page');
    else el('nav-' + item.id).removeAttribute('aria-current');
  }
  for (const [group, tabs] of Object.entries(tabDefinitions)) {
    const selected = group === page.id ? currentSection : tabs[0].id;
    for (const tab of tabs) {
      el('section-' + tab.id).hidden = tab.id !== selected;
      el('tab-' + tab.id).setAttribute('aria-selected', String(tab.id === selected));
      el('tab-' + tab.id).tabIndex = tab.id === selected ? 0 : -1;
    }
  }
  el('pageTitle').textContent = page.title;
  el('pageDescription').textContent = page.description;
  el('pageBreadcrumb').textContent = page.title;
  document.title = page.title + ' · GCLI2API Workers';
  if (historyMode && typeof scrollTo === 'function') scrollTo({ top: 0, behavior: 'auto' });
  const query = params?.toString();
  const search = params
    ? query
      ? '?' + query
      : ''
    : historyMode !== 'push'
      ? location.search || ''
      : '';
  const path = '/panel/' + currentSection + search;
  if (
    historyMode &&
    typeof history !== 'undefined' &&
    location.pathname + (location.search || '') !== path
  )
    history[historyMode === 'replace' ? 'replaceState' : 'pushState']({ page: page.id }, '', path);
  applyTargetFilters(params || new URLSearchParams(location.search || ''));
}
async function loadPage(id) {
  if (loadedPages.has(id)) return;
  const parent = parentPage(id);
  status('正在加载页面…');
  if (parent === 'overview') {
    await refresh();
    await loadStats();
  } else if (parent === 'credentials') {
    if (!loadedPages.has('credentials')) {
      await refresh();
      loadedPages.add('credentials');
    }
    status('账号管理已就绪。');
  } else if (parent === 'logs') {
    await refresh();
    await loadCalls();
  } else if (parent === 'keys') await loadKeys();
  else if (id === 'settings') {
    fillSettings(await api('/admin/settings'));
    status('设置已加载。');
  } else if (id === 'storage') await loadStorageNodes();
  else if (id === 'api') {
    if (!credentialsLoaded) await refresh();
    renderEndpoints();
    status('接口可用状态已加载。');
  } else status('页面已就绪。');
  loadedPages.add(id);
}
async function openWorkspace() {
  el('loginCard').hidden = true;
  el('workspace').hidden = false;
  const id = pageFromLocation();
  showPage(id, 'replace');
  await loadPage(id);
}
function bindMetricLink(node, id, params = {}, detail) {
  node.className += ' metric-link';
  const query = new URLSearchParams(params);
  node.setAttribute(
    'href',
    '/panel/' + id + (query.size ? '?' + query : '') + (detail ? '#' + detail : ''),
  );
  node.onclick = (event) => {
    if (
      event &&
      (event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        (event.button != null && event.button !== 0))
    )
      return;
    event?.preventDefault();
    return run(async () => {
      const cached = loadedPages.has(id);
      showPage(id, 'push', query);
      await loadPage(id);
      if (id === 'credentials') renderCredentials();
      if (id === 'logs' && cached) await loadCalls();
      if (id === 'overview' && cached && query.has('api_key_id')) await loadStats();
      if (detail) {
        const target = el(detail);
        target.open = true;
        if (typeof history !== 'undefined')
          history.replaceState({}, '', location.pathname + (location.search || '') + '#' + detail);
        target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      }
    });
  };
}
function followPage(id, event) {
  if (
    event &&
    (event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      (event.button != null && event.button !== 0))
  )
    return;
  event?.preventDefault();
  if (busy) {
    status('当前操作进行中，请完成或停止后再切换页面。');
    return;
  }
  showPage(id);
  el('pageTitle').focus?.();
  return run(async () => {
    await loadPage(id);
    if (parentPage(id) === 'credentials') renderCredentials();
  });
}
for (const page of pageDefinitions)
  el('nav-' + page.id).onclick = (event) => followPage(page.id, event);
for (const link of document.querySelectorAll('[data-page-link]'))
  link.onclick = (event) => followPage(link.dataset.pageLink, event);
if (typeof addEventListener !== 'undefined')
  addEventListener('popstate', () => {
    const id = pageFromLocation();
    showPage(id, null);
    if (!el('workspace').hidden)
      run(async () => {
        await loadPage(id);
        if (currentPage === 'credentials') renderCredentials();
        else if (currentPage === 'logs' && location.search) await loadCalls();
        else if (currentPage === 'overview') {
          if (!new URLSearchParams(location.search).has('api_key_id')) el('statsApiKey').value = '';
          await loadStats();
        }
      });
  });
for (const tabs of Object.values(tabDefinitions))
  for (const [index, tab] of tabs.entries()) {
    el('tab-' + tab.id).onclick = (event) => followPage(tab.id, event);
    el('tab-' + tab.id).onkeydown = (event) => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      followPage(tabs[next].id);
      el('tab-' + tabs[next].id).focus?.();
    };
  }
function selectStatsTab(id) {
  for (const key of ['days', 'models', 'credentials', 'api_keys']) {
    el('stats-view-' + key).hidden = key !== id;
    el('stats-tab-' + key).setAttribute('aria-selected', String(key === id));
    el('stats-tab-' + key).tabIndex = key === id ? 0 : -1;
  }
}
for (const id of ['days', 'models', 'credentials', 'api_keys']) {
  el('stats-tab-' + id).onclick = () => selectStatsTab(id);
  el('stats-tab-' + id).onkeydown = (event) => {
    const keys = ['days', 'models', 'credentials', 'api_keys'];
    let index = keys.indexOf(id);
    if (event.key === 'ArrowRight') index = (index + 1) % keys.length;
    else if (event.key === 'ArrowLeft') index = (index + keys.length - 1) % keys.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = keys.length - 1;
    else return;
    event.preventDefault();
    selectStatsTab(keys[index]);
    el('stats-tab-' + keys[index]).focus?.();
  };
}
selectStatsTab('days');
for (const button of document.querySelectorAll('[data-copy]'))
  button.onclick = () =>
    run(async () => {
      const text = el(button.dataset.copy).textContent;
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        status('接口地址已复制。');
      } else status('请复制接口地址：' + text);
    });

let runtimeProbe = null;
function updateRuntimeRegion(response) {
  const badge = el('runtimeRegion');
  if (!badge) return;
  const placement = response.headers?.get('cf-placement') || '';
  const match = placement.match(/^(?:local|remote)-([A-Z]{3})$/i);
  const code = match?.[1].toUpperCase();
  const regions = {
    IAD: '美国 · 阿什本',
    EWR: '美国 · 纽瓦克',
    SJC: '美国 · 圣何塞',
    LAX: '美国 · 洛杉矶',
    SEA: '美国 · 西雅图',
    ORD: '美国 · 芝加哥',
    NRT: '日本 · 东京',
    HND: '日本 · 东京',
    KIX: '日本 · 大阪',
    SIN: '新加坡',
    HKG: '中国香港',
    LHR: '英国 · 伦敦',
    FRA: '德国 · 法兰克福',
  };
  if (!code && runtimeProbe) {
    const stale = Date.now() - runtimeProbe.queried_at >= runtimeProbe.cache_seconds * 1000;
    badge.textContent =
      '探测节点：' +
      (regions[runtimeProbe.probe_colo] || runtimeProbe.probe_colo) +
      (stale ? '（待更新）' : '');
    badge.title =
      'Cloudflare trace 地域提示（不用于判断 Worker 出口国家）：' +
      runtimeProbe.country +
      '；探测接收节点：' +
      runtimeProbe.probe_colo +
      '；查询时间：' +
      new Date(runtimeProbe.queried_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) +
      '（北京时间）。不是实际执行节点，也不保证 Google 使用同一出口。';
    return;
  }
  badge.textContent = code
    ? '执行位置：' + (regions[code] ? regions[code] + ' (' + code + ')' : code)
    : '执行位置：未知';
  badge.title = code
    ? 'Cloudflare cf-placement: ' +
      placement +
      '。这是本次请求执行位置，不代表固定 Google 出口 IP。'
    : 'Cloudflare 未提供 cf-placement，无法确认本次请求执行位置。';
}
el('runtimeRegionRefresh').onclick = () =>
  run(async () => {
    status('正在由 Worker 查询探测节点…');
    const value = await api('/admin/runtime-location');
    runtimeProbe = value;
    updateRuntimeRegion({
      headers: { get: () => (value.execution_colo ? 'remote-' + value.execution_colo : null) },
    });
    status(
      '地区查询完成' +
        (value.cached ? '（60 秒缓存）' : '') +
        '；探测接收节点 ' +
        value.probe_colo +
        '，不代表 Google 出口或实际执行节点。',
    );
  });
async function api(path, method = 'GET', body, responseType) {
  const raw = typeof Blob !== 'undefined' && body instanceof Blob;
  const headers = {};
  if (body !== undefined)
    headers['content-type'] = raw ? body.type || 'application/zip' : 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  updateRuntimeRegion(response);
  if (response.ok && responseType === 'blob') return response.blob();
  const value = await response.json();
  if (response.status === 401) {
    resetKeys();
    loadedPages.clear();
    el('workspace').hidden = true;
    el('loginCard').hidden = false;
  }
  if (!response.ok) {
    const error = new Error(
      (value.error?.message || 'HTTP ' + response.status) +
        (value.error?.stage ? ' [阶段：' + value.error.stage + ']' : '') +
        (value.error?.request_id ? ' [请求ID：' + value.error.request_id + ']' : ''),
    );
    error.reason = value.error?.reason;
    throw error;
  }
  return value;
}
async function run(action) {
  if (busy) return;
  busy = true;
  // Loading is temporary; disabled belongs to each control's own business state.
  const controls = Array.from(document.querySelectorAll('button'))
    .filter((button) => !['batchStop', 'quotaOverviewStop'].includes(button.id))
    .map((button) => ({ button, wasInert: !!button.inert }));
  controls.forEach(({ button }) => {
    button.inert = true;
  });
  try {
    await action();
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controls.forEach(({ button, wasInert }) => {
      button.inert = wasInert;
    });
  }
}
`;
