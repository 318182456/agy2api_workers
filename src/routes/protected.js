import { authenticatePanel } from '../auth/session.js';
import { equalSecret, HttpError } from '../core/common.js';
const encoder = new TextEncoder();
export async function panelCsrf(request, password) {
  if (!password) throw new HttpError(503, '请配置管理密码');
  const cookie = (request.headers.get('cookie') || '')
    .split(';')
    .map((v) => v.trim())
    .find((v) => /^(?:__Host-gcli_session|gcli_session_dev)=/.test(v));
  if (!cookie) return '';
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode('panel-csrf-v1:' + cookie)),
    ),
  )
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
// New admin contracts are denied unless their declared method and access chain pass.
export function protectedAdmin(entries) {
  for (const entry of entries)
    if (!['protected-read', 'protected-browser-mutation'].includes(entry.access))
      throw new Error('Unclassified admin endpoint');
  return async (request, env, fetcher) => {
    const path = new URL(request.url).pathname;
    const entry = entries.find((e) => e.path === path && e.method === request.method);
    if (!entry) throw new HttpError(405, '请求方法不支持');
    const mutation = entry.access === 'protected-browser-mutation';
    const service = request.headers.has('authorization') || request.headers.has('x-goog-api-key');
    if (mutation) {
      const origin = request.headers.get('origin');
      if (
        (origin && origin !== new URL(request.url).origin) ||
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (!service && !origin)
      )
        throw new HttpError(403, '管理操作必须来自同源页面');
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || ''))
        throw new HttpError(415, '请使用 application/json');
    }
    await authenticatePanel(request, env.PANEL_PASSWORD);
    if (
      mutation &&
      !service &&
      !(await equalSecret(
        request.headers.get('x-csrf-token'),
        await panelCsrf(request, env.PANEL_PASSWORD),
      ))
    )
      throw new HttpError(403, '页面校验已过期，请重新加载');
    return entry.handle(request, env, fetcher);
  };
}
