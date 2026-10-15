import { overviewPage } from './panel-pages/overview.js';
import { credentialsPage } from './panel-pages/credentials.js';
import { quotaPage } from './panel-pages/quota.js';
import { logsPage } from './panel-pages/logs.js';
import { importPage } from './panel-pages/import.js';
import { oauthPage } from './panel-pages/oauth.js';
import { modelsPage } from './panel-pages/models.js';
import { settingsPage } from './panel-pages/settings.js';
import { apiPage } from './panel-pages/api.js';

export const panelPages = [
  {
    "id": "overview",
    "title": "概览",
    "description": "查看服务账号与近期调用表现。",
    "number": "01",
    "group": "运行",
    "path": "/panel/overview"
  },
  {
    "id": "credentials",
    "title": "凭证管理",
    "description": "集中管理账号、健康状态和调度参数。",
    "number": "02",
    "group": "运行",
    "path": "/panel/credentials"
  },
  {
    "id": "quota",
    "title": "额度总览",
    "description": "按模型查看额度分布，快速定位低额度与异常账号。",
    "number": "03",
    "group": "运行",
    "path": "/panel/quota"
  },
  {
    "id": "logs",
    "title": "调用日志",
    "description": "定位失败请求，筛选、导出与清理日志。",
    "number": "04",
    "group": "运行",
    "path": "/panel/logs"
  },
  {
    "id": "import",
    "title": "导入凭证",
    "description": "从 JSON 凭证或已有备份添加账号。",
    "number": "05",
    "group": "账号接入",
    "path": "/panel/import"
  },
  {
    "id": "oauth",
    "title": "Google 授权",
    "description": "通过 Google 授权获取并保存账号凭证。",
    "number": "06",
    "group": "账号接入",
    "path": "/panel/oauth"
  },
  {
    "id": "models",
    "title": "模型列表",
    "description": "查询模型 ID，确认客户端可选择的模型。",
    "number": "07",
    "group": "配置",
    "path": "/panel/models"
  },
  {
    "id": "settings",
    "title": "系统设置",
    "description": "配置凭证调度、重试与响应兼容行为。",
    "number": "08",
    "group": "配置",
    "path": "/panel/settings"
  },
  {
    "id": "api",
    "title": "接口接入",
    "description": "复制接口地址，连接 OpenAI、Anthropic 或 Gemini 客户端。",
    "number": "09",
    "group": "配置",
    "path": "/panel/api"
  }
];
const pageContent = { overview: overviewPage, credentials: credentialsPage, quota: quotaPage, logs: logsPage, import: importPage, oauth: oauthPage, models: modelsPage, settings: settingsPage, api: apiPage };
export const panelFrame = String.raw`<a class="skip-link" href="#mainContent">跳到主要内容</a><section id="loginCard" class="login-screen"><div class="login-box"><div class="brand"><span class="brand-mark">G</span><div>GCLI2API<span>管理控制台</span></div></div><h1>欢迎回来</h1><p>登录以管理你的账号和 API 服务。</p><form id="loginForm"><label for="password">管理密码</label><input id="password" type="password" autocomplete="current-password" placeholder="输入管理密码" required><button>登录控制台 <span aria-hidden="true">→</span></button></form><small>登录有效期为 7 天，刷新页面会自动恢复。</small></div></section><div id="workspace" class="app-shell" hidden><aside class="sidebar"><a class="brand" href="/panel/overview" data-page-link="overview"><span class="brand-mark">G</span><div>GCLI2API<span>管理控制台</span></div></a><nav aria-label="管理页面"><div class="nav-label">运行</div><a id="nav-overview" href="/panel/overview" data-page-link="overview"><span class="nav-icon" aria-hidden="true">01</span><span>概览</span></a><a id="nav-credentials" href="/panel/credentials" data-page-link="credentials"><span class="nav-icon" aria-hidden="true">02</span><span>凭证管理</span></a><a id="nav-quota" href="/panel/quota" data-page-link="quota"><span class="nav-icon" aria-hidden="true">03</span><span>额度总览</span></a><a id="nav-logs" href="/panel/logs" data-page-link="logs"><span class="nav-icon" aria-hidden="true">04</span><span>调用日志</span></a><div class="nav-label">账号接入</div><a id="nav-import" href="/panel/import" data-page-link="import"><span class="nav-icon" aria-hidden="true">05</span><span>导入凭证</span></a><a id="nav-oauth" href="/panel/oauth" data-page-link="oauth"><span class="nav-icon" aria-hidden="true">06</span><span>Google 授权</span></a><div class="nav-label">配置</div><a id="nav-models" href="/panel/models" data-page-link="models"><span class="nav-icon" aria-hidden="true">07</span><span>模型列表</span></a><a id="nav-settings" href="/panel/settings" data-page-link="settings"><span class="nav-icon" aria-hidden="true">08</span><span>系统设置</span></a><a id="nav-api" href="/panel/api" data-page-link="api"><span class="nav-icon" aria-hidden="true">09</span><span>接口接入</span></a></nav><div class="sidebar-footer"><span class="connection-dot"></span> Cloudflare Workers<span class="version">v0.13.0</span></div></aside><main id="mainContent"><header class="topbar"><div>控制台 <span aria-hidden="true">/</span> <span id="pageBreadcrumb">概览</span></div><div class="topbar-actions"><span class="session-label"><span class="connection-dot"></span> 管理员会话</span><button class="secondary" id="logout">退出登录</button></div></header><div class="main-inner"><div class="page-heading"><div><p class="eyebrow">GCLI2API / CONTROL PANEL</p><h1 id="pageTitle" tabindex="-1">概览</h1><p id="pageDescription">查看服务账号与近期调用表现。</p></div><span class="page-version">v0.13.0</span></div>${panelPages.map(page => '<div class="page-view" id="page-' + page.id + '" aria-labelledby="pageTitle"' + (page.id === 'overview' ? '' : ' hidden') + '>' + pageContent[page.id] + '</div>').join('')}</div></main></div><div class="status-bar" role="status" id="status" aria-live="polite">正在检查登录状态…</div>`;
export function isPanelPath(path) { return path === '/' || path === '/panel' || path === '/panel/' || panelPages.some(page => page.path === path.replace(/\/$/, '')); }
