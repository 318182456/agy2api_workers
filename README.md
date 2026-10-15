# GCLI2API Workers

将 GeminiCLI / Antigravity 凭证接入 OpenAI、Anthropic 和 Gemini API，运行在 **Cloudflare Workers + D1** 上，自带中文管理控制台。

无需 Python、Docker 或独立服务器。API 转换、账号调度、凭证存储和管理页面由同一个 Worker 提供。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/318182456/gcli2api-workers)

[快速部署](#一键部署到-cloudflare) · [接入客户端](#接入客户端) · [配置说明](#配置说明) · [常见问题](#常见问题)

## 功能

| 模块 | 支持内容 |
| --- | --- |
| API 兼容 | OpenAI Chat Completions、Anthropic Messages、Gemini 原生接口，普通响应与 SSE 流式输出 |
| 双渠道 | GeminiCLI、Antigravity 分别管理凭证、模型与调用路径 |
| 凭证管理 | JSON 导入、多文件导入、备份恢复、启停、重命名、邮箱查重、下载 |
| Google 授权 | 授权链接、PKCE、一次性 state、手动回填回调 URL |
| 账号调度 | 轮询、优先级、权重随机；按模型冷却，失败时有限切换凭证 |
| 用量统计 | 请求数、成功率、Token、耗时、每日趋势、热门模型与账号消耗排行 |
| 额度总览 | Antigravity 模型额度卡片、进度条、低额度筛选、账号详情、北京时间重置时间 |
| 日志与健康 | 按账号、模型、状态和时间筛选，查看失败阶段、模型冷却，导出和清理日志 |
| 网页设置 | 模型列表、调度策略、重试数量、Antigravity 流式汇总开关，保存后生效 |

管理台支持桌面和手机。统计明细、模型额度和账号列表均有分页，无需一次浏览几十行。

## 一键部署到 Cloudflare

准备一个 **Cloudflare 账号**和一个 **GitHub 账号**，点击按钮：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/318182456/gcli2api-workers)

1. 登录 Cloudflare，按页面提示授权访问 GitHub，并创建你自己的代码仓库。
2. 选择 Worker 名称，确认 D1 数据库配置，保留数据库绑定名 **`DB`**。
3. 填写两个不同的长随机密码：`API_PASSWORD` 用于客户端调用，`PANEL_PASSWORD` 用于管理台登录。不要留空。
4. 确认部署命令为 **`npm run deploy`**，构建命令可留空。本项目无需单独构建前端。
5. 点击部署。完成后打开 Worker 的访问地址，使用 `PANEL_PASSWORD` 登录，进入“导入凭证”添加账号。

Cloudflare 会读取仓库的 Wrangler 配置，为新项目创建 D1 并回写数据库 ID；`npm run deploy` 会先应用数据库迁移，再发布 Worker。按钮流程和资源创建方式见 [Cloudflare 官方部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

**部署完成不代表已接入 Google 账号。** 还需要导入可用凭证，或配置对应渠道的 OAuth 客户端后使用网页授权。

### 部署后补充 Secrets

进入 **Cloudflare → Workers 和 Pages → 你的 Worker → 设置 → 变量和机密**，可以添加或修改 Secrets。密码和 OAuth 客户端信息均建议使用 **Secret（机密）** 类型。

| Secret | 用途 | 何时需要 |
| --- | --- | --- |
| `API_PASSWORD` | 客户端 API Key | 必填 |
| `PANEL_PASSWORD` | 管理台登录密码 | 必填，与 API 密码不同 |
| `GEMINICLI_CLIENT_ID` | GeminiCLI OAuth 客户端 ID | 使用该渠道网页授权，或凭证缺少客户端信息时 |
| `GEMINICLI_CLIENT_SECRET` | GeminiCLI OAuth 客户端密钥 | 与上项配套 |
| `ANTIGRAVITY_CLIENT_ID` | Antigravity OAuth 客户端 ID | 使用该渠道网页授权，或凭证缺少客户端信息时 |
| `ANTIGRAVITY_CLIENT_SECRET` | Antigravity OAuth 客户端密钥 | 与上项配套 |

OAuth 客户端必须与渠道和刷新令牌匹配。源码不提供客户端 ID、客户端密钥或默认密码。只使用一个渠道时，只需配置对应的一对 OAuth 值。

导入的 JSON 如果已经包含 `client_id` 和 `client_secret`，会优先使用凭证自带的值；此时可不配置该渠道的 OAuth Secrets。部署页面默认提示填写两个访问密码，OAuth 配置可在部署后按需添加。

## 添加 Google 账号

### 方式一：导入 JSON 凭证

在管理台进入 **导入凭证**，选择 GeminiCLI 或 Antigravity，上传 JSON 或粘贴内容。例如：

```json
{
  "project_id": "your-google-project-id",
  "refresh_token": "your-refresh-token",
  "client_id": "your-oauth-client-id",
  "client_secret": "your-oauth-client-secret"
}
```

- 如果已经配置该渠道的 OAuth Secrets，可省略 `client_id` 和 `client_secret`。
- 也接受 `token` / `access_token` 和 `expiry`。仅有访问令牌、没有 `refresh_token` 时，到期后需要重新导入。
- 支持多文件导入和本项目导出的 JSON 备份；不支持直接上传 SQLite 数据库或 ZIP。
- 同渠道、同名称的导入会更新凭证内容；未指定启停与调度参数时保留已有设置。
- 凭证渠道必须与客户端调用路径一致。检测到已配置客户端与渠道冲突时，导入会提示纠正。

### 方式二：网页 Google 授权

1. 先配置所用渠道的 OAuth 客户端 Secrets。
2. 进入 **Google 授权**，选择渠道，生成并打开授权链接。
3. 完成 Google 授权后，浏览器会跳转到 `http://localhost:11451/?code=…&state=…`。页面无法打开时，复制地址栏中的完整 URL 即可。
4. 回到管理台粘贴该 URL，点击“交换令牌并保存凭证”。

授权链接有效期为 10 分钟，仅使用一次。Worker 不会在你的电脑上启动回调服务器。Google 账号、客户端和作用域是否获准，取决于 Google 实际返回结果。

令牌保存后会尝试获取邮箱和校验项目；这些查询失败不会丢失已保存的令牌。如缺少项目 ID，请先在凭证管理中补充或校验项目。

## 接入客户端

下面用 `https://your-worker.example.com` 代表你的 Worker 域名，**API Key 一律填写 `API_PASSWORD`**。

| 接口 | GeminiCLI | Antigravity |
| --- | --- | --- |
| OpenAI Base URL | `https://your-worker.example.com/v1` | `https://your-worker.example.com/antigravity/v1` |
| Chat Completions | `/v1/chat/completions` | `/antigravity/v1/chat/completions` |
| Anthropic Messages | `/v1/messages` | `/antigravity/v1/messages` |
| Anthropic Token 计数 | `/v1/messages/count_tokens` | `/antigravity/v1/messages/count_tokens` |
| Gemini 生成 | `/v1beta/models/{model}:generateContent` | `/antigravity/v1beta/models/{model}:generateContent` |
| Gemini 流式生成 | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | `/antigravity/v1beta/models/{model}:streamGenerateContent?alt=sse` |
| OpenAI 格式模型列表 | `/v1/models` | `/antigravity/v1/models` |
| Gemini 格式模型列表 | `/v1beta/models` | `/antigravity/v1beta/models` |

若客户端会自动追加 `/v1`，请分别填根域名或 `/antigravity`，避免重复拼接路径。Anthropic 客户端按其要求填写根地址或 `/antigravity`，最终请求路径应与上表一致。

### OpenAI 兼容调用示例

```bash
curl https://your-worker.example.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

Antigravity 调用将路径替换为 `/antigravity/v1/chat/completions`，并填写该账号实际可用的模型。`stream: true` 启用 SSE；OpenAI 请求可用 `stream_options: {"include_usage": true}` 获取末尾用量块。

Gemini 原生接口支持 `x-goog-api-key`、Bearer 和 `?key=`；建议使用请求头。Anthropic 客户端也可使用 `x-api-key`。

## 管理控制台

| 页面 | 地址 | 主要内容 |
| --- | --- | --- |
| 概览 | `/panel/overview` | 请求与用量卡片、每日趋势、模型和账号排行、分页统计明细 |
| 凭证管理 | `/panel/credentials` | 搜索、启停、优先级和权重、健康详情、批量操作与查重 |
| 额度总览 | `/panel/quota` | 模型额度卡片、搜索筛选、最低额度排序、账号详情 |
| 调用日志 | `/panel/logs` | 筛选、分页、JSON 导出、清理匹配事件 |
| 导入凭证 | `/panel/import` | 单个和多个 JSON、备份恢复 |
| Google 授权 | `/panel/oauth` | 生成授权链接、回填 URL、保存凭证 |
| 模型列表 | `/panel/models` | 查询模型 ID，查看实时或备用来源 |
| 系统设置 | `/panel/settings` | 调度、重试数量、模型列表、流式汇总 |
| 接口接入 | `/panel/api` | 查看并复制客户端地址 |

登录会话保留 7 天，使用 HttpOnly Cookie；退出、修改管理密码或切换域名后需要重新登录。管理接口也支持 `Authorization: Bearer <PANEL_PASSWORD>`，与客户端 API 密码独立。

### 统计和额度口径

- **请求统计**按一次客户端生成请求的最终结果记录，内部重试不重复计数；额度查询、模型发现和管理页测试调用不计入该统计。
- **Token**仅采用上游实际报告值，缺失显示“未报告”，不会用本地估算补齐。账号消耗排行仅比较已报告的总 Token。
- **统计保留**最近 30 天且最多 10000 次请求；默认展示最近 7 天，日期按北京时间分组。模型和账号分组最多各 200 项。
- **额度**仅支持 Antigravity，手动逐账号查询，可停止后续查询；不会发起聊天，也不会后台定时轮询。
- **平均与最低额度**仅计算成功返回数值的账号。失败、未查询、未返回该模型和未知比例不计入均值，未知不等于零；比例不能相加为余额或换算成调用次数。
- **调用日志**最多保留最近 2000 条事件，事件数与最终请求数不同。清理日志不会删除用量统计和健康摘要。

## 配置说明

普通变量在 `wrangler.jsonc` 的 `vars` 或 Cloudflare 控制台中配置；密码与 OAuth 信息使用上面的 Secrets。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEMINICLI_MODELS` | `gemini-2.5-flash,gemini-2.5-pro` | GeminiCLI 对外模型列表，英文逗号分隔 |
| `ANTIGRAVITY_MODELS` | `gemini-2.5-flash,gemini-2.5-pro` | Antigravity 动态模型查询失败时的备用列表 |
| `MAX_CREDENTIAL_ATTEMPTS` | `3` | 一次生成请求最多尝试的凭证数，范围 1–5 |
| `CREDENTIAL_SELECTION` | `round_robin` | `round_robin` 轮询、`priority` 优先级或 `weighted` 权重随机 |
| `ANTIGRAVITY_STREAM2NOSTREAM` | `false` | 将 Antigravity 上游 SSE 汇总为普通 JSON 响应 |

上述五项可在管理台 **系统设置** 保存，D1 中的网页设置优先于环境变量；恢复默认后重新使用环境配置。

Antigravity 模型列表优先实时查询 Google，失败时才使用备用列表；GeminiCLI 使用配置列表。模型被列出不代表账号一定有权限或剩余额度。

## 手动部署

需要 Node.js 20 或更新版本。先克隆代码并登录：

```bash
git clone https://github.com/318182456/gcli2api-workers.git
cd gcli2api-workers
npm ci
npx wrangler login
npx wrangler d1 create gcli2api
```

将新数据库的 ID 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id`，数据库名称填入 `database_name`，**保留 `binding: "DB"`**。手动部署必须替换仓库中的数据库配置，不能直接使用其他账号的数据库 ID。

```bash
npx wrangler secret put API_PASSWORD
npx wrangler secret put PANEL_PASSWORD
npm run deploy
```

命令会交互式要求输入密码；首次写入 Secret 如提示创建 Worker，按提示确认。需要网页授权时，再用 `npx wrangler secret put <变量名>` 添加对应 OAuth Secrets。

`npm run deploy` 自动执行 `npm run db:remote` 后发布。已有数据库只应用尚未执行的迁移，不需要清库或重新导入账号。

### 更新已有部署

```bash
git pull --ff-only
npm ci
npm run deploy
```

更新前保留自己账号的 Worker 名称与 D1 配置。通过部署按钮生成的仓库是你自己的副本，不会自动接收本仓库的更新；同步代码时不要覆盖数据库 ID 或删除已有 Secrets。

若使用 Workers Builds 持续部署，部署命令保持 `npm run deploy`。更新后刷新管理台，当前界面版本为 **v0.14.0**。

## v0.14.0：减少 D1 读写与日志保留期限

`npm run deploy` 会先自动应用 `0006_d1_budget.sql`，为用量表增加日志可见性标记，再部署 Worker 和每小时的清理任务。迁移不清空凭证或统计，不需要重新导入账号。

- 成功请求只保存一份最终用量记录，日志列表直接复用它，不再额外插入 200 响应头与 completed 事件。失败、重试、断流仍记录诊断事件。日志清理仅隐藏对应的用量日志展示，统计数据保留。
- 健康摘要正常成功时最多每账号每分钟更新一次；失败后首次成功仍立即恢复。管理页通过最新成功用量记录计算准确的最后成功时间。
- 同一 Worker 实例内维护最近选择时间，轮询的 D1 时间快照最多每账号每分钟更新一次。每次选择仍从 D1 检查启停状态和当前模型冷却，不缓存令牌或授权判断；多实例/冷启动下仍是尽力轮询，不提供全局严格顺序。
- 网页配置读取缓存 30 秒，同实例保存后立即刷新；其他实例最多 30 秒生效。重复保存相同配置不会再次写入相同行。
- 统计从四次聚合扫描改为一次聚合，再生成概览、日期、模型和账号汇总；自动加载可复用 30 秒缓存，点击“刷新统计”强制更新。缓存按数据库隔离并限制大小。
- 清理从每次请求触发改为每新增 128 条记录批量执行，并增加每小时 Cron。保留区约 10000 条用量、约 2000 条诊断事件，批次之间最多短暂多出 127 条。删除过期数据本身仍计入 D1 写入，不通过采样或丢失实际用量来省额度。

**日志保留 7 天。** 查询和导出立即排除超过 7 天的日志，每小时定时任务物理删除过期的独立诊断/历史事件，空闲时也会清理。成功日志由用量记录动态生成，超过 7 天不再作为日志展示；用量记录仍用于最近 30 天统计，按原规则清理。两种保留期限分别生效。使用旧版本日志分页游标的客户端需要重新加载第一页。

Cron 表达式为 `0 * * * *`。如果用自己的部署配置，需要保留 triggers 配置以保证空闲期间也会清理。通过 Workers Builds 部署时，部署命令继续使用 `npm run deploy`。

本地测试使用独立 Miniflare D1、模拟 Google 响应和已填满的保留区，测量 128 次连续成功请求的 D1 `rows_read`/`rows_written`，并在 `test/db-budget.test.js` 设置成本回归预算。该场景的测量结果如下（均为 128 次请求合计）：

| D1 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| SQL 执行数 | 1280 | 388 |
| 读取行数 | 3072 | 870 |
| 写入行数 | 2432 | 752 |

线上节省比例取决于账号数、失败重试与 Worker 实例复用；索引维护与删除产生的写入仍按 [D1 计费规则](https://developers.cloudflare.com/d1/platform/pricing/) 计量。

## 本地开发

```bash
npm ci
```

复制 `.dev.vars.example` 为 `.dev.vars`，填写两个不同的密码；需要 OAuth 时取消对应变量的注释并填写。`.dev.vars` 已被 Git 忽略，不会自动同步到 Cloudflare。

仓库配置的 D1 绑定含 `remote: true`。要使用独立的本地数据库进行开发，先在本地配置中移除这一项或改为 `false`，避免连接线上数据，再运行：

```bash
npm run db:local
npm run dev
```

访问 `http://localhost:8787`。本地 Google 请求从本机发出，不代表 Cloudflare 的实际出口地区。

```bash
npm test
npm run check
```

测试包含实际 Workers 运行时、本地 D1 和管理页交互，Google 响应使用模拟数据；`npm run check` 只打包检查，不发布或迁移数据库。

## 常见问题

### 503：未配置密码、缺少 OAuth 配置或没有可用凭证

按错误提示检查 Secrets、凭证渠道和启用状态。GeminiCLI 对应 `/v1`，Antigravity 对应 `/antigravity/v1`。客户端填 `API_PASSWORD`，管理台填 `PANEL_PASSWORD`。

### 数据库表或字段不存在

确认 D1 绑定名为 `DB`，并执行 `npm run db:remote`。若通过部署按钮创建，检查部署命令是否为 `npm run deploy`；不要跳过迁移只执行 `wrangler deploy`。

### Google 返回 403、429 或连接失败

403 可能与账号、项目权限或地区有关；429 表示上游限流。Cloudflare 不提供固定国家出口，本项目也不保证绕过 Google 地区限制。

错误中的 `stage` 和 `request_id` 可帮助定位：`oauth_refresh` 是令牌刷新，`generation_fetch` 是聊天连接，`quota_fetch` 是额度查询。网络错误通常返回 502，超时返回 504；数据库迁移无法解决 Google 网络问题。

### 找不到额度按钮，或额度显示未知

“查看额度”只出现在 Antigravity 凭证中。先确认渠道；未知表示上游未报告数据，不能当作 0%。查询失败的账号会在额度总览下方优先显示。

### 域名无法访问

在 Worker 的“设置 → 域和路由”检查 `workers.dev` 地址或绑定自己的域名。`/health` 可用于健康检查；如果入口返回 Cloudflare 错误页，结合 Worker 实时日志排查，不要直接重建数据库。

## 限制与数据说明

- 不支持 OpenAI Responses API、ZIP 凭证导入、自动 localhost 回调服务器、后台保活和日志 WebSocket。
- 支持文本、base64 图片输入与工具调用；Gemini 原生图片输出透传，OpenAI 图片输出不支持。Token 计数接口是本地估算。
- 单次入站 JSON 限制为 4 MiB。大图片、长上下文和流式编码可能触及 Workers 资源限制。
- 凭证和刷新令牌保存在 D1，拥有数据库权限的人可以读取。备份与下载文件也包含敏感凭证，请勿提交到 GitHub。
- 免费套餐是否够用取决于实际负载；统计和日志会增加 D1 读写。当前配额以 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 和 [D1 计费](https://developers.cloudflare.com/d1/platform/pricing/) 为准。

## 来源与许可

本项目参考 [su-kaka/gcli2api](https://github.com/su-kaka/gcli2api) 的 GeminiCLI / Antigravity 协议和凭证字段，使用原生 JavaScript 在 Workers 上重新实现。

沿用 **Cooperative Non-Commercial License（CNC-1.0）**，仅允许非商业使用；具体条件见 [LICENSE](LICENSE)。Copyright (c) 2024 gcli2api contributors。
