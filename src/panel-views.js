import { projectIcon } from './project-icon.js';
import { VERSION } from './version.js';
import { overviewPage } from './panel-pages/overview.js';
import { credentialsPage } from './panel-pages/credentials.js';
import { quotaPage } from './panel-pages/quota.js';
import { logsPage } from './panel-pages/logs.js';
import { importPage } from './panel-pages/import.js';
import { oauthPage } from './panel-pages/oauth.js';
import { modelsPage } from './panel-pages/models.js';
import { settingsPage } from './panel-pages/settings.js';
import { apiPage } from './panel-pages/api.js';
import { keysPage } from './panel-pages/keys.js';

export const panelPages = [
  {
    id: 'overview',
    title: '概览',
    description: '查看账号状态、用量和需要关注的问题。',
    path: '/panel/overview',
  },
  {
    id: 'credentials',
    title: '凭证管理',
    description: '管理账号、查询额度，导入文件或通过 Google 授权添加账号。',
    path: '/panel/credentials',
  },
  {
    id: 'keys',
    title: 'API 密钥',
    description: '为各项目分配密钥，管理访问和用量。',
    path: '/panel/keys',
  },
  {
    id: 'logs',
    title: '问题一览',
    description: '查看失败、取消及重试记录，追踪问题处理结果。',
    path: '/panel/logs',
  },
  {
    id: 'settings',
    title: '系统设置',
    description: '调整运行参数、查看模型和客户端接入地址。',
    path: '/panel/settings',
  },
];
export const panelTabs = {
  credentials: [
    { id: 'credentials', title: '账号列表' },
    { id: 'quota', title: '额度总览' },
    { id: 'import', title: '导入凭证' },
    { id: 'oauth', title: 'Google 授权' },
  ],
  settings: [
    { id: 'settings', title: '运行参数' },
    { id: 'models', title: '模型列表' },
    { id: 'api', title: '接口接入' },
  ],
};
const pageContent = {
  overview: overviewPage,
  credentials: credentialsPage,
  quota: quotaPage,
  logs: logsPage,
  import: importPage,
  oauth: oauthPage,
  models: modelsPage,
  settings: settingsPage,
  api: apiPage,
  keys: keysPage,
};
function groupedContent(group) {
  const tabs = panelTabs[group];
  return (
    '<div class="tabs workspace-tabs" role="tablist" aria-label="' +
    (group === 'credentials' ? '账号管理' : '系统配置') +
    '">' +
    tabs
      .map(
        (tab, index) =>
          '<button class="tab" role="tab" id="tab-' +
          tab.id +
          '" aria-controls="section-' +
          tab.id +
          '" aria-selected="' +
          (index === 0) +
          '" tabindex="' +
          (index === 0 ? '0' : '-1') +
          '" data-page-link="' +
          tab.id +
          '">' +
          tab.title +
          '</button>',
      )
      .join('') +
    '</div>' +
    tabs
      .map(
        (tab, index) =>
          '<div role="tabpanel" id="section-' +
          tab.id +
          '" aria-labelledby="tab-' +
          tab.id +
          '"' +
          (index === 0 ? '' : ' hidden') +
          '>' +
          pageContent[tab.id] +
          '</div>',
      )
      .join('')
  );
}
const icons = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  credentials:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',
  keys: '<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-4-4 3-3m-6 0 3-3"/>',
  logs: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v1"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="white"/><circle cx="15" cy="17" r="3" fill="white"/>',
};
const sidebarLinks = panelPages
  .map(
    (page) =>
      '<a id="nav-' +
      page.id +
      '" href="' +
      page.path +
      '" data-page-link="' +
      page.id +
      '"><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      icons[page.id] +
      '</svg></span><span>' +
      page.title +
      '</span></a>',
  )
  .join('');
export const panelFrame = String.raw`<a class="skip-link" href="#mainContent">跳到主要内容</a><section id="loginCard" class="login-screen"><div class="login-box"><div class="brand"><span class="brand-mark" aria-hidden="true">${projectIcon}</span><div>GCLI2API<span>管理控制台</span></div></div><h1>欢迎回来</h1><p>登录以管理你的账号和 API 服务。</p><form id="loginForm"><label for="password">管理密码</label><input id="password" type="password" autocomplete="current-password" placeholder="输入管理密码" required><button>登录控制台 <span aria-hidden="true">→</span></button></form><small>登录有效期为 7 天，刷新页面会自动恢复。</small></div></section><div id="workspace" class="app-shell" hidden><aside class="sidebar"><a class="brand" href="/panel/overview" data-page-link="overview"><span class="brand-mark" aria-hidden="true">${projectIcon}</span><div>GCLI2API<span>管理控制台</span></div></a><nav aria-label="管理页面">${sidebarLinks}</nav><div class="sidebar-footer"><span class="connection-dot"></span> Cloudflare Workers<span class="version">v${VERSION}</span></div></aside><main id="mainContent"><header class="topbar"><div>控制台 <span aria-hidden="true">/</span> <span id="pageBreadcrumb">概览</span></div><div class="topbar-actions"><span class="session-label"><span class="connection-dot"></span> 管理员会话</span><button class="secondary" id="logout">退出登录</button></div></header><div class="main-inner"><div class="page-heading"><div><h1 id="pageTitle" tabindex="-1">概览</h1><p id="pageDescription">查看服务账号与近期调用表现。</p></div><span class="page-version">v${VERSION}</span></div>${panelPages.map((page) => '<div class="page-view" id="page-' + page.id + '" aria-labelledby="pageTitle"' + (page.id === 'overview' ? '' : ' hidden') + '>' + (panelTabs[page.id] ? groupedContent(page.id) : pageContent[page.id]) + '</div>').join('')}</div></main></div><div class="status-bar" role="status" id="status" aria-live="polite">正在检查登录状态…</div>`;
export function isPanelPath(path) {
  return (
    path === '/' ||
    path === '/panel' ||
    path === '/panel/' ||
    panelPages.some((page) => page.path === path.replace(/\/$/, '')) ||
    Object.values(panelTabs)
      .flat()
      .some((tab) => '/panel/' + tab.id === path.replace(/\/$/, ''))
  );
}
