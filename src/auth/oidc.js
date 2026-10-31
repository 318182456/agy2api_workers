import { createLocalJWKSet, jwtVerify } from 'jose';
import { HttpError, equalSecret } from '../core/common.js';
import { createSession } from './session.js';

const encoder = new TextEncoder();
const transactionCookie = '__Host-gcli_oidc';
const ttl = 600;
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const cookie = (value, age = ttl) =>
  `${transactionCookie}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const fail = () => new HttpError(401, '统一登录失败，请重新开始登录');
export const oidcEnabled = (env) => Boolean(env.OIDC_ISSUER);

function config(request, env) {
  if (!oidcEnabled(env)) throw new HttpError(404, '未启用统一登录');
  try {
    const issuer = new URL(env.OIDC_ISSUER);
    const callback = new URL(env.OIDC_REDIRECT_URI);
    const users = String(env.OIDC_ALLOWED_USERS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      issuer.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      callback.protocol !== 'https:' ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      callback.pathname !== '/auth/oidc/callback' ||
      callback.origin !== new URL(request.url).origin ||
      !env.OIDC_CLIENT_ID ||
      !env.OIDC_CLIENT_SECRET ||
      !env.PANEL_PASSWORD ||
      !users.length
    )
      throw Error();
    return { issuer: issuer.href.replace(/\/$/, ''), callback: callback.href, users };
  } catch {
    throw new HttpError(503, '统一登录配置不完整或访问域名不匹配');
  }
}
function endpoint(value, issuer) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.origin !== new URL(issuer).origin ||
    url.username ||
    url.password ||
    url.hash
  )
    throw fail();
  return url.href;
}
async function getJSON(fetcher, url, options = {}) {
  try {
    const response = await fetcher(url, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw fail();
    const text = await response.text();
    if (text.length > 1000000) throw fail();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(
      JSON.stringify({
        event: 'oidc_provider_failed',
        endpoint: new URL(url).pathname,
        errorType: error?.name || 'Error',
      }),
    );
    throw new HttpError(502, '暂时无法连接统一登录服务，请稍后重试');
  }
}
async function discovery(c, fetcher) {
  const metadata = await getJSON(fetcher, c.issuer + '/.well-known/openid-configuration');
  if (
    metadata.issuer !== c.issuer ||
    !metadata.code_challenge_methods_supported?.includes('S256') ||
    !metadata.token_endpoint_auth_methods_supported?.includes('client_secret_post')
  )
    throw fail();
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint'])
    metadata[key] = endpoint(metadata[key], c.issuer);
  return metadata;
}
async function transactionKey(env) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode('gcli-oidc-transaction-v1\0' + env.PANEL_PASSWORD),
  );
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(transactionCookie) },
      await transactionKey(env),
      encoder.encode(JSON.stringify(value)),
    ),
  );
  return base64url(iv) + '.' + base64url(data);
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw fail();
  const decoded = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (v) =>
    v.charCodeAt(0),
  );
  if (base64url(decoded) !== value) throw fail();
  return decoded;
}
async function unseal(value, env) {
  if (!value || value.length > 6000) throw fail();
  const parts = value.split('.');
  if (parts.length !== 2) throw fail();
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(parts[0]), additionalData: encoder.encode(transactionCookie) },
    await transactionKey(env),
    decode(parts[1]),
  );
  return JSON.parse(new TextDecoder().decode(data));
}
function transaction(request) {
  return (request.headers.get('cookie') || '')
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(transactionCookie + '='))
    ?.slice(transactionCookie.length + 1);
}
function redirect(location, cookies = []) {
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
}
function localReturn(value) {
  return typeof value === 'string' && /^\/panel(?:\/[a-z-]+)?$/.test(value)
    ? value
    : '/panel/overview';
}
export async function oidcRoute(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (request.method !== 'GET') throw new HttpError(405, '仅支持 GET');
  const c = config(request, env);
  if (url.pathname === '/auth/oidc/start') {
    const metadata = await discovery(c, fetcher);
    const state = random(),
      nonce = random(),
      verifier = random();
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))),
    );
    const target = new URL(metadata.authorization_endpoint);
    target.search = new URLSearchParams({
      client_id: env.OIDC_CLIENT_ID,
      redirect_uri: c.callback,
      response_type: 'code',
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    const pending = await seal(
      {
        state,
        nonce,
        verifier,
        origin: url.origin,
        issuer: c.issuer,
        client: env.OIDC_CLIENT_ID,
        issued: Date.now(),
        returnTo: localReturn(url.searchParams.get('returnTo')),
      },
      env,
    );
    return redirect(target.href, [cookie(pending)]);
  }
  if (url.pathname !== '/auth/oidc/callback') throw new HttpError(404, '登录接口不存在');
  try {
    for (const name of ['code', 'state'])
      if (url.searchParams.getAll(name).length !== 1 || !url.searchParams.get(name)) throw fail();
    if (url.searchParams.has('error')) throw fail();
    const pending = await unseal(transaction(request), env);
    if (
      pending.origin !== url.origin ||
      pending.issuer !== c.issuer ||
      pending.client !== env.OIDC_CLIENT_ID ||
      !Number.isFinite(pending.issued) ||
      Date.now() - pending.issued > ttl * 1000 ||
      pending.issued > Date.now() + 30000 ||
      !(await equalSecret(url.searchParams.get('state'), pending.state))
    )
      throw fail();
    const metadata = await discovery(c, fetcher);
    const tokens = await getJSON(fetcher, metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: url.searchParams.get('code'),
        redirect_uri: c.callback,
        client_id: env.OIDC_CLIENT_ID,
        client_secret: env.OIDC_CLIENT_SECRET,
        code_verifier: pending.verifier,
      }).toString(),
    });
    if (
      !tokens.id_token ||
      !tokens.access_token ||
      String(tokens.token_type).toLowerCase() !== 'bearer'
    )
      throw fail();
    const jwks = await getJSON(fetcher, metadata.jwks_uri);
    const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: c.issuer,
      audience: env.OIDC_CLIENT_ID,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
      maxTokenAge: '10m',
      clockTolerance: 30,
    });
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      !(await equalSecret(payload.nonce, pending.nonce)) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== env.OIDC_CLIENT_ID) ||
      (payload.azp && payload.azp !== env.OIDC_CLIENT_ID)
    )
      throw fail();
    if (payload.at_hash) {
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', encoder.encode(tokens.access_token)),
      );
      if (!(await equalSecret(payload.at_hash, base64url(digest.slice(0, digest.length / 2)))))
        throw fail();
    }
    const user = await getJSON(fetcher, metadata.userinfo_endpoint, {
      headers: { authorization: 'Bearer ' + tokens.access_token },
    });
    if (
      user.sub !== payload.sub ||
      typeof user.preferred_username !== 'string' ||
      !c.users.includes(user.preferred_username)
    )
      throw new HttpError(403, '此统一登录账号没有管理权限');
    const session = (await createSession(request, env.PANEL_PASSWORD)).replace(
      'SameSite=Strict',
      'SameSite=Lax',
    );
    return redirect(localReturn(pending.returnTo), [session, cookie('', 0)]);
  } catch (error) {
    const status = error instanceof HttpError && error.status === 403 ? 403 : 401;
    return new Response(
      status === 403 ? '此统一登录账号没有管理权限' : '统一登录失败，请重新打开管理页面登录。',
      {
        status,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'set-cookie': cookie('', 0),
        },
      },
    );
  }
}
