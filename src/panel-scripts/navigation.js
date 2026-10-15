import { panelPages } from '../panel-views.js';
export const navigationScript = String.raw`const pageDefinitions = ${JSON.stringify(panelPages)};
const el = (id) => document.getElementById(id);
const status = (text) => {
  el('status').textContent = text;
};
let credentialsSnapshot = [];
let oauthClientModes = {};
const selectedCredentials = new Set();
let stopBatch = false;
let duplicateSnapshot = [];
let settingsLoaded = false;
let busy = false;

let currentPage = 'overview';
const loadedPages = new Set();
function pageFromLocation() {
  const path = (location.pathname || '/').replace(/\/$/, '');
  return pageDefinitions.find((page) => page.path === path)?.id || 'overview';
}
function showPage(id, historyMode = 'push') {
  const page = pageDefinitions.find((page) => page.id === id) || pageDefinitions[0];
  currentPage = page.id;
  for (const item of pageDefinitions) {
    el('page-' + item.id).hidden = item.id !== page.id;
    if (item.id === page.id) el('nav-' + item.id).setAttribute('aria-current', 'page');
    else el('nav-' + item.id).removeAttribute('aria-current');
  }
  el('pageTitle').textContent = page.title;
  el('pageDescription').textContent = page.description;
  el('pageBreadcrumb').textContent = page.title;
  document.title = page.title + ' · GCLI2API Workers';
  if (historyMode && typeof scrollTo === 'function') scrollTo({ top: 0, behavior: 'auto' });
  if (historyMode && typeof history !== 'undefined' && location.pathname !== page.path)
    history[historyMode === 'replace' ? 'replaceState' : 'pushState'](
      { page: page.id },
      '',
      page.path,
    );
}
async function loadPage(id) {
  if (loadedPages.has(id)) return;
  status('正在加载' + (pageDefinitions.find((page) => page.id === id)?.title || '页面') + '…');
  if (id === 'overview') {
    await refresh();
    await loadStats();
  } else if (id === 'credentials') await refresh();
  else if (id === 'logs') {
    await refresh();
    await loadCalls();
  } else if (id === 'import') {
    const value = await api('/admin/credentials');
    oauthClientModes = value.oauth_clients || {};
    status('页面已就绪。');
  } else if (id === 'settings') {
    fillSettings(await api('/admin/settings'));
    status('设置已加载。');
  } else status('页面已就绪。');
  loadedPages.add(id);
}
async function openWorkspace() {
  el('loginCard').hidden = true;
  el('workspace').hidden = false;
  showPage(pageFromLocation(), 'replace');
  await loadPage(currentPage);
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
  return run(() => loadPage(id));
}
for (const page of pageDefinitions)
  el('nav-' + page.id).onclick = (event) => followPage(page.id, event);
for (const link of document.querySelectorAll('[data-page-link]'))
  link.onclick = (event) => followPage(link.dataset.pageLink, event);
if (typeof addEventListener !== 'undefined')
  addEventListener('popstate', () => {
    showPage(pageFromLocation(), null);
    if (!el('workspace').hidden) run(() => loadPage(currentPage));
  });
function selectStatsTab(id) {
  for (const key of ['days', 'models', 'credentials']) {
    el('stats-view-' + key).hidden = key !== id;
    el('stats-tab-' + key).setAttribute('aria-selected', String(key === id));
    el('stats-tab-' + key).tabIndex = key === id ? 0 : -1;
  }
}
for (const id of ['days', 'models', 'credentials']) {
  el('stats-tab-' + id).onclick = () => selectStatsTab(id);
  el('stats-tab-' + id).onkeydown = (event) => {
    const keys = ['days', 'models', 'credentials'];
    let index = keys.indexOf(id);
    if (event.key === 'ArrowRight') index = (index + 1) % keys.length;
    else if (event.key === 'ArrowLeft') index = (index + 2) % keys.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = 2;
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

async function api(path, method = 'GET', body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (response.status === 401) {
    loadedPages.clear();
    el('workspace').hidden = true;
    el('loginCard').hidden = false;
  }
  if (!response.ok)
    throw new Error(
      (value.error?.message || 'HTTP ' + response.status) +
        (value.error?.stage ? ' [阶段：' + value.error.stage + ']' : '') +
        (value.error?.request_id ? ' [请求ID：' + value.error.request_id + ']' : ''),
    );
  return value;
}
async function run(action) {
  if (busy) return;
  busy = true;
  const buttons = Array.from(document.querySelectorAll('button'));
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    await action();
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => {
      button.disabled = false;
    });
  }
}
`;
