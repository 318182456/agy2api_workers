# AGY2API Workers


无需 Python、Docker 或独立服务器。API 转换、账号调度、凭证存储和管理页面由同一个 Worker 提供。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/318182456/agy2api_workers)

[快速部署](#一键部署到-cloudflare) · [接入客户端](#接入客户端) · [配置说明](#配置说明) · [常见问题](#常见问题)

## 功能

| 模块        | 支持内容                                                                              |
| ----------- | ------------------------------------------------------------------------------------- |
| API 兼容    | OpenAI Chat Completions、Anthropic Messages、Gemini 原生接口，普通响应与 SSE 流式输出 |
| 凭证管理    | JSON 导入、多文件导入、备份恢复、启停、重命名、邮箱查重、下载                         |
| Google 授权 | 授权链接、PKCE、一次性 state、手动回填回调 URL                                        |
| 账号调度    | 轮询、优先级、权重随机；按模型冷却，失败时有限切换凭证                                |
| 用量统计    | 请求数、成功率、Token、耗时、每日趋势、热门模型与账号消耗排行                         |
| 额度总览    | Gemini / Claude 额度分组、进度条、低额度筛选、账号详情、北京时间重置时间              |
| 日志与健康  | 按账号、模型、状态和时间筛选，查看失败阶段、模型冷却，导出和清理日志                  |
| 网页设置    | 模型列表、调度策略、重试数量、Antigravity 流式汇总开关，保存后生效                    |

管理台支持桌面和手机。统计明细、模型额度和账号列表均有分页，无需一次浏览几十行。

## 一键部署到 Cloudflare

准备一个 **Cloudflare 账号**和一个 **GitHub 账号**，点击按钮：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/318182456/agy2api_workers)

1. 登录 Cloudflare，按页面提示授权访问 GitHub，并创建你自己的代码仓库。
2. 选择 Worker 名称，确认 D1 数据库配置，保留数据库绑定名 **`DB`**。
3. 填写两个不同的长随机密码：`API_PASSWORD` 用于客户端调用，`PANEL_PASSWORD` 用于管理台登录。不要留空。
4. 确认部署命令为 **`npm run deploy`**，构建命令可留空。本项目无需单独构建前端。
5. 点击部署。完成后打开 Worker 的访问地址，使用 `PANEL_PASSWORD` 登录，进入“导入凭证”添加账号。

Cloudflare 会读取仓库的 Wrangler 配置，为新项目创建 D1 并回写数据库 ID；`npm run deploy` 会先准备 KV、应用 D1 数据库迁移，再发布 Worker 和 SQLite Durable Object。按钮流程和资源创建方式见 [Cloudflare 官方部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

**部署完成不代表已接入 Google 账号。** 还需要导入可用凭证，或使用管理页 Google 授权获取账号凭证。两个渠道的 OAuth 客户端已沿用原项目预置在 vars 中。

### 密码与 OAuth 客户端

部署时只需设置两个不同的长随机密码，使用 **Secret（机密）** 类型：

| Secret           | 用途                                   |
| ---------------- | -------------------------------------- |
| `API_PASSWORD`   | 兼容总密钥，可逐步改用管理页的独立密钥 |
| `PANEL_PASSWORD` | 管理台登录密码，与 API 密码不同        |

四项 OAuth 客户端配置已直接写入 `wrangler.jsonc` 的 `vars`，与原 Python 项目 `src/utils.py` 使用的值一致，无需部署时重复填写：

| Worker 变量                 | 原项目常量                  |
| --------------------------- | --------------------------- |
| `ANTIGRAVITY_CLIENT_ID`     | `ANTIGRAVITY_CLIENT_ID`     |
| `ANTIGRAVITY_CLIENT_SECRET` | `ANTIGRAVITY_CLIENT_SECRET` |

使用自己的 OAuth 客户端时，按渠道成对替换 ID 和 Secret，必须与刷新令牌匹配。导入 JSON 自带的 `client_id` / `client_secret` 优先于部署变量。账号访问令牌、刷新令牌仍通过凭证导入或网页授权获得，不属于这些固定的客户端配置。

## 添加 Google 账号

### 方式一：导入 JSON 凭证


```json
{
  "project_id": "your-google-project-id",
  "refresh_token": "your-refresh-token",
  "client_id": "your-oauth-client-id",
  "client_secret": "your-oauth-client-secret"
}
```

- 使用 vars 中预置的渠道客户端时，可省略 `client_id` 和 `client_secret`；已有刷新令牌若来自其他客户端，须保留与其匹配的客户端信息。
- 也接受 `token` / `access_token` 和 `expiry`。仅有访问令牌、没有 `refresh_token` 时，到期后需要重新导入。
- 支持多文件导入和本项目导出的 JSON 备份；不支持直接上传 SQLite 数据库或 ZIP。
- 同渠道、同名称的导入会更新凭证内容；未指定启停与调度参数时保留已有设置。
- 凭证渠道必须与客户端调用路径一致。检测到已配置客户端与渠道冲突时，导入会提示纠正。

### 方式二：网页 Google 授权

1. 默认使用 vars 中预置的渠道客户端；使用自定义客户端时先修改对应的一对配置。
2. 进入 **Google 授权**，选择渠道，生成并打开授权链接。
3. 完成 Google 授权后，浏览器会跳转到 `http://localhost:11451/?code=…&state=…`。页面无法打开时，复制地址栏中的完整 URL 即可。
4. 回到管理台粘贴该 URL，点击“交换令牌并保存凭证”。

授权链接有效期为 10 分钟，仅使用一次。Worker 不会在你的电脑上启动回调服务器。Google 账号、客户端和作用域是否获准，取决于 Google 实际返回结果。

令牌保存后会尝试获取邮箱和校验项目；这些查询失败不会丢失已保存的令牌。如缺少项目 ID，请先在凭证管理中补充或校验项目。

## 接入客户端

下面用 `https://your-worker.example.com` 代表你的 Worker 域名，**API Key 可填写管理页创建/导入的独立密钥，或兼容总密钥 `API_PASSWORD`**。

| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| OpenAI Base URL      | `https://your-worker.example.com/v1`                   | `https://your-worker.example.com/antigravity/v1`                   |
| Chat Completions     | `/v1/chat/completions`                                 | `/antigravity/v1/chat/completions`                                 |
| Anthropic Messages   | `/v1/messages`                                         | `/antigravity/v1/messages`                                         |
| Anthropic Token 计数 | `/v1/messages/count_tokens`                            | `/antigravity/v1/messages/count_tokens`                            |
| Gemini 生成          | `/v1beta/models/{model}:generateContent`               | `/antigravity/v1beta/models/{model}:generateContent`               |
| Gemini 流式生成      | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | `/antigravity/v1beta/models/{model}:streamGenerateContent?alt=sse` |
| OpenAI 格式模型列表  | `/v1/models`                                           | `/antigravity/v1/models`                                           |
| Gemini 格式模型列表  | `/v1beta/models`                                       | `/antigravity/v1beta/models`                                       |

若客户端会自动追加 `/v1`，请分别填根域名或 `/antigravity`，避免重复拼接路径。Anthropic 客户端按其要求填写根地址或 `/antigravity`，最终请求路径应与上表一致。

### OpenAI 兼容调用示例

```bash
curl https://your-worker.example.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"你好"}],"stream":false}'
```



Gemini 原生接口支持 `x-goog-api-key`、Bearer 和 `?key=`；建议使用请求头。Anthropic 客户端也可使用 `x-api-key`。

## 管理控制台

| 页面     | 地址                 | 主要内容                                                        |
| -------- | -------------------- | --------------------------------------------------------------- |
| 概览     | `/panel/overview`    | 请求与用量、趋势、排行；点击指标直达详情或筛选账号              |
| 凭证管理 | `/panel/credentials` | 账号列表、额度总览、文件导入、Google 授权四个页签               |
| API 密钥 | `/panel/keys`        | 创建、导入、查看/复制、改名、启停、删除、可选到期时间与独立用量 |
| 问题一览 | `/panel/logs`        | 失败、取消、重试及恢复事件；筛选、导出和清理                    |
| 系统设置 | `/panel/settings`    | 运行参数、模型列表、接口接入三个页签                            |

侧栏只保留以上 5 个入口，使用紧凑卡片、表格和工具栏。原 `/panel/import`、`/panel/oauth`、`/panel/quota`、`/panel/models`、`/panel/api` 链接仍可直接打开对应页签。

登录会话保留 7 天，使用 HttpOnly Cookie；退出、修改管理密码或切换域名后需要重新登录。管理接口也支持 `Authorization: Bearer <PANEL_PASSWORD>`，与客户端 API 密码独立。

### API 密钥管理

升级后执行 `npm run db:remote` 应用 `0009_api_keys.sql`。原 `API_PASSWORD` 继续作为兼容总密钥使用；独立密钥通过 D1 校验，停用、到期、删除会拒绝后续请求，不中断已经开始的生成。所有现有 OpenAI、Anthropic、Gemini 接口都支持独立密钥；密钥不能用于管理接口。

在 **API 密钥** 页为每个项目创建独立密钥，密钥默认永久有效，到期时间可留空；服务在 D1 保存完整密钥及用于鉴权的 SHA-256 摘要，管理员可在列表中重新查看、复制或隐藏密钥。支持导入完整密钥文本（每行一个）和 JSON，单次最多 200 个；重复项跳过，不覆盖名称、到期时间或停用状态。示例 JSON：

```json
[{ "name": "MoviePilot", "key": "sk-your-existing-full-key" }]
```

迁移 New API 时选择 **New API** 格式：支持令牌对象数组、`data` 数组、`data.items` 和单个令牌对象；读取 `key`、`name`、`status`、`expired_time`，没有 `sk-` 前缀时自动补全。列表 API 返回的脱敏密钥不能导入，需要获取完整令牌。`status=1` 启用，其他状态停用；`expired_time=-1` 永不过期，其余为 Unix 秒时间戳。字段依据 [New API 令牌模型](https://github.com/QuantumNous/new-api/blob/main/model/token.go)。

原密钥值可继续使用，客户端 Base URL 仍须指向本服务。导入不会连接 New API，也不会继承其余额、计费、分组、模型权限、IP 限制或历史用量。独立密钥共享本服务的凭证池和模型权限。

每个密钥可查看最近 24 小时、7 天、30 天的请求、成功/失败/取消、Token、模型与日期统计。统计沿用 DO 持久聚合，不逐请求更新密钥表或写 KV；聚合桶按密钥区分，包含尚未落盘的数据。升级前的记录保持未归属，不推测历史密钥；删除密钥仍保留全局统计，通过原 ID 的 `/admin/stats?api_key_id=...` 可查询保留期内的历史用量。

### 统计和额度口径

- **请求统计**按一次客户端生成请求的最终结果记录，内部重试不重复计数；额度查询、模型发现和管理页测试调用不计入该统计。
- **Token**仅采用上游实际报告值，缺失显示“未报告”，不会用本地估算补齐。账号消耗排行仅比较已报告的总 Token。
- **统计保留**：聚合模式保留最近 30 天完整汇总，明细模式保留最近 30 天且最多约 10000 次请求；默认展示最近 7 天，日期按北京时间分组。模型和账号分组最多各 200 项。
- **平均与最低额度**仅计算成功返回数值的账号。失败、未查询、未返回该模型和未知比例不计入均值，未知不等于零；比例不能相加为余额或换算成调用次数。
- **问题一览**保留 7 天，最多展示最近约 2000 次异常请求及旧版独立事件；聚合模式只保存失败、取消和重试明细，正常成功请求只计入汇总。清理日志不会删除用量统计和健康摘要。

## 配置说明

普通变量在 `wrangler.jsonc` 的 `vars` 或 Cloudflare 控制台中配置；API 与管理密码使用上面的 Secrets；OAuth 客户端已在 vars 中提供默认值。

| 变量                          | 默认值        | 说明                                                                           |
| ----------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `MAX_CREDENTIAL_ATTEMPTS`     | `3`           | 一次生成请求最多尝试的凭证数，范围 1–5                                         |
| `CREDENTIAL_SELECTION`        | `round_robin` | `round_robin` 轮询、`priority` 优先级或 `weighted` 权重随机                    |
| `UPSTREAM_TIMEOUT_SECONDS`    | `45`          | 单次生成请求等待上游响应头的秒数，5–90；超时可在重试预算内切换凭证             |
| `REQUEST_TIMEOUT_SECONDS`     | `100`         | 普通请求包含重试与正文读取的总等待秒数，10–110；流式请求仅限制开始输出前的等待 |
| `ANTIGRAVITY_STREAM2NOSTREAM` | `true`        | 将 Antigravity 上游 SSE 汇总为普通 JSON 响应                                   |
| `USAGE_STORAGE_MODE`          | `aggregate`   | `aggregate` 持久聚合；`detailed` 逐请求写 D1；缺少 TELEMETRY 时回退明细模式    |

上述配置可在管理台 **系统设置** 保存，D1 中的网页设置优先于环境变量；恢复默认后重新使用环境配置。


## 手动部署

需要 Node.js 20 或更新版本。先克隆代码并登录：

```bash
git clone https://github.com/318182456/agy2api_workers.git
cd agy2api_workers
npm ci
npx wrangler login
npx wrangler d1 create agy2api_workers
```

将新数据库的 ID 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id`，数据库名称填入 `database_name`，**保留 `binding: "DB"`**。手动部署必须替换仓库中的数据库配置，不能直接使用其他账号的数据库 ID。

```bash
npx wrangler secret put API_PASSWORD
npx wrangler secret put PANEL_PASSWORD
npm run deploy
```

命令会交互式要求输入密码；首次写入 Secret 如提示创建 Worker，按提示确认。网页授权默认使用 vars 中预置的客户端，无需再添加 OAuth Secrets。

`npm run deploy` 先准备名为 `agy2api_workers` 的 KV（已有 `CACHE.id` 时直接复用，不会改名），再自动执行 `npm run db:remote` 后发布。已有数据库只应用尚未执行的迁移，不需要清库或重新导入账号。

### 更新已有部署

```bash
git pull --ff-only
npm ci
npm run deploy
```

更新前保留自己账号的 Worker 名称与 D1 配置。通过部署按钮生成的仓库是你自己的副本，不会自动接收本仓库的更新；同步代码时不要覆盖数据库 ID 或删除已有 Secrets。

若使用 Workers Builds 持续部署，部署命令保持 `npm run deploy`。更新后刷新管理台，当前界面版本为 **v0.22.0**。

## 存储与写入控制

默认使用聚合模式，升级会应用 `0007_packed_diagnostics.sql` 和 `0008_usage_aggregates.sql`，不清空凭证或历史统计。

| 资源                  | 控制台名称 / 绑定                                     | 保存内容与写入时机                                                |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| D1                    | `gcli2api` / `DB`                                     | 凭证、配置、错误明细、每 5 分钟的用量汇总                         |
| KV                    | `agy2api_workers` / `CACHE`                                  | 非敏感配置和模型 ID；设置保存、手动模型刷新、每小时配置预热才写入 |
| SQLite Durable Object | Cloudflare 按 Worker 和类名生成命名空间 / `TELEMETRY` | 每次请求先持久累加，Alarm 约每 5 分钟批量写 D1                    |

`npm run deploy` 的准备脚本会查找名为 `agy2api_workers` 的 KV，没有时创建，并将 ID 写回 `wrangler.jsonc` 的 `CACHE` 绑定。已配置 ID 的资源不会重建或改名。D1 和 KV 属于不同资源类型，可以同名；Durable Object 的命名空间由 Cloudflare 管理，内部对象名使用 `gcli2api`。

- **正常成功请求**不插入 `request_usage` 或 `call_logs`，按 5 分钟、账号、渠道、模型、状态与最终结果汇总；保存上游报告的 Token、请求数和总耗时。未报告的 Token 保持为空。
- **失败、取消与重试**仍保留 D1 明细，单次请求的重试诊断合并保存为 JSON，不再每次重试单独写日志。日志清理不影响汇总。
- **统计页面**优先使用内存 / Cache API（1 分钟）和 KV 查询快照（最多 5 分钟），聚合模式未命中时从 DO 查询。DO 首次加载最近 30 天 D1 历史，此后每小时按需同步；历史保存为压缩快照，在内存筛选汇总，不逐行建立第二套索引库。新请求持续计入持久聚合桶。“刷新统计”跳过查询缓存；“同步 D1 历史”才强制扫描历史；“立即落盘汇总”提前处理一批缓冲。D1 降级写入、明细模式写入和外部改动在下一次同步后可见。
- **故障处理**：缓冲在实例重启后仍保留。重复上报按请求 ID 去重；D1 使用版本号覆盖累计值，重复落盘不重复计数。D1 不可用时保留缓冲并重试；DO 不可用时回退 D1 明细。两种存储均不可写时只能记录 Worker 诊断，无法保证用量持久化。
- **保留范围**：D1 汇总 30 天；明细最多约 10000 条；日志查询只显示 7 天内事件；每小时 Cron 物理删除已有汇总的过期诊断明细，并移除历史用量行内过期的重试 JSON，保留统计数值。DO 已落盘缓冲保留约 24 小时供短期去重。无明细数据的成功请求无法按请求 ID 查询或导出逐次记录。
- **健康与轮询**：成功健康摘要和轮询时间快照按 5 分钟节流，同类失败摘要按分钟合并；界面最近成功时间同时参考用量记录与持久缓冲。凭证启停、冷却和令牌仍从 D1 校验，不缓存授权判断。
- **KV**：普通 API 请求只读共享缓存，不逐请求写 KV。新实例可复用配置和模型 ID；缓存失败回退原查询路径。KV 最终一致，跨实例设置更新可能短暂延迟；同实例保存立即刷新本地设置。

本地真实 Workers / D1 / SQLite DO 测试中，同一时间桶、账号和模型的 **128 次成功请求生成 1 条 D1 汇总，0 条请求明细和独立日志**；落盘 D1 写入行数设有少于 12 行的回归预算（包含索引及健康摘要）。这不包含账号选择等其他 SQL，也不代表线上所有场景有相同比例。

SQLite Durable Object 可用于 Workers Free，但仍有独立的每日请求、读写与运行时额度；持久累加会消耗 DO 写入额度，并非取消存储成本。当前免费 DO 请求和写入行数均为每天 100000，KV 写入为每天 1000。详见 [DO 定价与免费额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[KV 额度](https://developers.cloudflare.com/kv/platform/pricing/) 和 [D1 计量规则](https://developers.cloudflare.com/d1/platform/pricing/)。

## 本地开发

```bash
npm ci
```

复制 `.dev.vars.example` 为 `.dev.vars`，填写两个不同的密码；OAuth 默认读取 vars，使用自定义客户端时才取消对应变量的注释并填写。`.dev.vars` 已被 Git 忽略，不会自动同步到 Cloudflare。

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

测试包含实际 Workers 运行时、本地 D1、SQLite Durable Object 持久化、并发落盘、故障重试和管理页交互，Google 响应使用模拟数据；`npm run check` 只打包检查，不发布或迁移数据库。

## 常见问题

### 503：未配置密码、缺少 OAuth 配置或没有可用凭证


### 数据库表或字段不存在

确认 D1 绑定名为 `DB`，并执行 `npm run db:remote`。若通过部署按钮创建，检查部署命令是否为 `npm run deploy`；不要跳过迁移只执行 `wrangler deploy`。

### Google 返回 403、429 或连接失败

403 可能与账号、项目权限或地区有关；429 表示上游限流。Cloudflare 不提供固定国家出口，本项目也不保证绕过 Google 地区限制。 `wrangler.jsonc` 的 `placement.region` 配置 Worker 的执行目标；`aws:us-east-1` 表示靠近美国东部，`aws:ap-northeast-1` 表示靠近日本东京，部署后生效。这是执行位置提示，不是固定国家或固定出口 IP，不能保证 Google 接受。若需改为靠近日本东京，可替换为 `aws:ap-northeast-1`。具体调度以 Cloudflare 为准，不能用客户端入口的 `CF-Ray` 位置直接判断 Google 看到的出口；配置说明见 [Cloudflare Placement 文档](https://developers.cloudflare.com/workers/configuration/placement/)。

错误中的 `stage` 和 `request_id` 可帮助定位：`oauth_refresh` 是令牌刷新，`generation_fetch` 是聊天连接，`quota_fetch` 是额度查询。网络错误通常返回 502，超时返回 504；数据库迁移无法解决 Google 网络问题。

### 找不到额度按钮，或额度显示未知


### 域名无法访问

在 Worker 的“设置 → 域和路由”检查 `workers.dev` 地址或绑定自己的域名。`/health` 可用于健康检查；如果入口返回 Cloudflare 错误页，结合 Worker 实时日志排查，不要直接重建数据库。

## 限制与数据说明

- 不支持 OpenAI Responses API、ZIP 凭证导入、自动 localhost 回调服务器、后台保活和日志 WebSocket。
- 支持文本、base64 图片输入与工具调用；Gemini 原生图片输出透传，OpenAI 图片输出不支持。Token 计数接口是本地估算。
- 单次入站 JSON 限制为 4 MiB。大图片、长上下文和流式编码可能触及 Workers 资源限制。
- 凭证和刷新令牌保存在 D1，拥有数据库权限的人可以读取。备份与下载文件也包含敏感凭证，请勿提交到 GitHub。
- 免费套餐是否够用取决于实际负载；统计和日志会增加 D1 读写。当前配额以 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 和 [D1 计费](https://developers.cloudflare.com/d1/platform/pricing/) 为准。

## 来源与许可


沿用 **Cooperative Non-Commercial License（CNC-1.0）**，仅允许非商业使用；具体条件见 [LICENSE](LICENSE)。Copyright (c) 2024 gcli2api contributors。

## 代码结构与维护

- `src/index.js`：Worker 唯一入口，保持 Wrangler 入口和 DO 导出不变。
- `src/routes/`：登录会话、管理接口和生成协议的 HTTP 路由。
- `src/auth/`：API 密钥和管理台会话鉴权。
- `src/credentials/`：Google 凭证、OAuth、账号校验、导入导出及去重。
- `src/models/`、`src/quota/`：模型发现与名称映射、Google 额度及共享额度分组。
- `src/protocols/`：OpenAI、Anthropic、Gemini 请求转换和工具兼容。
- `src/upstream/`：上游请求、统一渠道调度、超时重试、流式汇总及续写。
- `src/telemetry/`：请求记录、持久缓冲、历史统计、账号健康、日志保留和查询筛选；`index.js` 统一导出统计接口。
- `src/storage/`：跨账号 Pages / DO 节点创建、持久缓存、轮换与故障回退。
- `src/cache/`、`src/config/`：共享 KV、实例内元数据缓存与运行配置。
- `src/panel/`：管理页组装、样式、图表与图标；`pages/` 放页面 HTML，`scripts/` 放对应交互脚本。页面仍以同源单文件提供，无前端构建依赖。
- `src/core/`：公共响应与错误处理、地区探测、ZIP 工具；版本统一在 `version.js`。

新增模块放入对应业务目录；跨模块使用显式相对路径。`scripts/format-panel.mjs` 同时校验管理页字符串中的 JavaScript 格式，测试直接引用各业务模块。

修改代码后运行 `npm run format`、`npm test`、`npm run format:check` 和 `npm run check`。最后一项只打包，不创建资源、不迁移远程数据库、不发布。

### Gemini 图片参数兼容

原生 `generateContent` 接口兼容客户端的 `generationConfig.responseFormat.image`（包括对应 snake_case 字段）。其中的 `imageSize` 与 `aspectRatio` 在转发 Google 内部接口前转换为 `generationConfig.imageConfig`，保留 `responseModalities`。同时传入两种布局时，显式 `imageConfig` 优先；其余响应配置保持原样。Denova 的 Gemini Images 接入可继续使用现有请求格式。

### 单 Antigravity 模式

仅保留 Antigravity 凭证、Google 授权、项目校验、额度与模型发现。默认 `/v1`、`/v1beta` 和 `/v1/messages` 均使用 Antigravity，仍兼容 `/antigravity` 前缀。已有其他渠道的历史数据不删除，但不再导入、展示账号或参与调度。

Antigravity 的 Gemini 3 及后续模型与 agent 路由由原始模型 ID 决定思考档位；兼容客户端的 `reasoning_effort` 不会造成白名单拦截，也不会覆盖上游档位。冲突的 `thinkingLevel` / `thinkingBudget` 按参考项目移除。需要调整强度时选用动态目录中的对应型号。`gcli2api` 等内部 DO 实例名及已有迁移保持稳定，避免改名后读到空对象；资源显示名使用新项目名。

### 模型能力与快捷调用名

“系统设置 → 模型列表”按行显示用途、原始 ID 及可复制的调用名。联网搜索通过给模型名追加 `-search` 请求，例如 `gemini-2.5-pro-search`；搜索由模型按需执行，账号资格、渠道支持和容量仍以上游响应为准。发现的 Gemini 文本模型会自动生成搜索入口，保留 `-high`、`-low`、`-tiered` 等上游原有档位，不会改为不存在的基础 ID。

思考档位、图片尺寸及已有兼容别名由现有请求转换规则生成，默认折叠展示。不能关闭思考的模型会注明映射到最低等级。未知模型保留原始名称，未确认的快捷参数不作承诺；用途说明是参考，不代表账号能力实测。快捷调用名不作为新增上游模型混入 `/v1/models`。

### 自动模型名称与官网参考

模型清单来自账号实时接口，不依赖环境变量中的模型名称表。已有版本号的模型 ID 保留完整后缀；不含版本号的 Gemini 内部 ID，在上游 `displayName` 提供明确的英文型号及版本时，自动生成通用名称，并在请求 Google 时还原为渠道真实 ID。同一渠道存在命名冲突时保留原始 ID，不合并不同模型。未知或不明确的名称保持原样。


模型清单的 KV 缓存为 15 分钟，通用名称到渠道 ID 的映射缓存为 24 小时，冷启动可复用；正常生成请求不抓官网、不写模型缓存。没有配置 KV 时仅使用当前实例内存，跨实例的名称映射需要重新发现模型。

生成上游返回 524 或响应头等待超时，会按现有凭证尝试次数选择其他可用账号；普通请求另有总等待时限。已经接收成功响应后，不因正文中断重新生成。流式响应开始输出后清除总时限，允许正常长输出；服务端超时记录为 504/失败，不计为客户端取消。上游支持、账号资格或网络故障仍可能导致所有重试失败。

Antigravity 普通请求默认通过 `streamGenerateContent` 获取上游 SSE 并汇总为完整 JSON，与原 Python 项目的默认行为一致；客户端不需要改为流式解析。若管理页曾保存该开关为关闭，升级会尊重原设置，需要在“系统设置 → 运行参数”手动开启。上游流式汇总可以改善等待首包的路径，但汇总期间客户端仍需等待完整 JSON，不能保证消除所有网络超时。

流式汇总接受 SSE、完整 Gemini JSON 对象或分块 JSON 数组，均保留工具调用、签名和上游用量。完成标记不会被后续空元数据覆盖；单帧、单候选的纯文本响应在正常 EOF 且缺少完成标记时兼容原 Python 返回现有正文，并在响应头 `x-completion-status: unconfirmed`、`x-upstream-warning: UPSTREAM_FINISH_UNCONFIRMED` 和 JSON 的 `completion_status` / `warnings` 中标记“结束未确认”；内容可能不完整，不伪造 Google `finishReason`，不自动重试或续写。协议转换仍按原有结束原因默认值输出，不能将其当作 Google 确认完成；缓冲假流式会在数据事件中保留该标记。正常完成响应不加标记。工具调用、多帧缺结束标记、连接异常及其他非纯文本响应仍报告失败；此兼容仅用于 Antigravity 普通请求的流式汇总，不改变真正流式请求。Cloudflare 日志记录安全的未确认事件，不增加 D1 逐请求写入。问题一览会区分响应类型不符、无效 JSON、空流、中断及未完成流，并显示安全的汇总错误说明，不保存响应正文或聊天内容。响应已经成功开始后不会为格式错误重新发起生成请求。

不完整流返回 `UPSTREAM_STREAM_INCOMPLETE` 时，问题一览会显示帧数、候选数、已结束候选数、正文/思考字符数量、工具调用数量、用量报告状态与结束方式（EOF / DONE / JSON）。这些诊断不包含正文、工具参数或签名；缺少结束标记仍按失败记录，不自动补 STOP，也不在消耗响应后重发生成。失败流已报告的 Token 仍计入用量。

API 密钥列表在名称后直接展示最近 30 天的已报告总 Token 与请求数，包含 DO 待落盘数据；有请求但缺少 Token 报告时显示未知或部分未报告。当前页（最多 50 个独立密钥及总密钥）只批量查询一次，内存 / 边缘缓存 1 分钟、KV 快照最多 5 分钟，不逐个查询；用量获取失败不影响停用、删除等密钥管理。历史模型/日期明细仍可通过“用量明细”展开。

OpenAI 客户端若丢弃工具调用的 `extra_content.google.thought_signature`，Gemini 3 及以后模型的历史工具调用会仅在缺签名时补入 Google 官方兼容值 `skip_thought_signature_validator`，避免多轮工具调用因缺签名返回 400。真实签名始终原样保留；原生 Gemini 与其他模型家族保持原有处理；Anthropic Messages 接入 Gemini 3+ 时使用相同的缺签名兼容策略。兼容值不能恢复丢失的思考上下文，支持签名回传的客户端仍应完整保存扩展字段。参考 [Google thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)。

### 原 Python 功能的 Workers 迁移

原项目的主要兼容能力已按 Workers 的资源与计量方式接入；本地代理、进程保活、MongoDB/PostgreSQL 驱动与内置升级由可配置上游、Cron、D1/KV/DO 和 Git 部署替代。`Hi` 固定成功回复未引入，服务健康请用 `/health`，模型测试仍实际访问 Google。

| 能力              | 入口与行为                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具调用兼容      | 请求内为特殊/过长工具名建立可逆且防冲突的名称映射，普通与 SSE 输出恢复原名；修正未签名历史中明确可转换的数字/布尔/字符串参数；保留真实签名和工具 ID，不把无效参数静默替换为空对象                                                                                               |
| 多轮/并行工具历史 | 合并相邻同角色消息，按 ID 匹配结果，拒绝孤立/重复 ID；Gemini 把同一 user 块的工具结果放在普通文本前并按调用顺序排列，Claude 保持明确 ID 的结果原顺序，不跨用户轮次移动有签名的调用                                                                                              |
| 失效凭证自动停用  | 设置中的“明确 invalid_grant 时自动停用”，默认开启；只针对 OAuth 400/401 且错误精确为 invalid_grant。CAS 更新保护并发重新导入，固定渠道也可在剩余预算内改选账号；invalid_client、地区/权限及网络错误不自动停用                                                                   |
| ZIP 凭证备份      | 批量操作中导出 ZIP；批量导入页可选 JSON 或 ZIP。支持标准 stored/deflate ZIP，UTF-8 名称、CRC/大小校验；最多 100 条、单条 1 MiB、压缩与展开总量最多 4 MiB，不支持加密、分卷、ZIP64 或不安全路径                                                                                  |
| 稳定会话与标签    | Antigravity 默认按项目、API 密钥和首条用户文本生成稳定会话 ID，保留显式 sessionId；补入原项目请求标签。不把原始对话存进 D1/KV                                                                                                                                                   |
| 思考内容显示      | 设置“返回思考内容”，默认开启；关闭后请求 Google 不返回思考，并在输出转换时过滤思考文本，思考 Token 仍保留统计                                                                                                                                                                   |
| 假流式 / 心跳     | 设置“假流式兼容”，默认关闭；也可在单次流式请求加 fake_stream:true。等待一次普通生成期间发送 SSE 心跳，再按 OpenAI / Anthropic / Gemini 协议输出；不额外生成，取消时终止内部请求，保留同一请求 ID 与一次用量记录                                                                 |
| 抗截断 / 自动续写 | 设置“MAX_TOKENS 后最多续写次数”，默认 0，最多 2；仅续写有明确 MAX_TOKENS 的纯文本结果，保留同一账号、模型、渠道，不重放工具调用、图片或缺结束信号的响应。流式客户端使用心跳缓冲后输出，仍受普通请求总时限限制；总 Token 包含每次续写，可用 anti_truncation:false 在单次请求关闭 |
| AI Credits        | 全局“允许使用 AI Credits”和凭证行“允许此账号 Credits”必须同时开启才发送 enabledCreditTypes；全局默认关闭，凭证 enable_credit 仅接受布尔值。可能消费付费额度，导入或项目校验不会自动开启全局消费                                                                                 |
| 用量与限流        | OpenAI 返回缓存/思考 Token 明细；结构化 Google 额度重置最多冷却 7 天，错误 JSON 检查最多 64 KiB/1 秒，不消耗原响应正文，不增加逐请求冷却写入次数                                                                                                                                |

新增设置可在管理页保存，也可使用同名 vars：`AUTO_DISABLE_INVALID_CREDENTIALS`、`STABLE_SESSION`、`RETURN_THOUGHTS`、`ENABLE_AI_CREDITS`、`FAKE_STREAMING`、`CONTINUATION_ATTEMPTS`。前 3 项默认开启；后 3 项默认关闭或 0。不需要数据库迁移，也没有新增 KV/DO 资源。

自动续写可能重复少量文本或耗尽原有总时限；不承诺修复真正的流中断或 Google 的 524。缺少真实签名时的兼容占位值也无法恢复原思考上下文。Preview 是否可开通仍取决于真实账号资格与 IAM；本地回归使用隔离假凭证和模拟 Google 接口，不代替线上资格验证。

参考：[Google Preview 配置](https://docs.cloud.google.com/gemini/docs/codeassist/configure-release-channels)、[Google 设置 API](https://docs.cloud.google.com/gemini/docs/api/reference/rest/v1/projects.locations.releaseChannelSettings/create)、[Cloudflare 原生解压支持](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)。


读取预算优化：统计查询会先按时间、API 密钥和账号缩小明细与聚合表范围，再做合并去重；`0010_read_budget.sql` 添加密钥/时间与最后成功查询索引。凭证列表和健康页通过索引定位最后成功记录，避免每次浏览扫描所有聚合历史。统计使用 60 秒实例缓存及同执行节点的 Cache API 快照，并合并同一实例中的并发查询；手动刷新仍可绕过缓存。Cache API 不可用时继续尝试 KV 统计快照，再查询 DO；未绑定 DO 或明细模式保留直接查询 D1。快照不保存 OAuth 令牌、密钥内容或鉴权结果。API 密钥停用、删除、到期仍在每次请求中实时校验。新索引会在迁移时一次性构建，后续每个聚合桶落盘有少量索引维护写入，仍按 5 分钟批量落盘。

控制台顶部显示最近一次管理请求的 `cf-placement` 执行位置；常见节点显示国家和城市，未知代码显示原始节点码，缺少该响应头则显示“未知”。这不是固定 Google 出口，也不通过 `CF-Ray` 猜测执行地区。


顶部“查询地区”会调用已登录管理员接口 `/admin/runtime-location`，由 Worker 请求固定的 Cloudflare `/cdn-cgi/trace` 地址来查询探测接收节点及 trace 地域提示。结果缓存 60 秒，同实例并发合并，最多等待 5 秒，无 Google 调用、D1/KV 读写或额外 Cloudflare 管理令牌。仅返回白名单地区字段，不返回 IP、认证头或原始 trace 内容。页面明确区分 `cf-placement` 的实际执行节点与 trace 的“探测节点”；trace 的 `loc` 可能受入口信息影响，不能用来断定 Worker 出口国家，探测结果不保证等于 Google 看到的出口，也不推断部署配置。探测失败可重试，不影响模型调用。部署目标与调度状态仍需在 Cloudflare 控制台或其管理 API 查询，不能用探测接收节点替代。

统计缓存写入由同一个 `TELEMETRY` DO 限频：所有筛选共用一个每 5 分钟最多一次的查询快照发布名额（持续 24 小时最多 288 次），历史快照每小时最多一次（最多 24 次）。二者合计最多 312 次 KV 写入 / 24 小时，不含配置和模型缓存；手动刷新、多实例并发和重启不会额外绕过发布间隔。KV 故障不会阻止统计查询；历史同步失败不会发布部分数据。DO 用压缩分片保存历史快照，首次 / 重启只读少量分片，后续查询从内存计算；请求持久累加仍消耗 DO 额度。页面显示统计生成时间和 D1 历史同步时间。Google 账号额度使用 10 分钟 DO 缓存，可强制重新查询；修改 / 删除凭证会失效对应缓存。已支持下述跨账号 DO 用量缓冲与缓存轮换。

系统设置 → 存储节点：填写账号邮箱（仅作名称）与 Cloudflare API Token，可自动创建独立 `agy2api-storage-*` Pages 入口、Worker 与 SQLite DO，验证实际读写。主服务通过 pages.dev 访问绑定的 DO，不依赖 workers.dev。Token 需要目标账号 Workers Scripts 编辑、Cloudflare Pages 编辑和账号读取权限，按用户要求保存在主 D1；列表不返回 Token 或节点密钥。重新部署复用原有 Worker / DO，不清空数据。

采用单节点值班、每小时整点按当日业务请求数优先选择消耗较少的健康节点，本小时内固定值班；不同时分片，也不双机复制。当前值班子节点接收新的模型用量、问题记录和缓存，旧节点继续补交尾部用量并保留问题记录。新增或恢复节点从下个整点参与；首次无可用节点时立即启用。整点前一分钟确定下一节点，有缓存请求时预热该节点并双写缓存，模型用量不双写。节点目录在实例内缓存 5 分钟，并在预热 / 整点边界强制更新。模型请求仍由主服务执行，凭证、API 密钥、鉴权和系统配置保留主 D1。

子节点用量先持久化 SQLite，每 5 分钟批量提交主 TELEMETRY DO，再按原有周期聚合落盘 D1。统计查询实时读取各节点缓冲并按节点桶键 / 版本导入主 DO，再合并已有历史，不等待后台提交或先写 D1。有子节点时绕过旧统计结果缓存。明确不支持 / 容量满回退主 DO；确认响应丢失时保存同聚合键的 D1 明细兜底，导入后按成员请求去重。故障熔断 60 秒。子节点不保存 Google OAuth Token、API 密钥值或鉴权结果。

问题记录留在子节点 SQLite，保留 7 天，主 D1 的旧记录和故障兜底记录仍可查询。问题一览跨节点合并，支持筛选、分页、JSON 导出和匹配清理；清理记录不删除用量。凭证成功 / 失败状态、最近使用时间随聚合桶批量更新主 D1，管理页合并未落盘状态，减少逐请求状态写入。模型目录优先从子节点读取，低频 KV 副本继续作为跨节点冷启动回退；额度缓存有效期 10 分钟。移除节点前先汇总其待提交用量；远端资源保留，但该节点问题记录将不再出现在主面板。

原 workers.dev 节点点击“重新部署”会创建同名 Pages 项目并复用已有 DO，无需重填已保存 Token。若 Pages 尚在发布，可稍后点击“检查连接”，无需再次上传。Pages 的生产和预览环境均使用独立节点密钥保护，API Token 只留在主 D1。

存储节点的部署“就绪”只表示版本已发布，仍需“检查连接”成功才能使用。若返回 Cloudflare 1101 且节点没有任何调用日志，应另建最小 Hello World 验证同账号的 workers.dev 入口，区分代码异常与路由 / 账号问题；不要仅靠反复部署 DO 脚本排查。连接错误会保留合法的 Cloudflare Ray ID，可用于向 Cloudflare 提交故障。

节点列表展示北京时间当天的用量与缓存请求、读取命中率、写入、错误、预热导入导出、有效缓存条数和正文大小。统计从节点升级启用时开始，不追溯历史；健康检查与未授权请求不计入。计数在 DO 内存汇总，每 5 分钟写入本节点 SQLite，保留最近 7 天，不增加 D1 写入。页面显示持久计数与当前内存之和；异常重启可能丢失未落盘的最近 5 分钟，所以是近似应用计数，不是 Cloudflare 官方账号额度或账单。用量查询结果缓存 30 秒，刷新节点可立即重新查询。查询失败单独显示原因，不将未知显示为零，也不修改节点轮换状态。

节点列表首行固定展示当前主节点，不加入子节点轮换且不能移除。主节点读取已有 TELEMETRY DO 状态，展示当日接收用量、待落盘请求与桶数、缓冲和额度缓存正文大小、压缩历史快照大小及同步时间；不触发 D1 查询、历史同步或新增写入。接口读写次数仅覆盖本次 DO 实例，重启后重新计数，不能当作 Cloudflare 官方请求额度或 SQL 行数。查询缓存 30 秒，手动刷新可重新读取。

节点自动部署失败会显示具体操作、HTTP 状态、Cloudflare 错误码和合法 Ray ID，不回传原始错误正文或凭证。仅在新 Worker 第一次上传遇到通用 403 / 10000 时等待 1 秒自动重试一次；401、明确权限错误、现有节点重新部署和 Pages 写入不会因此重复提交。持续失败仍会停止并保留具体错误，不能据此认定所有 403 都是暂时故障。

节点页展示当前值班节点和待轮换节点，包含当日模型用量、待汇总请求与桶数、本节点问题记录数，以及缓存请求和命中率。页面可见且登录时每 30 秒刷新，离开、后台或登出后不轮询；重新进入立即查询。时间列显示采集时间，悬停可查看连接检查时间。

页面加载优化：概览并行加载账号与统计，同时发生的子节点同步合并为一次请求。凭证页先查询基础信息，再在后台合并最新健康状态；基础查询不逐账号扫描历史用量。问题记录并行读取主库和子节点。统计使用主 DO 内存中的按日汇总索引，增量更新变化的实时用量桶，完整日期使用预汇总，时间边界及请求 ID 筛选仍按原始记录精确计算；不增加 D1 表或逐请求写入。

节点监控仅在页面可见且登录时轮询，30 秒内重复可见事件不再次查询；服务端合并并发查询并缓存节点列表和指标 30 秒，手动刷新绕过缓存。缓存会在轮换整点、预热边界及节点管理操作后失效，主节点与子节点指标并行读取。

各页面底部“加载诊断”显示最近 12 个查询接口的浏览器耗时与 Server-Timing 阶段耗时，包括账号查询、子节点同步、主节点统计、历史同步与汇总计算。记录仅保留在当前页面内存，退出或会话失效时清空；不保存查询参数、请求正文、Cookie 或密钥。超过 1.5 秒的管理员接口额外输出脱敏的 admin_slow_request 日志，无新增 D1 日志写入。


### 主节点读写优化（v0.19）

- 历史首次载入或手动“同步历史”执行完整校准；之后每小时按需读取变更序号之后的用量桶和新增明细。序号与批量落盘在同一 D1 事务中更新，分页使用变更索引，未修改的历史记录无需重读。
- 每批最多 25 个用量桶、约 512 KB 数据，落盘合并为 5 条 SQL；同一凭证的最后成功、失败与使用时间先合并再更新，不再每个模型桶分别写一次。
- 子节点快照支持 known_versions，仅传回变化的桶；主服务兼容旧节点，并在版本未变时跳过主 DO 导入。不增加结果缓存时间，统计仍实时合并待提交数据。
- 概览的统计响应同时包含实时凭证健康状态，省去独立健康查询；凭证页单独打开时仍可查询健康状态。
- 完整保留最近两天及当天的细粒度热数据。更早的用量按北京时间自然日压缩归档，每小时按需处理最多 200 个桶、约 512 KB；大日期拆成多个归档块，逐步消化存量。归档同时保存每日汇总和原始桶时间，保留精确时间筛选、空值/零值和晚到累计版本的去重语义，30 天统计保留期不变。归档写入与按版本删除热记录在同一 D1 事务中进行；归档失败保留热数据。归档迁移本身有一次性的读写开销，不承诺当天立即降到最低。
- D1-only 查询也能读取日归档；归档不包含 Google 凭证或 API 密钥值。新部署和升级需应用 migrations/0014_telemetry_incremental.sql。


### 问题记录中的账号与失败阶段（v0.19.1）



### 就近展示管理操作结果（v0.20）

账号健康详情和 API 密钥用量在对应行下方展开，可就地收起；账号名称、调度参数、密钥名称和到期时间使用行内表单。节点 Token 更新也在对应节点下方完成，取消、换页和退出时清空输入。行内操作的进度、结果及错误紧邻操作按钮显示，并在列表刷新后保留反馈。批量操作、授权和模型查询已有各自的结果区域，继续保留原有位置。

现有子节点可在存储节点页点击“改为 agy2api”：保留 Worker 身份与 DO 命名空间，发布新 Pages 入口，读写验证通过后切换节点地址。失败可重试，旧 Pages 入口保留以兼容切换中的请求。DO 内部实例名保持稳定；D1 数据库实体名仍为 `gcli2api`，Cloudflare 不提供原地改名接口。
