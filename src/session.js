import { authenticate, HttpError } from './common.js';

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
const key = (password) =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode('gcli-panel-session-v1\0' + password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
function cookieSettings(request) {
  const url = new URL(request.url);
  const local =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return {
    name: local ? 'gcli_session_dev' : '__Host-gcli_session',
    attributes: 'Path=/; HttpOnly; SameSite=Strict' + (local ? '' : '; Secure'),
  };
}
export function checkOrigin(request, required = false) {
  const origin = request.headers.get('origin');
  if ((required || origin) && origin !== new URL(request.url).origin)
    throw new HttpError(403, '管理操作必须来自同源页面');
}
export async function createSession(request, password, now = Date.now()) {
  const settings = cookieSettings(request);
  const issuedAt = Math.floor(now / 1000);
  const payload = base64url(
    encoder.encode(
      JSON.stringify({
        version: 1,
        audience: new URL(request.url).origin,
        issuedAt,
        expiresAt: issuedAt + SESSION_SECONDS,
        nonce: crypto.randomUUID(),
      }),
    ),
  );
  const signature = base64url(
    new Uint8Array(await crypto.subtle.sign('HMAC', await key(password), encoder.encode(payload))),
  );
  return `${settings.name}=${payload}.${signature}; ${settings.attributes}; Max-Age=${SESSION_SECONDS}`;
}
export function clearSession(request) {
  const settings = cookieSettings(request);
  return `${settings.name}=; ${settings.attributes}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
export async function hasSession(request, password, now = Date.now()) {
  if (!password) return false;
  const name = cookieSettings(request).name;
  const cookie = (request.headers.get('cookie') || '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(name + '='));
  if (!cookie || cookie.length > 2048) return false;
  try {
    const parts = cookie.slice(name.length + 1).split('.');
    if (parts.length !== 2) return false;
    const [payload, signature] = parts;
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        await key(password),
        decode(signature),
        encoder.encode(payload),
      ))
    )
      return false;
    const claim = JSON.parse(new TextDecoder().decode(decode(payload)));
    const timestamp = Math.floor(now / 1000);
    return (
      claim.version === 1 &&
      claim.audience === new URL(request.url).origin &&
      Number.isSafeInteger(claim.issuedAt) &&
      Number.isSafeInteger(claim.expiresAt) &&
      claim.issuedAt <= timestamp &&
      claim.expiresAt > timestamp &&
      claim.expiresAt - claim.issuedAt === SESSION_SECONDS
    );
  } catch {
    return false;
  }
}
export async function authenticatePanel(request, password) {
  // Preserve command-line Bearer authentication; a bad explicit key must not fall back to cookies.
  if (request.headers.has('authorization') || request.headers.has('x-goog-api-key'))
    return authenticate(request, password);
  if (!password) throw new HttpError(503, '请先配置 PANEL_PASSWORD Secret');
  if (!(await hasSession(request, password))) throw new HttpError(401, '登录已过期，请重新登录');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) checkOrigin(request, true);
}
