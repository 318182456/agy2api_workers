export const oauthPage = String.raw`<div class="narrow-page"><section class="card"><div class="step-label">01 · 创建授权链接</div><h2>添加 Google 账号</h2>
<p>生成链接后登录 Google 并授权。完成后若跳转 localhost 页面无法访问，复制地址栏中的完整 URL 粘贴到下方；无需在本地启动服务。链接 10 分钟有效。</p>
<form id="oauthStart"><label for="oauthMode">授权渠道</label><select id="oauthMode"><option value="antigravity">Antigravity</option><option value="geminicli">GeminiCLI</option></select>
<label for="oauthProject">项目 ID（可选，自动校验失败时使用）</label><input id="oauthProject" placeholder="project_id">
<label for="oauthName">凭证名称（可选）</label><input id="oauthName" maxlength="180"><button>生成 Google 授权链接</button></form>
<p id="oauthLinkArea" hidden><a id="oauthLink" target="_blank" rel="noopener noreferrer">打开 Google 授权页面</a></p>
<div class="step-label form-divider">02 · 完成授权并保存</div><form id="oauthComplete"><label for="callbackUrl">授权后的完整回调 URL</label><textarea id="callbackUrl" rows="3" placeholder="http://localhost:11451/?code=…&amp;state=…" required></textarea><button>交换令牌并保存凭证</button></form><small>令牌保存在 D1，不会直接显示。保存后可在凭证行下载 JSON。邮箱或项目查询失败时仍保留已获得的令牌。</small></section></div>`;
