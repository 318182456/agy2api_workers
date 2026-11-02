export const oauthPage = String.raw`<div class="oauth-workspace"><aside class="workflow-guide"><h2>连接 Google 账号</h2><p>通过两步授权添加 Antigravity 凭证。</p><ol><li>生成链接并在 Google 完成授权</li><li>粘贴回调地址，保存凭证</li></ol><small>无需在本地启动回调服务。授权链接 10 分钟有效。</small></aside><div class="workflow-steps"><section class="card"><div class="step-label">01 · 创建授权链接</div><h2>添加 Google 账号</h2>
<p>生成链接后登录 Google 并授权。完成后若跳转 localhost 页面无法访问，复制地址栏中的完整 URL 粘贴到下方；无需在本地启动服务。链接 10 分钟有效。</p>
<form id="oauthStart"><label for="oauthMode">授权渠道</label><select id="oauthMode"><option value="antigravity">Antigravity</option></select>
<label for="oauthProject">项目 ID（可选，自动校验失败时使用）</label><input id="oauthProject" placeholder="project_id">
<label for="oauthName">凭证名称（可选）</label><input id="oauthName" maxlength="180"><button>生成 Google 授权链接</button></form>
<p id="oauthLinkArea" hidden><a id="oauthLink" target="_blank" rel="noopener noreferrer">打开 Google 授权页面</a></p>
</section><section class="card"><div class="step-label">02 · 完成授权并保存</div><h2>保存授权凭证</h2><form id="oauthComplete"><label for="callbackUrl">授权后的完整回调 URL</label><textarea id="callbackUrl" rows="3" placeholder="http://localhost:11451/?code=…&amp;state=…" required></textarea><button>交换令牌并保存凭证</button></form><small>令牌保存在 D1，不会直接显示。保存后可在凭证行下载 JSON。邮箱或项目查询失败时仍保留已获得的令牌。</small></section></div></div>`;
