# GCLI2API Workers

独立于原 Python 项目的 Cloudflare Workers 版本。所有 API、管理页和凭证存储运行在 Cloudflare，部署后不需要在本地启动 Python、Docker 或另一台服务器。

实现使用原生 JavaScript、Workers Fetch/Streams 和 D1，没有生产运行依赖。适用于个人、低流量场景的 Workers Free + D1 Free 配额。

## 功能范围

| 功能 | Workers 版 |
| --- | --- |
| GeminiCLI、Antigravity 两种凭证渠道 | 支持，分别导入和调用 |
| OpenAI `/v1/chat/completions` | 支持普通响应和 SSE 流 |
| Gemini `/v1beta/models/{model}:generateContent` | 支持，也接受 `/v1/` |
| Gemini `:streamGenerateContent?alt=sse` | 支持 SSE，解开上游 response 包装 |
| OpenAI `/v1/models`、Gemini `/v1beta/models` | Antigravity 动态查询 Google；GeminiCLI 使用配置列表 |
| 文本、base64 图片输入、函数工具调用 | 支持；工具思考签名通过 `extra_content.google.thought_signature` 回传 |
| Gemini 原生图片输出 | 原样透传；OpenAI 图片输出暂不支持 |
| 凭证导入、列表、删除、启用/停用 | 单条与批量操作，JSON 多文件与备份恢复，D1 持久化 |
| 邮箱查重 | 同渠道分组、建议保留项，选择后手动处理 |
| 网页配置 | 凭证策略、流式汇总开关、重试数量、GeminiCLI 模型和 Antigravity 备用模型，保存后即时生效 |
| Antigravity 模型额度查询 | 支持，凭证行点击“查看额度”，展示剩余比例与北京时间重置时间 |
| 管理登录会话 | HttpOnly Cookie 保留 7 天，刷新自动恢复，支持退出，改密码后旧会话失效 |
| Google 账号授权取凭证 | 手动回填 localhost 回调 URL，PKCE + 一次性 state |
| 邮箱、项目校验、指定凭证调用测试、下载 JSON | 支持，见管理页凭证行 |
| 访问令牌刷新 | 按需刷新；上游 401 时再刷新并重试一次 |
| 多凭证选择 | 跳过当前模型冷却的凭证，429/500/503 有限切换；并发下不保证严格轮询 |
| 调用记录 | 最近 2000 条事件，按邮箱/凭证/模型/渠道/状态/阶段/时间/请求 ID 筛选、导出与清理 |
| 用量统计 | 按日期、邮箱/凭证、模型统计最终请求、成功率、耗时和上游报告 Token |
| 凭证健康 | 最后生成成功、失败状态/阶段、连续失败事件、模型冷却详情 |
| 凭证选择策略 | 轮询、优先级、权重随机；账号调度参数可编辑并随备份恢复 |
| 额度总览 | Antigravity 逐账号查询、错误独立显示、模型平均/最低比例、停止后续查询 |
| 部分模型兼容修复 | 已知 Gemini 思考参数/后缀、预填充清理、Antigravity 工具参数字段归一化 |
| Anthropic `/v1/messages` | 两个渠道支持普通响应与标准 SSE、文本/base64 图片、自定义工具与 thinking 块 |
| Token 计数接口 | Messages count_tokens 与 Gemini countTokens，本地估算并带响应头标记 |
| OpenAI Responses API | 暂不支持 |
| 授权后自动发现项目 | Antigravity 查询 loadCodeAssist；GeminiCLI 保留指定项目或选唯一项目；多个项目需手动指定 |
| 自动 localhost 回调服务器、ZIP 导入 | 暂不支持；Workers 使用手动回填回调 URL |
| 抗截断、假流式、后台保活、日志 WebSocket | 暂不支持 |
| 工具 Schema 兼容处理 | 本地引用展开、组合类型简化、约束写入描述，非完整 Schema 校验器 |
| Antigravity 模型兼容 | 明确别名、Claude 工具 ID、原生图片参数；详见 v0.10.0 |
| Antigravity 流式汇总普通响应 | 网页开关，默认关闭；支持三种 API 响应格式 |
| 自动封禁 | 未迁移，不会根据单个 403 自动停用账号 |

Antigravity 接口在相同路径前增加 `/antigravity`，例如 `/antigravity/v1/chat/completions`。该渠道的模型、工具兼容性仍需用真实账号验证。

## 部署

需要 Cloudflare 免费账号和 Node.js 20 或更新版本。以下命令都在本项目目录执行：

```powershell
cd D:\test\318182456\gcli2api-workers
npm ci
npx wrangler login
npx wrangler d1 create gcli2api
```

将创建数据库后返回的 `database_id` 填到 `wrangler.jsonc`，替换全零占位值。保留 `binding` 为 `DB`。如果账号中已有同名数据库，可改用其他数据库名，并同步修改配置中的 `database_name`。

```powershell
npm run db:remote
npx wrangler secret put API_PASSWORD
npx wrangler secret put PANEL_PASSWORD
npm run deploy
```

两个 `secret put` 会交互式询问密码。设置两个不同的长随机密码，不能留空。密码不要写进 `wrangler.jsonc` 或代码仓库。Wrangler 首次写入 Secret 时可能会询问是否创建 Worker，按提示创建即可。

打开部署返回的 `https://gcli2api.<你的子域名>.workers.dev`，使用 PANEL_PASSWORD 登录，导入凭证。两个 Secret 都缺省时，服务拒绝受保护的请求，不使用默认密码。

### OAuth 客户端配置

源码不包含 OAuth 客户端 ID 或密钥。使用网页 Google 授权前，为对应渠道设置以下 Workers Secrets：

```powershell
npx wrangler secret put GEMINICLI_CLIENT_ID
npx wrangler secret put GEMINICLI_CLIENT_SECRET
npx wrangler secret put ANTIGRAVITY_CLIENT_ID
npx wrangler secret put ANTIGRAVITY_CLIENT_SECRET
```

每条命令按提示输入对应值；只需配置使用的渠道。客户端必须与所用渠道及刷新令牌匹配。本地开发将这些变量写入已被 Git 忽略的 `.dev.vars`，可参考 `.dev.vars.example`；不要将实际值写入示例或 `wrangler.jsonc`。导入包含 `client_id` 和 `client_secret` 的完整凭证时优先使用凭证自带值。未配置对应渠道时，网页授权返回明确的配置错误。

### 导入原项目凭证

在原项目控制面板中导出单个 JSON 凭证（不要直接上传 SQLite 数据库），在新管理页选择对应渠道并导入。凭证必须至少有：

```json
{
  "project_id": "你的 Google 项目 ID",
  "refresh_token": "你的刷新令牌"
}
```

也接受 `token`/`access_token`、`expiry`、`client_id` 和 `client_secret`。未提供 OAuth 客户端信息时使用对应渠道的环境变量配置。如果凭证来自自定义 OAuth 客户端，请同时导入配套的 client_id 和 client_secret。只有访问令牌、没有 refresh_token 的凭证到期后需要重新导入。

同渠道、同名称的导入会更新凭证内容并保留启停状态。列表 API 不返回令牌或客户端密码；凭证本身保存在 D1 中，拥有数据库权限的人可以读取。不要把真实凭证提交到 Git。

### 动态模型列表（v0.6.0）

Antigravity 的 `GET /antigravity/v1/models` 和 `/antigravity/v1beta/models` 现在优先调用 Google 的 `fetchAvailableModels`，不需要在 vars 手动填写新模型。NewAPI 重新获取模型时即可拿到动态结果。

管理页“模型列表”中选择 Antigravity，点击“获取模型列表”，会显示来源、模型 ID 和回退原因。

- `google`：Google 实时返回；合法空列表保持为空，不拼接配置中的模型。
- `fallback`：动态请求失败，使用 `ANTIGRAVITY_MODELS` 备用列表，并提示失败原因。
- `vars`：GeminiCLI 当前仍使用 `GEMINICLI_MODELS` 配置，与原 Python 项目一致；没有使用 Antigravity 的端点冒充 GeminiCLI 发现结果。

API 响应头 `x-model-list-source` 表示上述来源；回退时还有 `x-model-list-warning: dynamic-discovery-failed`。没有配置备用列表时，动态查询失败会返回对应错误；可将 `ANTIGRAVITY_MODELS` 设为空字符串关闭回退。

每次查询实时使用一个已启用的 Antigravity 凭证，按需刷新令牌；不合并全部账号，也不修改聊天轮询顺序。不会伪造思考模型别名或功能前缀。模型列出不代表当前额度、地区和每种参数的调用都能成功。

在网页配置中修改模型列表后立即生效；修改 vars 默认值需要重新部署。动态模型查询本身无需重新部署。升级当前版本先执行下述数据库迁移。

可选变量 `CODE_ASSIST_ENDPOINT` 和 `ANTIGRAVITY_API_URL` 接受 HTTPS origin，不接受路径。默认直接访问 Google，不依赖第三方反代。

## 渠道错误、503 和额度按钮不显示

页面顶部显示 `v0.12.0` 时才是新版分页面控制台。改动代码后需要运行 `npm run deploy`，并刷新正在使用的域名页面。

凭证“渠道”与调用接口需要一致：GeminiCLI 使用 `/v1`，Antigravity 使用 `/antigravity/v1`。如果客户端自动追加 `/v1`（例如部分 NewAPI 渠道），Base URL 填 `/antigravity`，避免重复路径。客户端收到“当前模式没有可用凭证”时，请检查服务端管理页的渠道和启用状态；NewAPI 渠道自身的“启用”状态不代表服务端凭证已启用。

导入会识别环境变量中配置的两种 OAuth client_id，拒绝已知客户端与所选渠道冲突。历史上导入错渠道的凭证会出现“纠正为 antigravity / geminicli”按钮，确认后移动到正确渠道，保留原令牌和启停状态，无需重建数据库。如果目标渠道已有同名凭证则提示冲突，不会覆盖或删除。

“查看额度”只出现在 Antigravity 凭证行。错误标为 GeminiCLI 的 Antigravity 凭证应先纠正渠道；已停用的凭证仍可查询额度，但不会参与聊天调用。

## v0.12.0：分页面管理控制台

从 v0.11.0 升级只需 `npm run deploy`，没有新增数据库迁移。更旧版本仍需先执行 `npm run db:remote` 应用既有迁移。刷新浏览器确认版本 v0.12.0。

管理台改为侧栏导航，每个页面都有独立地址，直接打开、刷新和浏览器前进/后退均可用；沿用现有 7 天登录会话。

| 页面 | 地址 | 内容 |
| --- | --- | --- |
| 概览 | `/panel/overview` | 账号摘要、用量卡片、按日期/模型/账号切换统计表 |
| 凭证管理 | `/panel/credentials` | 搜索、渠道/状态筛选、每页 25 个账号、健康详情、批量操作和查重 |
| 额度总览 | `/panel/quota` | 手动查询账号额度、汇总和查询结果 |
| 调用日志 | `/panel/logs` | 筛选、翻页、导出与清理 |
| 导入凭证 | `/panel/import` | 单文件/粘贴导入、多文件和备份恢复 |
| Google 授权 | `/panel/oauth` | 生成授权链接、回填 URL、保存账号 |
| 模型列表 | `/panel/models` | 手动动态查询模型和来源提示 |
| 系统设置 | `/panel/settings` | 凭证调度、重试、备用模型、流式汇总开关 |
| 接口接入 | `/panel/api` | OpenAI、Anthropic、Gemini 地址和复制按钮 |

根地址 `/` 和 `/panel` 登录后默认进入概览。页面首次进入时加载必要数据，之后保留筛选与未提交输入，可用各页刷新按钮更新；额度和 Google 模型发现不会因切换页面自动查询。导入/授权完成后跳到凭证管理，凭证行“调用记录”会跳到已筛选的日志页。

凭证行常用的健康详情、查看额度直接展示，重命名、邮箱、项目校验、测试、下载、调度、启停和删除收进“更多操作”。健康、批量操作和查重按需展开。全选仅选择当前页，已选项可跨页保留；“取消全部选择”清空选择。搜索支持邮箱、名称与项目 ID，不会重复请求数据库。

桌面使用固定侧栏，手机使用可横向滑动的顶部导航；宽表格在表格区域内滚动。页面、样式和共用交互拆分在 `src/panel-pages/`、`src/panel-style.js`、`src/panel-views.js` 和 `src/panel.js`，继续打包到 Worker，不依赖外部 CDN。

## v0.11.0：用量统计、凭证健康、调度、额度总览与日志管理

**本次需要先应用 `0005_operations.sql`，再部署。** 迁移保留原凭证与令牌，新增 priority（默认 0）、weight（默认 1）、credential_health 和 request_usage；不需要重新导入账号。

```powershell
cd D:\test\318182456\gcli2api-workers
npm run db:remote
npm run deploy
```

刷新管理页确认 v0.11.0。不要手动重复执行 ALTER TABLE，`db:remote` 会通过 D1 迁移记录仅应用未执行的文件。

### 用量统计

管理页顶部点击“刷新统计”，按邮箱包含、模型、渠道、开始/结束时间筛选。默认最近 7 天；按北京时间日期、模型/渠道、邮箱/凭证分组展示请求数、成功率、失败/取消数、输入/输出/思考/总 Token、平均完整处理耗时。时间输入采用浏览器本地时区。模型显示实际路由后的 ID，例如别名 claude-opus-4-6 的记录为 claude-opus-4-6-thinking。

统计按客户端生成请求保存一次最终结果，凭证重试不重复计数，收到 200 响应头不算成功，普通 JSON 完成处理或流正常结束后才记成功。最终账号是最后使用的凭证，先前失败的账号保留在事件日志及健康摘要。没有选中凭证的失败请求也会计入。认证和进入生成流程前的格式错误、模型发现、计数、额度查询和管理页测试调用不计入生成统计；进入生成流程后发生的参数归一化错误会计为失败。中断/取消保存当时已观察到的上游用量；缺失字段保持未知，不用本地估算补齐，也不把累计流用量相加。总 Token 以 Google 报告值为准，可能含思考等类别。

保留最近 30 天且最多 10000 次请求，写入时自动清理；查询隐藏超过 30 天的记录。分组最多返回请求数前 200 项，页面提示超限时可缩小筛选。不会从升级前的响应头日志补造成功记录或 Token；也不代表 Google 全账号计费/用量。统计、健康、日志写入会增加 D1 读写，持久化异常仅记告警，不触发再次生成。

### 凭证健康与选择策略

凭证行展示最近观察结果、最后成功时间、冷却模型数和优先级/权重。点击“健康详情”查看最后失败的 HTTP 状态、阶段、固定错误代码、连续失败事件及各模型冷却截止时间。失败可能来自某个模型、请求或网络，不表示整个账号被封禁；不会自动停用。取消请求会计入取消统计/日志，但不增加凭证失败摘要。成功、失败摘要独立保存，删除事件日志后仍可查看。

在“网页配置”加载后选择策略并保存；每行“调度设置”修改账号参数：

| 策略 | 行为 |
| --- | --- |
| round_robin（默认） | 优先最久未使用账号 |
| priority | 优先级最高者优先，同优先级轮询，范围 -100～100 |
| weighted | 按权重随机选择，权重 1～100；如 3:1 为长期概率约 75%:25%，不保证连续 4 次的固定比例 |

三种策略都跳过停用、当前模型冷却和本次已尝试账号；不同渠道分别选择。并发时不保证严格轮询。高级默认值可用 vars `CREDENTIAL_SELECTION` 设置，网页保存值优先。JSON 批量备份会携带优先级/权重；旧备份或单文件导入未提供这些字段时保留已有调度设置。

### 额度总览

在“Antigravity 额度总览”点击“查询全部账号额度”，默认仅查询启用账号，可勾选包含停用凭证。浏览器逐个调用已有额度接口，单个失败继续，可停止后续请求。逐账号列出模型剩余比例、北京时间重置时间、查询时间或错误；模型汇总给出已知/未知账号数、平均与最低剩余比例。失败、未查询和未返回该模型的账号不参与均值，比例不能相加当余额，也不能换算调用次数。没有定时后台轮询，结果保存在当前页面。

### 日志筛选、导出与清理

“调用记录”支持凭证、邮箱包含、模型、渠道、状态码（429 或 5xx 等）、阶段、请求 ID、时间范围筛选与游标翻页。response_headers 是一次上游尝试的响应头；completed 是最终完整处理，stream_error/client_cancelled 分别是断流/取消，事件条数不同于客户端请求数。原始 Google 错误正文、聊天内容和访问令牌不写入这些表。

“导出匹配日志 JSON”下载当前筛选结果（最多 2000 条）；“删除匹配日志”确认后删除所有匹配事件，而非当前一页。无筛选会删除全部事件日志。用量统计、凭证健康与模型冷却保留，仍按各自保留规则更新。

管理接口（需 PANEL_PASSWORD 或管理会话）：

- `GET /admin/stats`：最终请求统计，支持 credential_id/email/model/mode/status/request_id/from/to。
- `GET /admin/credentials/{id}/health`：健康摘要和有效冷却列表。
- `PATCH /admin/credentials/{id}`：支持 priority/weight。
- `PATCH /admin/settings`：支持 CREDENTIAL_SELECTION。
- `GET /admin/calls`、`GET /admin/calls/export`：查询和导出事件日志。
- `DELETE /admin/calls`：相同筛选参数，JSON 请求体须为 `{"confirm":"delete-matching-logs"}`；忽略分页游标。

from/to 可为毫秒时间戳或 ISO 时间，日志/统计模型、阶段、请求 ID 为精确匹配，邮箱为忽略大小写的包含匹配。修改类请求继续校验管理会话来源。

## v0.10.0：工具 Schema、模型映射与流式汇总

从 v0.9.0 升级执行 `npm run deploy` 即可，无新增 D1 迁移。刷新管理页确认显示 v0.10.0。

- 工具 Schema：展开本地 `$ref`/`$defs`，合并 `allOf`，简化 `anyOf`/`oneOf`、nullable、tuple 和类型数组。数值/布尔枚举转换为字符串，范围等约束写入描述；语义可能弱化，需要调用方继续验证工具参数。拒绝远程或失效引用；递归引用变为结构提示，展开最多 4000 节点、24 层。两个渠道均执行整理。
- Antigravity 明确别名：`claude-opus-4-6` → `claude-opus-4-6-thinking`，`claude-sonnet-4-6-thinking` → `claude-sonnet-4-6` 并添加默认思考预算，`gemini-3.1-pro-high` → `gemini-pro-agent`。未知名称保持原样，实际模型权限仍由上游决定。Claude 工具历史保留已有 ID，缺失时配对补齐，拒绝无对应调用的结果。
- Gemini 原生图片请求：`gemini-3-pro-image`、`gemini-3-pro-image-preview` 兼容名路由到 `gemini-3.1-flash-image`；支持 `-1k/-2k/-4k` 和 `-16x9` 等已知比例后缀。原生请求的 `size`（如 `1024x1536`）优先于 imageConfig，imageConfig 优先于后缀；尺寸选最近支持比例，保留输出 token 上限。图片请求移除 systemInstruction、工具和思考参数。OpenAI Images API 暂不支持。
- 在“网页配置”先加载，再勾选“Antigravity 普通请求使用流式汇总”并保存。默认关闭，也可配置 `ANTIGRAVITY_STREAM2NOSTREAM = "true"` vars；网页布尔配置优先。开启后普通 OpenAI、Anthropic、Gemini 请求向上游请求 SSE，收齐后返回各自 JSON，带 `x-upstream-mode: stream-collected`。原本的流式客户端继续使用流式响应。

汇总保留文本/思考/工具/图片的顺序、真实签名和最后收到的累计用量；缓存按收到的事件 UTF-8 数据总量限制为 8 MiB。无 finishReason 的提前断流、错误事件和超限返回 502，并以 stream_collection 阶段记录，不在输出后换凭证重试。被安全策略拦截的 promptFeedback 正常保留。网络耗时、免费 Worker CPU 和上游账号限制仍然适用。

## v0.9.0：Anthropic Messages 与 token 估算

本次没有新增数据库表，从 v0.8.0 升级只需重新部署。管理页接口地址区会显示 Anthropic Base URL。

| 渠道 | Messages | 本地 token 估算 |
| --- | --- | --- |
| GeminiCLI | `/v1/messages` | `/v1/messages/count_tokens` |
| Antigravity | `/antigravity/v1/messages` | `/antigravity/v1/messages/count_tokens` |

Anthropic SDK 的 Base URL 通常填站点根地址，Antigravity 填 `https://你的域名/antigravity`；SDK 会添加 `/v1/messages`，避免重复 `/v1`。密钥使用 API_PASSWORD，接受 `x-api-key` 或 Bearer。不要使用管理密码代替 API Key。

请求示例：

```json
{
  "model": "账号实际可用的模型ID",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "你好"}],
  "stream": true
}
```

支持 system 文本、user/assistant 消息、base64 图片、自定义工具的 tool_use/tool_result、真实 thinking 签名与 enabled/disabled thinking 配置。工具结果需要匹配此前的 tool_use_id。普通响应为 Anthropic message 结构；流式返回 message_start、content_block_start/delta/stop、message_delta、message_stop 等事件，不使用 OpenAI 的 `[DONE]`。

思考签名按 Google 实际返回保存，不伪造 Claude 官方签名；工具块若带 Google 签名，通过 `extra_content.google.thought_signature` 扩展回传。客户端需要保留这个扩展才可在后续请求中完整带回。

Messages 调用复用现有凭证切换、冷却、网页配置和调用记录。上游 429 使用 Anthropic rate_limit_error，保留 Retry-After。流中断发送 error 事件并记录，不伪造正常结束，也不在输出后自动重新调用。

协议转换目前不支持 Anthropic 服务端 web_search/computer_use 等工具、redacted_thinking、adaptive thinking、强制关闭并行工具、图片输出或所有官方模型别名。输入不支持的内容会返回明确错误，不能据此宣称兼容全部 Claude 客户端功能。模型仍须使用 Google 账号实际可用的 ID。

### Token 估算

支持 Messages 的 `/count_tokens` 以及两个渠道 Gemini 的 `/v1beta/models/{model}:countTokens`（也接受 `/v1/`）。均为本地字符数粗估加图片固定估值，不访问 Google，不发起生成。响应头为 `x-token-count-estimated: true`，分别返回 `input_tokens` 或 `totalTokens`。

不把 base64 图片字符串长度当文本 token。图像实际尺寸、语言、模型 tokenizer、系统开销等都会造成误差，不能用来计算准确账单或保证不超过模型上下文。

参考官方协议：[Messages API](https://platform.claude.com/docs/en/api/messages/create)、[Anthropic 流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)。测试中的 Google 响应为模拟，尚需真实账号验证具体模型和客户端兼容性。

## v0.8.0：批量管理、JSON 备份、邮箱查重与网页配置

升级时先执行 `npm run db:remote` 创建 `app_settings` 表，再执行 `npm run deploy`。原有凭证、日志和会话保持可用。

### 批量操作

凭证表新增勾选框与全选；选择操作后点击“执行选中项”。支持获取邮箱、校验项目、测试调用、启用、停用、清除冷却、导出和删除。

页面逐条调用现有管理接口，避免在一次 Worker 调用中请求太多 Google API。单项失败会显示原因并继续其他项。可点击“停止后续操作”；已完成的操作保留，正在进行的一项会完成后停止。删除与测试调用会先确认，测试会消耗少量额度。

### JSON 多文件和备份

- 在“多文件导入与查重”选择多个单凭证 JSON，或本项目导出的 JSON 备份文件。未知客户端使用所选默认渠道，已知 OAuth client_id 会自动识别；备份内显式指定的渠道仍由服务端校验。
- 备份包含名称、渠道、邮箱、启停状态和令牌；正常导入同名文件保留现有启停状态，备份恢复则使用备份明确记录的启停状态。
- 选择凭证并执行“导出 JSON 备份”，生成 `gcli2api-workers-credentials-v1` 格式，可重新导入。每份最多 1000 个凭证、4 MiB，超出请分批；暂不支持 ZIP。
- 导入导出不恢复调用日志、冷却状态或旧的测试结果。备份含刷新令牌，请妥善保存；操作结果列表不会显示令牌。

### 按邮箱查重

点击“按邮箱检查重复”，仅在同一渠道内按邮箱（忽略大小写）分组。没有邮箱的凭证不参与查重。建议保留顺序为启用状态、最近测试通过、最近使用、创建时间；建议不代表其他凭证无效。

检查只显示分组，不删除数据。“选中建议清理的重复项”后可选择批量停用或删除，也可以手动调整勾选。

### 网页配置

点击“加载当前配置”后可修改：

- 一次请求最多尝试凭证数量（1–5）。
- GeminiCLI 模型列表。
- Antigravity 动态查询失败时的备用模型列表；留空则不回退。

保存到 D1 的网页配置优先于 vars，后续新请求立即生效，无需重新部署。点击“恢复 vars 配置”移除网页覆盖值。密码和上游端点继续由部署配置管理，网页配置接口不接受这些字段。

接口为 `GET/PATCH /admin/settings` 和 `GET /admin/duplicates`，仅管理员可访问。读取生效配置会增加少量 D1 读取。

## v0.7.1：账号显示与名称修改

调用记录和凭证筛选器优先显示已保存的邮箱，没有邮箱时显示凭证名称。凭证行可点击“修改名称”，同渠道内名称须唯一，名称范围 1–200 个字符。重命名保持凭证 ID、令牌、启停状态和冷却信息不变；调用记录按 ID 筛选，历史记录可显示该凭证的当前名称和邮箱。

新调用还会保存当时的账号标识，删除凭证后仍能显示这一标识。对于获取邮箱之前就已删除的旧凭证，系统无法补回未知邮箱，只显示原记录保留的名称。

接口为 `PATCH /admin/credentials/{id}`，请求体例如 `{"name":"工作账号"}`。本次无需新增数据库迁移，从 v0.7.0 升级只需重新部署。

## v0.7.0：限流切换、冷却、调用记录和兼容修复

升级需先执行 `npm run db:remote`，再执行 `npm run deploy`。新增 `credential_cooldowns` 与 `call_logs` 表，保留现有凭证和 OAuth 数据。

### 凭证切换与冷却

- 聊天上游返回 **429 / 500 / 503** 时，记录当前凭证与模型的冷却，再尝试同渠道的其他已启用凭证。一次请求不会反复使用同一个凭证。
- `MAX_CREDENTIAL_ATTEMPTS` 控制一次请求最多尝试几个凭证，默认 3，范围 1–5；每个凭证仍支持一次 401 刷新重试。重试可能增加上游请求和用量。
- 优先读取 `Retry-After` 秒数或 HTTP 日期；无有效值时 429 默认冷却 60 秒，500/503 默认 10 秒，上限 24 小时。
- 按“凭证 + 实际模型 ID”隔离冷却，不会因为一个模型限流就停用整个账号。全部可用凭证都处于冷却时返回 429 和等待时间。
- 只有一个账号或其他账号不可用时，保留本次 Google 错误体和状态码，补充缺失的 Retry-After。管理页可手动清除某凭证的冷却；这不会消除 Google 真实限流。
- 403、参数错误、网络异常和已开始返回的流不做自动重放，也不自动封禁账号。这样可以保留原始错误，并避免流式输出重复。

### 调用记录

管理页“调用记录”可分页加载、按凭证筛选，也可点击凭证行的“调用记录”。每个账号尝试单独记录，切换产生的多条记录共享 `request_id`，与 API 响应头 `x-request-id` 对应。

仅存凭证名称/ID、渠道、模型、HTTP 状态、固定错误代码、阶段和耗时；不保存聊天内容、令牌或 Google 原始错误正文。最多保留最近 2000 条记录，旧记录自动删除。

`response_headers` 的 200 仅代表收到上游成功响应头，不等于完整生成成功；非流式解析失败会记录 `response_processing`，流式中断会追加 `stream_error`。日志写入失败不会重发已经发出的生成请求。

这些功能会增加 D1 读写，请关注免费额度。记录接口为 `GET /admin/calls?credential_id=...&before=...`，清冷却为 `DELETE /admin/credentials/{id}/cooldowns`，均只允许管理员访问。

### 已迁移的模型兼容部分

依据原项目的配置迁移 Gemini 2.5 Flash/Pro、3 Flash/Pro Preview、3.1 Pro/Flash-Lite、3.5 Flash、3.8 Flash 的思考参数处理。模型是否开放仍取决于 Google，不因存在兼容配置就代表账号可调用。

支持已知模型的 `-low`、`-medium`、`-high`、`-max`、`-minimal`、`-nothinking`、`-maxthinking`、`-search` 后缀，以及 OpenAI `reasoning_effort` 到 budget/level 的映射；后缀优先，budget 与 level 不会同时发送，budget 按原配置限制范围。未知模型 ID 保持不变，不擅自剥离可能属于真实 ID 的后缀。

整理空消息和已知不支持的末尾 assistant/model 预填充，保留工具历史与真实思考签名。原生 Gemini 省略 role 时按 user 处理。Antigravity 工具字段统一为 `functionDeclarations[].parameters`，避免与 parametersJsonSchema 同时发送，并为无参数函数提供空对象 schema。保持调用方的 max_tokens / maxOutputTokens 上限。

v0.10.0 补充下述 Schema 展开和明确别名；继续保留真实签名，不生成虚拟签名。

## Google 授权获取凭证、邮箱与校验

更新到 v0.5.0 时先运行 `npm run db:remote`，创建一次性 OAuth 流程表，再部署；保留原有凭证表和数据。

1. 管理页登录后，在“Google 授权获取凭证”选择 GeminiCLI / Antigravity。可填写已知项目 ID；留空时会在取令牌后尝试发现项目。
2. 生成并打开 Google 授权链接，选择账号并同意授权。
3. 授权后浏览器会跳转 `http://localhost:11451/?code=...&state=...`。没有本地监听服务时页面打不开是预期行为；复制地址栏完整 URL，回到管理页粘贴。
4. 点击“交换令牌并保存凭证”。授权链接 10 分钟有效，仅使用一次。交换时失败需要重新生成链接；不要把回调 URL 发给他人。
5. 令牌先保存到 D1，再获取邮箱、校验项目。后两项失败不会丢失已得到的凭证，管理页会提示重试。若没有项目 ID，先补充/校验项目再调用聊天。

OAuth 客户端从环境变量读取，保留原作用域并使用 PKCE 与一次性 state。Google 是否接受账号、作用域或客户端取决于其实际授权结果，尚未使用真实 Google 账号进行端到端授权。协议参考：[Google 桌面应用 OAuth 文档](https://developers.google.com/identity/protocols/oauth2/native-app)。

凭证行支持：

- **获取邮箱**：查询 Google userinfo 并保存邮箱，刷新后仍可见；没有权限时提示失败。
- **校验项目**：Antigravity 更新项目、订阅等级和上游返回的积分余额；GeminiCLI 通过项目列表确认指定项目或唯一项目。不会自动选多个项目中的任意一个，也不会自动开通服务或启用已停用凭证。
- **测试调用**：使用该行指定凭证发送一次 `hi`，最多输出 1 token，会消耗少量额度。200 记录通过；429 单独记录限流，不当作正常生成成功。未测试模型/Preview 通道不会显示为通过。
- **下载凭证**：下载含刷新令牌的 JSON，仅管理员可调用；请妥善保管。

接口为 `POST /admin/oauth/start`、`POST /admin/oauth/complete`，以及 `POST /admin/credentials/{id}/email`、`/verify`、`/test` 和 `GET /admin/credentials/{id}/download`。邮箱等信息只在管理接口返回，公开模型列表不包含账号信息。

## 登录会话

登录成功后浏览器保存 7 天的签名 HttpOnly Cookie，页面刷新或关闭后重新打开可恢复登录。线上 Cookie 使用 Secure、SameSite=Strict，不把管理密码存进 localStorage 或 sessionStorage。Cookie 到期、主动退出、清理浏览器 Cookie、修改 PANEL_PASSWORD 或切换域名后需要重新登录。

会话不依赖 D1，不需要额外的会话数据库迁移。共享管理密码的命令行请求仍可通过 `Authorization: Bearer <PANEL_PASSWORD>` 调用管理 API；聊天接口继续只接受 API_PASSWORD，不接受管理会话作为 API Key。

## 查看额度

管理页中，每个 Antigravity 凭证旁有“查看额度”按钮，可展开模型剩余比例、重置时间，支持手动刷新和收起。查询按需请求 Google，不自动轮询。GeminiCLI 沿用原项目的限制，暂不支持该额度查询。

也可使用管理密码调用 `GET /admin/credentials/{凭证ID}/quota`。API 返回 `models` 数组，每项包含 `id`、`remaining`（0 到 1，未知为 null）、`resetTime`（上游时间字符串，未知为 null）；前端统一转换为北京时间。查不到额度不等于额度为零，百分比不等于调用次数。

查询支持停用凭证，会按需刷新和保存访问令牌；不会启用凭证或更新聊天轮询时间。Google 返回地区、权限或账号限制时会提示失败，不显示虚构额度。本功能不代表信用积分余额查询。

## 调用示例

PowerShell：

```powershell
$apiBase = 'https://gcli2api.<你的子域名>.workers.dev'
$apiKey = '<API_PASSWORD>'
$chatBody = @{
    model = 'gemini-2.5-flash'
    messages = @(@{role = 'user'; content = '你好'})
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$apiBase/v1/chat/completions" -Method Post -Headers @{Authorization = "Bearer $apiKey"} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($chatBody))
```

OpenAI 客户端 Base URL 为 `https://你的域名/v1`，Antigravity 为 `https://你的域名/antigravity/v1`。API Key 填 API_PASSWORD。设置 `stream: true` 使用流式响应，`stream_options: {include_usage: true}` 请求末尾用量块。

Gemini 客户端可通过 `x-goog-api-key`、Bearer 或原生接口的 `?key=` 传密码；优先使用请求头，避免 URL 留下密码。管理 API 支持管理页 Cookie 会话或命令行 Bearer 认证，不开放跨域访问。Cookie 会话的写操作还要求同源 Origin。

## 本地开发与验证

```powershell
Copy-Item .dev.vars.example .dev.vars
# 编辑 .dev.vars 中的两个本地密码
npm run db:local
npm run dev
```

访问 `http://localhost:8787`。本地 D1 与线上 D1 分开，不会自动同步本地凭证。本地运行时 Google 请求仍从本机发出，不能据此验证 Cloudflare 的出口地区。

```powershell
npm test
npm run check
```

测试覆盖访问鉴权、凭证导入与刷新、两种渠道封装、OpenAI/Gemini 转换、工具签名、SSE 拆包与取消、上游错误保留。使用模拟 Google 响应，未包含真实 Google 账号调用。`npm run check` 只打包检查，不发布服务。

## 地区问题和免费配额

Cloudflare 部署会改变请求的执行环境，但本项目没有固定国家出口的能力，也不能保证消除 Google 的“不支持的地区”错误。Google 账号资格、项目权限和 Cloudflare 实际出口均可能影响结果。403 的原始响应会返回给客户端，便于定位；不要把该错误自动当作无效凭证。

Workers Free 目前每天 100,000 次请求、每次请求 10ms CPU；等待上游网络不计 CPU，但 JSON 转换和流式编码会消耗 CPU。长输出、大图片或超长上下文可能触及免费限额；本实现另限制入站 JSON 为 4 MiB。D1 Free 每天 500 万行读取、10 万行写入（索引更新也计入写入），不是 10 万次聊天配额。每次生成会读取和更新凭证，刷新令牌会增加写入。免费额度并不保证任意负载可用。

官方说明：[Workers 计费](https://developers.cloudflare.com/workers/platform/pricing/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)。

## v0.5.0 请求兼容修复

已修复两处可导致“连接失败”的 Workers 适配错误：生产 fetch 入口的第三个参数 ExecutionContext 曾被当成测试 HTTP 函数，以及 Workers 不支持 `redirect: error`。现在生产入口显式调用全局 fetch，Google 请求使用 manual 重定向并拒绝跟随，避免向其他地址转发令牌。

集成测试直接打包并运行 `src/index.js` 的真实生产入口，由本地运行时拦截出站 Google 请求；覆盖 OAuth 刷新、额度、聊天、登录会话、授权码交换、邮箱、项目校验、下载、过期与重放。真实 Google 账号调用仍需线上验证。

## 排查 500 / Google 连接失败

v0.3.1 将 OAuth 刷新、Google 聊天连接、额度查询和 D1 表结构问题区分开来。错误响应包含 `stage`、`request_id`，部分错误还包含 `reason`；管理页也显示这些字段。不要仅凭旧版的通用 500 提示判断需要重建数据库。

| stage / reason | 含义 |
| --- | --- |
| `oauth_refresh` | 获取/刷新 Google 访问令牌失败 |
| `generation_fetch` | 聊天请求连接 Google 失败 |
| `quota_fetch` | 额度查询连接 Google 失败 |
| `DB_SCHEMA_ERROR` | 发现表或字段缺失，执行数据库迁移 |
| `CREDENTIAL_DATA_INVALID` | 保存的凭证 JSON 无效，需要重新导入该凭证 |

Google 网络失败返回 502，超时返回 504；这些错误不会通过运行 D1 迁移解决。代码不会自动选择其他 Google 域名或第三方代理，因此仍需根据真实 Cloudflare 出口、Google 端点和账号状态排查连接故障。

Wrangler 配置已开启 `enable_request_signal` 与可观察日志。日志只记录固定阶段、错误类型、请求 ID 与代码栈位置，不记录请求体、令牌和原始异常内容。可在 Cloudflare Worker 日志中按请求 ID 查找，或运行 `npx wrangler tail` 后重试一次操作。提供诊断信息时只需错误响应与对应日志，不要附凭证或 Authorization 请求头。

验证包含 Miniflare 的实际 Workers 运行时 + 真实本地 D1 集成测试，Google 响应及连接失败用模拟实现，不代表线上 Google 连接已恢复。

## 来源与许可

本项目根据 [su-kaka/gcli2api](https://github.com/su-kaka/gcli2api) 的 GeminiCLI / Antigravity 协议和凭证字段重新实现，保留原项目 OAuth 客户端配置。原项目 Copyright (c) 2024 gcli2api contributors。本项目沿用 CNC-1.0 许可，详见 [LICENSE](LICENSE)。
