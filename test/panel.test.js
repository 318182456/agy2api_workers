import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { panel } from '../src/panel/index.js';

// Run the actual embedded management script with a minimal DOM and mocked HTTP.
// This exercises batch failures and backup round trips, not Google or production data.
test('management script: batch continues after one failure and exports/imports credential backups', async () => {
  class Element {
    constructor() {
      this.value = '';
      this.textContent = '';
      this.hidden = false;
      this.children = [];
      this.dataset = {};
      this.files = [];
    }
    append(...items) {
      this.children.push(...items);
    }
    replaceChildren(...items) {
      this.children = items;
    }
    setAttribute() {}
    removeAttribute() {}
    addEventListener() {}
    remove() {}
    click() {}
    scrollIntoView() {}
  }
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let rows = [
    { id: 'a', name: 'account-a', mode: 'antigravity', disabled: 0 },
    { id: 'b', name: 'account-b', mode: 'antigravity', disabled: 0 },
  ];
  const requests = [];
  const downloads = [];
  class BrowserURL extends URL {
    static createObjectURL(blob) {
      downloads.push(blob);
      return 'blob:test';
    }
    static revokeObjectURL() {}
  }
  const document = {
    getElementById: el,
    createElement: () => new Element(),
    createTextNode: (text) => text,
    querySelectorAll: () => [],
    body: new Element(),
  };
  let releaseHealth;
  const healthGate = new Promise((resolve) => {
    releaseHealth = resolve;
  });
  let liveRequests = 0;
  const fetcher = async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method: options.method, body });
    if (path === '/auth/session') return Response.json({ authenticated: false });
    if (path === '/admin/credentials/live')
      return Response.json(
        liveRequests++ === 0 ? await healthGate : { health: [], queried_at: Date.now() },
      );
    if (path === '/admin/credentials?view=basic' && options.method === 'GET')
      return Response.json({ credentials: rows });
    if (path === '/admin/credentials/a' && options.method === 'PATCH')
      return Response.json({ error: { message: 'expected failure' } }, { status: 500 });
    if (path === '/admin/credentials/b' && options.method === 'PATCH') {
      rows[1].disabled = Number(body.disabled);
      return Response.json({ success: true });
    }
    if (path.endsWith('/download'))
      return Response.json({
        project_id: 'p',
        refresh_token: 'test-refresh-secret',
        user_email: 'account@example.test',
      });
    if (path === '/admin/credentials' && options.method === 'POST') {
      rows.push({
        id: 'restored-' + rows.length,
        name: body.name,
        mode: body.mode,
        disabled: Number(body.disabled || false),
        user_email: body.credential.user_email,
      });
      return Response.json({ success: true });
    }
    throw new Error('Unexpected test request: ' + path);
  };
  const context = vm.createContext({
    document,
    fetch: fetcher,
    Blob,
    URL: BrowserURL,
    URLSearchParams,
    Intl,
    Date,
    JSON,
    Set,
    Map,
    location: { origin: 'https://test' },
    confirm: () => true,
    prompt: () => null,
    setTimeout: (callback) => {
      callback();
      return 0;
    },
  });
  vm.runInContext(panel.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise((resolve) => setImmediate(resolve));
  await vm.runInContext('refresh()', context);
  assert.equal(
    vm.runInContext('credentialsSnapshot.length', context),
    2,
    'account rows appear before live health completes',
  );
  releaseHealth({ health: [{ credential_id: 'a', last_success: 12345 }], queried_at: Date.now() });
  await vm.runInContext('credentialLiveFlight', context);
  assert.equal(
    vm.runInContext("credentialsSnapshot.find(row=>row.id==='a').last_success", context),
    12345,
  );
  vm.runInContext(
    "selectedCredentials.add('a'); selectedCredentials.add('b'); updateSelection();",
    context,
  );
  el('batchAction').value = 'disable';
  await el('batchRun').onclick();
  assert.equal(rows[1].disabled, 1);
  assert.match(el('batchResults').textContent, /account-a：失败/);
  assert.match(el('batchResults').textContent, /account-b：完成/);
  vm.runInContext("selectedCredentials.clear(); selectedCredentials.add('b');", context);
  el('batchAction').value = 'export';
  await el('batchRun').onclick();
  assert.equal(downloads.length, 1);
  const backup = JSON.parse(await downloads[0].text());
  assert.equal(backup.format, 'gcli2api-workers-credentials-v1');
  assert.equal(backup.credentials[0].disabled, true);
  assert.equal(backup.credentials[0].credential.refresh_token, 'test-refresh-secret');
  assert.doesNotMatch(el('batchResults').textContent, /test-refresh-secret/);
  rows = [];
  el('batchFiles').files = [
    { name: 'backup.json', size: 500, text: async () => JSON.stringify(backup) },
    { name: 'bad.json', size: 5, text: async () => '{bad' },
  ];
  await el('batchImportForm').onsubmit({ preventDefault() {} });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'account-b');
  assert.equal(rows[0].disabled, 1);
  assert.equal(rows[0].user_email, 'account@example.test');
  assert.match(el('batchResults').textContent, /bad.json：读取失败/);
  assert.doesNotMatch(el('batchResults').textContent, /test-refresh-secret/);
  el('workspace').hidden = true;
  vm.runInContext('panelTimings.clear()', context);
  vm.runInContext(
    "recordPanelTiming('/admin/credentials/live',Date.now(),{headers:{get:()=> 'nodes;dur=20'}})",
    context,
  );
  assert.equal(
    vm.runInContext('panelTimings.size', context),
    0,
    'late background responses must not restore diagnostics after logout',
  );
});

test('management script: quota failures continue, stop works, stats/health and scoped log controls render', async () => {
  class Element {
    constructor() {
      this.value = '';
      this.textContent = '';
      this.hidden = false;
      this.children = [];
      this.dataset = {};
      this.files = [];
      this.checked = false;
    }
    append(...items) {
      this.children.push(...items);
    }
    replaceChildren(...items) {
      this.children = items;
    }
    setAttribute() {}
    removeAttribute() {}
    addEventListener() {}
    remove() {}
    click() {}
    scrollIntoView() {}
  }
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const document = {
    getElementById: el,
    createElement: () => new Element(),
    createTextNode: (text) => text,
    querySelectorAll: (selector) =>
      selector === 'button'
        ? [
            'statsRefresh',
            'statsDaysPrev',
            'statsDaysNext',
            'statsModelsPrev',
            'statsModelsNext',
            'statsCredentialsPrev',
            'statsCredentialsNext',
          ].map(el)
        : [],
    body: new Element(),
  };
  const downloads = [];
  class BrowserURL extends URL {
    static createObjectURL(blob) {
      downloads.push(blob);
      return 'blob:test';
    }
    static revokeObjectURL() {}
  }
  const rows = [
    {
      id: 'a',
      name: 'A',
      user_email: 'a@example.test',
      mode: 'antigravity',
      priority: 2,
      weight: 3,
    },
    { id: 'b', name: 'B', mode: 'antigravity' },
    { id: 'c', name: 'C', mode: 'antigravity', disabled: 1 },
    { id: 'd', name: 'D', mode: 'geminicli' },
  ];
  const requests = [];
  let stopOnFirst = false;
  const aggregate = {
    requests: 2,
    successes: 1,
    failures: 1,
    cancellations: 0,
    total_tokens: 15,
    token_reports: 1,
    avg_duration_ms: 20,
  };
  const settings = {
    effective: {
      MAX_CREDENTIAL_ATTEMPTS: 3,
      ANTIGRAVITY_STREAM2NOSTREAM: false,
      CREDENTIAL_SELECTION: 'priority',
    },
  };
  const fetcher = async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method: options.method, body });
    if (path === '/auth/session') return Response.json({ authenticated: false });
    if (path === '/auth/logout') return Response.json({ success: true });
    if (path === '/admin/credentials?view=basic') return Response.json({ credentials: rows });
    if (path === '/admin/credentials/a/quota') {
      if (stopOnFirst) el('quotaOverviewStop').onclick();
      return Response.json({
        queriedAt: '2026-10-15T00:00:00Z',
        models: [
          { id: 'm', remaining: 0.4, resetTime: null },
          { id: 'unknown', remaining: null, resetTime: null },
        ],
      });
    }
    if (path === '/admin/credentials/d/quota')
      return Response.json({
        queriedAt: '2026-10-15T00:00:00Z',
        models: [
          {
            id: 'cli-model',
            remaining: 0.7,
            remainingAmount: '70',
            tokenType: 'REQUESTS',
            bucketIndex: 0,
          },
        ],
      });
    if (path === '/admin/credentials/b/quota')
      return Response.json({ error: { message: 'test quota failure' } }, { status: 502 });
    if (path === '/admin/credentials/a/health')
      return Response.json({
        health: {
          last_failure: 100,
          last_status: 429,
          last_stage: 'response_headers',
          last_code: 'HTTP_429',
          failure_streak: 1,
        },
        cooldowns: [{ model: 'm', until_ms: Date.now() + 10000, status: 429 }],
      });
    if (path.startsWith('/admin/stats?'))
      return Response.json({
        summary: aggregate,
        days: [{ ...aggregate, day: '2026-10-15' }],
        models: [{ ...aggregate, model: 'm', mode: 'antigravity' }],
        credentials: [
          {
            ...aggregate,
            credential_id: 'a',
            display_name: 'a@example.test',
            requests: 1,
            failures: 0,
          },
          {
            ...aggregate,
            credential_id: null,
            display_name: '未选中凭证',
            requests: 1,
            successes: 0,
            total_tokens: null,
            token_reports: 0,
          },
        ],
      });
    if (path === '/admin/settings') return Response.json(settings);
    if (path.startsWith('/admin/calls'))
      return Response.json(
        options.method === 'DELETE' ? { deleted: 1 } : { records: [], next: null },
      );
    throw new Error('Unexpected ' + path);
  };
  const context = vm.createContext({
    document,
    fetch: fetcher,
    Blob,
    URL: BrowserURL,
    URLSearchParams,
    Intl,
    Date,
    JSON,
    Set,
    Map,
    location: { origin: 'https://test' },
    confirm: () => true,
    prompt: () => null,
    setTimeout: (callback) => {
      callback();
      return 0;
    },
  });
  vm.runInContext(panel.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise((resolve) => setImmediate(resolve));
  await el('quotaOverviewRefresh').onclick();
  assert.equal(requests.filter((r) => r.path.endsWith('/quota')).length, 3);
  assert.equal(el('quotaOverviewBody').children.length, 3);
  assert.match(el('quotaOverviewState').textContent, /失败 1/);
  const summary = el('quotaSummary').children.find(
    (card) => card.children[0].children[0].textContent === 'm · antigravity',
  );
  assert.equal(summary.children[1].children[0].textContent, '40.0%');
  assert.equal(summary.children[3].children[1].textContent, '1 个已知 · 0 个未知');
  assert.equal(
    el('quotaSummary').children.find(
      (card) => card.children[0].children[0].textContent === 'unknown · antigravity',
    ).children[1].children[0].textContent,
    '未知',
  );
  assert.equal(el('quotaKpis').children[0].children[1].textContent, '3');
  assert.equal(el('quotaOverviewBody').children[0].children[0].children[1].textContent, '查询失败');
  stopOnFirst = true;
  const before = requests.length;
  await el('quotaOverviewRefresh').onclick();
  assert.equal(requests.slice(before).filter((r) => r.path.endsWith('/quota')).length, 1);
  assert.match(el('quotaOverviewState').textContent, /已停止/);
  const actions = el('credentials').children[0].children.at(-1);
  await actions.children.find((button) => button.textContent === '健康详情').onclick();
  assert.match(el('healthDetails').textContent, /a@example.test/);
  assert.match(el('healthDetails').textContent, /HTTP_429/);
  el('statsEmail').value = 'a@example.test';
  await el('statsRefresh').onclick();
  assert.equal(el('statsSummary').children[1].children[1].textContent, '50.0%');
  assert.equal(el('statsModels').children.length, 1);
  assert.equal(el('statsTrend').children.length, 1);
  assert.equal(el('statsModelRank').children.length, 1);
  assert.equal(el('statsAccountRank').children.length, 1);
  assert.equal(
    el('statsAccountRank').children[0].children[0].children[1].textContent,
    'a@example.test',
  );
  assert.match(el('statsCoverage').textContent, /其中 1 次请求在选中凭证前结束/);
  assert.equal(el('statsCredentials').children.length, 1);
  assert.match(el('statsCredentialsPage').textContent, /1 \/ 1 页 · 1 项/);
  for (const group of ['Days', 'Models', 'Credentials']) {
    assert.equal(el('stats' + group + 'Prev').disabled, true);
    assert.equal(el('stats' + group + 'Next').disabled, true);
  }
  assert.equal(el('statsRefresh').inert, false);
  assert.match(
    requests.find((r) => r.path.startsWith('/admin/stats?')).path,
    /email=a%40example.test/,
  );
  await el('settingsLoad').onclick();
  assert.equal(el('settingsStrategy').value, 'priority');
  el('settingsStrategy').value = 'weighted';
  el('settingsForm').onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    requests.find((r) => r.path === '/admin/settings' && r.method === 'PATCH').body
      .CREDENTIAL_SELECTION,
    'weighted',
  );
  el('callsStatus').value = '429';
  el('callsEmail').value = 'alpha';
  await el('callsExport').onclick();
  assert.equal(downloads.length, 1);
  await el('callsClear').onclick();
  const deletion = requests.find((r) => r.method === 'DELETE');
  assert.match(deletion.path, /status=429/);
  assert.match(deletion.path, /email=alpha/);
  assert.equal(deletion.body.confirm, 'delete-matching-logs');
  assert.equal(JSON.parse(await downloads[0].text()).records.length, 0);

  // Dozens of accounts/models stay bounded; null values never dilute averages.
  context.largeQuota = Array.from({ length: 35 }, (_, i) => ({
    credential: {
      id: String(i),
      mode: 'antigravity',
      name: 'account-' + i,
      user_email: 'user' + i + '@example.test',
    },
    value: {
      queriedAt: '2026-10-15T00:00:00Z',
      models: Array.from({ length: 21 }, (_, j) => ({
        id: 'model-' + String(j).padStart(2, '0'),
        remaining: j === 20 ? null : i === 0 ? 0 : i === 1 ? null : 0.4,
        resetTime: null,
      })),
    },
  }));
  vm.runInContext('quotaOverviewResults=largeQuota; renderQuotaOverview();', context);
  assert.equal(el('quotaSummary').children.length, 8);
  assert.equal(el('quotaOverviewBody').children.length, 6);
  assert.match(el('quotaModelsPage').textContent, /1 \/ 3/);
  const firstModel = el('quotaSummary').children[0];
  assert.equal(firstModel.children[1].children[0].textContent, '38.8%');
  assert.equal(firstModel.children[3].children[0].textContent, '最低 0.0%');
  assert.equal(firstModel.children[3].children[1].textContent, '34 个已知 · 1 个未知');
  el('quotaModelsNext').onclick();
  assert.match(el('quotaModelsPage').textContent, /2 \/ 3/);
  el('quotaSearch').value = 'model-20';
  el('quotaSearch').oninput();
  assert.equal(el('quotaSummary').children.length, 1);
  assert.equal(el('quotaSummary').children[0].children[1].children[0].textContent, '未知');
  assert.equal(el('quotaModelsNext').disabled, true);
  el('quotaSearch').value = '';
  el('quotaStateFilter').value = 'empty';
  el('quotaStateFilter').onchange();
  assert.match(el('quotaModelsPage').textContent, /共 20 项/);
  el('quotaStateFilter').value = 'low';
  el('quotaStateFilter').onchange();
  assert.equal(el('quotaModelsNext').disabled, true);
  el('quotaStateFilter').value = 'all';
  el('quotaStateFilter').onchange();
  el('quotaAccountsNext').onclick();
  assert.match(el('quotaAccountsPage').textContent, /2 \/ 6/);
  context.largeStats = {
    summary: aggregate,
    days: [],
    models: Array.from({ length: 27 }, (_, i) => ({
      ...aggregate,
      model: 'model-' + i,
      mode: 'antigravity',
      total_tokens: i * 10,
    })),
    credentials: Array.from({ length: 31 }, (_, i) => ({
      ...aggregate,
      credential_id: 'account-' + i,
      display_name: 'user' + i,
      total_tokens: i ? i * 100 : null,
    })),
  };
  vm.runInContext('renderStatsCharts(largeStats)', context);
  assert.equal(el('statsModels').children.length, 10);
  assert.equal(el('statsModelRank').children.length, 6);
  assert.equal(el('statsCredentialsPrev').disabled, true);
  assert.equal(el('statsCredentialsNext').disabled, false);
  for (let i = 0; i < 3; i++) el('statsCredentialsNext').onclick();
  assert.equal(el('statsCredentials').children.length, 1);
  assert.equal(el('statsCredentialsPrev').disabled, false);
  assert.equal(el('statsCredentialsNext').disabled, true);
  await vm.runInContext('run(async () => {})', context);
  assert.equal(el('statsCredentialsNext').disabled, true);
  assert.equal(el('statsAccountRank').children[0].children[0].children[1].textContent, 'user30');
  el('statsModelsNext').onclick();
  el('statsModelsNext').onclick();
  assert.equal(el('statsModels').children.length, 7);
  assert.equal(el('statsModelsNext').disabled, true);
  el('statsModelsPrev').onclick();
  assert.equal(el('statsModels').children.length, 10);
  await el('logout').onclick();
  assert.equal(el('statsModelRank').children.length, 0);
  assert.equal(el('quotaKpis').children.length, 0);
});

test('management pages: deep-link restore, lazy loading, history, retained inputs, filtering and cross-page selection', async () => {
  class Element {
    constructor() {
      this.value = '';
      this.textContent = '';
      this.hidden = false;
      this.children = [];
      this.dataset = {};
      this.files = [];
      this.checked = false;
      this.attributes = {};
    }
    append(...items) {
      this.children.push(...items);
    }
    replaceChildren(...items) {
      this.children = items;
    }
    setAttribute(key, value) {
      this.attributes[key] = value;
    }
    removeAttribute(key) {
      delete this.attributes[key];
    }
    addEventListener() {}
    remove() {}
    click() {}
    scrollIntoView() {}
    focus() {}
  }
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const document = {
    getElementById: el,
    createElement: () => new Element(),
    createTextNode: (text) => text,
    querySelectorAll: () => [],
    body: new Element(),
  };
  const location = { origin: 'https://test', pathname: '/panel/logs' };
  const visits = [];
  const events = {};
  const history = {
    pushState(state, title, path) {
      location.pathname = path;
      visits.push(path);
    },
    replaceState(state, title, path) {
      location.pathname = path;
    },
  };
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: String(i),
    name: 'account-' + i,
    user_email: 'user' + i + '@example.test',
    mode: i % 2 ? 'geminicli' : 'antigravity',
    disabled: i % 3 === 0 ? 1 : 0,
  }));
  const calls = [];
  const aggregate = { requests: 0, successes: 0, token_reports: 0 };
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/auth/session') return Response.json({ authenticated: true });
    if (path === '/admin/credentials?view=basic') return Response.json({ credentials: rows });
    if (path.startsWith('/admin/calls?')) return Response.json({ records: [], next: null });
    if (path.startsWith('/admin/stats?'))
      return Response.json({ summary: aggregate, days: [], models: [], credentials: [] });
    if (path === '/admin/settings')
      return Response.json({
        effective: {
          CREDENTIAL_SELECTION: 'round_robin',
          MAX_CREDENTIAL_ATTEMPTS: 3,
          ANTIGRAVITY_STREAM2NOSTREAM: false,
        },
      });
    throw new Error('Unexpected ' + path);
  };
  const context = vm.createContext({
    document,
    fetch: fetcher,
    Blob,
    URL,
    URLSearchParams,
    Intl,
    Date,
    JSON,
    Set,
    Map,
    location,
    history,
    addEventListener: (name, callback) => {
      events[name] = callback;
    },
    confirm: () => true,
    prompt: () => null,
    setTimeout: (callback) => {
      callback();
      return 0;
    },
  });
  vm.runInContext(panel.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (vm.runInContext('!busy', context)) break;
  }
  assert.equal(el('workspace').hidden, false);
  assert.equal(el('page-logs').hidden, false);
  assert.equal(el('page-overview').hidden, true);
  assert.equal(document.title, '问题一览 · GCLI2API Workers');
  assert.equal(
    calls.some((path) => path.startsWith('/admin/stats')),
    false,
  );
  el('credential').value = 'unsaved-json';
  el('callsStatus').value = '429';
  await el('nav-credentials').onclick({ preventDefault() {} });
  assert.equal(location.pathname, '/panel/credentials');
  assert.equal(el('nav-credentials').attributes['aria-current'], 'page');
  assert.equal(el('credentials').children.length, 50);
  assert.equal(el('credentialsNext').hidden, false);
  el('selectAll').checked = true;
  el('selectAll').onchange();
  assert.equal(vm.runInContext('selectedCredentials.size', context), 25);
  el('credentialsNext').onclick();
  assert.equal(el('credentials').children.length, 50);
  assert.equal(el('selectAll').checked, false);
  el('selectAll').checked = true;
  el('selectAll').onchange();
  assert.equal(vm.runInContext('selectedCredentials.size', context), 50);
  el('clearSelection').onclick();
  assert.equal(vm.runInContext('selectedCredentials.size', context), 0);
  el('credentialSearch').value = 'USER59@';
  el('credentialSearch').oninput();
  assert.equal(el('credentials').children.length, 2);
  assert.equal(el('credentialsNext').hidden, true);
  el('credentialMode').value = 'antigravity';
  el('credentialMode').onchange();
  assert.equal(el('credentials').children.length, 0);
  assert.equal(el('credentialsEmpty').hidden, false);
  await el('nav-overview').onclick({ preventDefault() {} });
  assert.equal(calls.filter((path) => path.startsWith('/admin/stats?')).length, 1);
  el('stats-tab-models').onclick();
  assert.equal(el('stats-view-models').hidden, false);
  assert.equal(el('stats-view-days').hidden, true);
  let prevented = false;
  el('stats-tab-models').onkeydown({
    key: 'ArrowRight',
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(el('stats-view-credentials').hidden, false);
  await el('nav-credentials').onclick({ preventDefault() {} });
  await el('tab-quota').onclick({ preventDefault() {} });
  assert.equal(
    calls.some((path) => path.endsWith('/quota')),
    false,
  );
  await el('nav-settings').onclick({ preventDefault() {} });
  assert.equal(el('settingsStrategy').value, 'round_robin');
  el('settingsStrategy').value = 'weighted';
  await el('tab-import').onclick({ preventDefault() {} });
  assert.equal(el('credential').value, 'unsaved-json');
  const before = calls.length;
  location.pathname = '/panel/logs';
  events.popstate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(el('page-logs').hidden, false);
  assert.equal(el('callsStatus').value, '429');
  assert.equal(calls.length, before);
  await el('nav-settings').onclick({ preventDefault() {} });
  assert.equal(el('settingsStrategy').value, 'weighted');
  assert.ok(visits.includes('/panel/import'));
  vm.runInContext(
    `quotaOverviewResults = [
    {credential:{id:'ag',mode:'antigravity',name:'same-email'},value:{models:[{id:'same-model',remaining:.8}]}},
    {credential:{id:'cli',mode:'geminicli',name:'same-email'},value:{models:[{id:'same-model',remaining:.4,bucketIndex:0}]}}
  ]`,
    context,
  );
  assert.equal(vm.runInContext('quotaGroups().length', context), 2);
  assert.equal(
    vm.runInContext('quotaGroups().find(g=>g.mode==="geminicli").average', context),
    0.4,
  );
});

test('API key list renders unused keys, later used keys and pagination even when usage rows are absent', async () => {
  const { keysScript } = await import('../src/panel/scripts/keys.js');
  class Element {
    constructor() {
      this.children = [];
      this.value = '';
      this.textContent = '';
      this.hidden = false;
    }
    setAttribute() {}
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    insertBefore(node, before) {
      this.children.splice(this.children.indexOf(before), 0, node);
    }
  }
  const nodes = new Map(),
    el = (id) => {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    };
  let unavailable = false;
  let holdUsage = false;
  const pendingUsage = [];
  const calls = [];
  const key = (id) => ({
    id,
    name: id,
    masked_key: 'masked',
    state: 'enabled',
    enabled: true,
    expires_at: null,
  });
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    el,
    run: (action) => action(),
    URLSearchParams,
    Date,
    Map,
    Array,
    Object,
    Number,
    String,
    formatReset: () => '',
    tokenText: (value) => Number(value).toLocaleString('zh-CN'),
    status: (text) => {
      el('status').textContent = text;
    },
    api: async (path) => {
      calls.push(path);
      if (path.startsWith('/admin/api-keys?')) {
        const page = new URLSearchParams(path.split('?')[1]).get('page');
        return {
          master_enabled: true,
          keys:
            page === '0'
              ? ['used-before', 'unused', 'used-after'].map(key)
              : ['unused-next-page'].map(key),
          has_next: page === '0',
        };
      }
      if (holdUsage) await new Promise((resolve) => pendingUsage.push(resolve));
      if (unavailable) throw new Error('fixture usage unavailable');
      return {
        api_keys: [
          {
            api_key_id: '00000000-0000-0000-0000-000000000000',
            requests: 1,
            total_tokens: 10,
            token_reports: 1,
          },
          { api_key_id: 'used-before', requests: 2, total_tokens: 20, token_reports: 2 },
          { api_key_id: 'used-after', requests: 2, total_tokens: 30, token_reports: 1 },
        ],
      };
    },
  });
  const { nearbyScript } = await import('../src/panel/scripts/nearby.js');
  vm.runInContext(nearbyScript, context);
  vm.runInContext(keysScript, context);
  await vm.runInContext('loadKeys()', context);
  await vm.runInContext('keysUsageFlight', context);
  assert.deepEqual(
    el('keysBody').children.map((row) => row.children[0].textContent),
    ['总密钥（兼容）', 'used-before', 'unused', 'used-after'],
  );
  assert.equal(el('keysBody').children[2].children[1].children[0].textContent, '0 Token');
  assert.equal(el('keysBody').children[3].children[1].children[0].textContent, '30 Token');
  assert.equal(el('keysNext').disabled, false);
  assert.equal(el('keysPrev').disabled, true);
  assert.equal(calls.filter((path) => path.startsWith('/admin/stats?')).length, 1);
  await el('keysNext').onclick();
  await vm.runInContext('keysUsageFlight', context);
  assert.equal(el('keysBody').children[0].children[0].textContent, 'unused-next-page');
  assert.equal(el('keysBody').children[0].children[1].children[0].textContent, '0 Token');
  assert.equal(el('keysNext').disabled, true);
  assert.equal(el('keysPrev').disabled, false);
  unavailable = true;
  await el('keysPrev').onclick();
  await vm.runInContext('keysUsageFlight', context);
  assert.equal(el('keysBody').children.length, 4);
  assert.equal(el('keysBody').children[2].children[1].children[0].textContent, '暂不可用');
  unavailable = false;
  holdUsage = true;
  await vm.runInContext('loadKeys()', context);
  assert.equal(el('keysBody').children.length, 4, 'list is usable before the statistics response');
  assert.equal(el('keysBody').children[0].children[1].children[0].textContent, '读取中…');
  await el('keysNext').onclick();
  assert.equal(el('keysBody').children[0].children[0].textContent, 'unused-next-page');
  pendingUsage[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    el('keysBody').children[0].children[1].children[0].textContent,
    '读取中…',
    'old page result cannot overwrite new page usage',
  );
  pendingUsage[1]();
  await vm.runInContext('keysUsageFlight', context);
  assert.equal(el('keysBody').children[0].children[1].children[0].textContent, '0 Token');
});
