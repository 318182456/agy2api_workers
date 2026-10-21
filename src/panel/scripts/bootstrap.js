export const bootstrapScript = String.raw`renderEndpoints();
run(async () => {
  status('正在检查登录状态…');
  const session = await api('/auth/session');
  if (session.authenticated) await openWorkspace();
  else status('请先登录管理页。');
});
`;
