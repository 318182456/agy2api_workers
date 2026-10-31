import { equalSecret, HttpError, json, readJson } from '../core/common.js';
import { oidcEnabled } from '../auth/oidc.js';
import { checkOrigin, createSession, clearSession, hasSession } from '../auth/session.js';

export async function sessionRoute(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/auth/login' && request.method === 'POST') {
    if (!env.PANEL_PASSWORD) throw new HttpError(503, '请先配置 PANEL_PASSWORD Secret');
    checkOrigin(request);
    const body = await readJson(request);
    if (!(await equalSecret(body.password, env.PANEL_PASSWORD)))
      throw new HttpError(401, '密码错误');
    const response = json({ success: true });
    response.headers.set('set-cookie', await createSession(request, env.PANEL_PASSWORD));
    return response;
  }
  if (url.pathname === '/auth/session' && request.method === 'GET') {
    return json({
      authenticated: await hasSession(request, env.PANEL_PASSWORD),
      oidc_login: oidcEnabled(env) ? '/auth/oidc/start' : null,
    });
  }
  if (url.pathname === '/auth/logout' && request.method === 'POST') {
    checkOrigin(request);
    const response = json({ success: true });
    response.headers.set('set-cookie', clearSession(request));
    return response;
  }
  throw new HttpError(404, '登录接口不存在');
}
