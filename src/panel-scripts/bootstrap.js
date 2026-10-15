export const bootstrapScript = String.raw`el('openaiUrl').textContent = location.origin + '/v1';
el('antiUrl').textContent = location.origin + '/antigravity/v1';
el('geminiUrl').textContent = location.origin;
el('anthropicUrl').textContent = location.origin;
el('antiAnthropicUrl').textContent = location.origin + '/antigravity';
run(async () => {
  status('正在检查登录状态…');
  const session = await api('/auth/session');
  if (session.authenticated) await openWorkspace();
  else status('请先登录管理页。');
});
`;
