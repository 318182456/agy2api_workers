import { HttpError, googleFetch, modeValue } from './common.js';
import { oauthClient } from './credentials.js';
import { credentialById, fetchEmail, verifyProject, googleJson } from './account.js';

const redirectUri = 'http://localhost:11451';
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export async function startOAuth(request, env, body) {
  const mode = modeValue(body.mode || 'antigravity');
  const client = oauthClient(env, mode);
  const state = random();
  const verifier = random();
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const now = Date.now();
  await env.DB.prepare('DELETE FROM oauth_flows WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('INSERT INTO oauth_flows (state, origin, mode, name, project_id, verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(state, new URL(request.url).origin, mode, String(body.name || '').slice(0, 180), String(body.project_id || '').trim().slice(0, 200), verifier, now + 600000).run();
  const scopes = ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
  if (mode === 'antigravity') scopes.push('https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
    scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return { auth_url: url.href, expires_in: 600, redirect_uri: redirectUri };
}
export async function completeOAuth(request, env, body, fetcher) {
  let callback;
  try { callback = new URL(body.callback_url); } catch { throw new HttpError(400, '请粘贴授权后地址栏中的完整回调 URL'); }
  if (callback.origin !== redirectUri || callback.pathname !== '/' || callback.username || callback.password || callback.hash) throw new HttpError(400, '回调地址不匹配，应为 http://localhost:11451/?code=…&state=…');
  const params = callback.searchParams;
  if (params.has('error')) throw new HttpError(400, 'Google 授权未完成或已被拒绝，请重新授权');
  if (params.getAll('state').length !== 1 || params.getAll('code').length !== 1 || !params.get('state') || !params.get('code')) throw new HttpError(400, '回调必须包含唯一的 code 和 state');
  // Consume atomically before exchange: concurrent/replayed completions cannot exchange twice.
  const flow = await env.DB.prepare('DELETE FROM oauth_flows WHERE state=? AND origin=? AND expires_at>? RETURNING *')
    .bind(params.get('state'), new URL(request.url).origin, Date.now()).first();
  if (!flow) throw new HttpError(400, '授权流程不存在、已使用或已超过 10 分钟，请重新生成授权链接');
  const client = oauthClient(env, flow.mode);
  if (!client) throw new HttpError(400, '授权渠道无效');
  const response = await googleFetch(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...client, code: params.get('code'), code_verifier: flow.verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }) }, 'oauth_exchange');
  const token = await googleJson(response, 'Google 授权码交换');
  if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || !token.refresh_token) throw new HttpError(502, 'Google 未返回完整刷新凭证，请重新生成链接并确认授权');
  const seconds = Number(token.expires_in ?? 3600);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 31536000) throw new HttpError(502, 'Google 返回了无效的令牌有效期');
  const id = crypto.randomUUID();
  const name = `${flow.name || flow.mode + '-' + Date.now()}-${id.slice(0, 8)}.json`;
  const data = { ...client, token: token.access_token, refresh_token: token.refresh_token, project_id: flow.project_id,
    expiry: new Date(Date.now() + seconds * 1000).toISOString() };
  // Save tokens before enrichment: unavailable userinfo/project APIs must not lose authorization.
  await env.DB.prepare('INSERT INTO credentials (id, mode, name, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, flow.mode, name, JSON.stringify(data), Date.now()).run();
  const row = await credentialById(env.DB, id);
  const warnings = [];
  try { await fetchEmail(env, row, fetcher); } catch { warnings.push('邮箱未获取，可稍后点击“获取邮箱”重试'); }
  try { await verifyProject(env, row, fetcher); } catch { warnings.push('项目未自动校验，可稍后点击“校验项目”或补充 project_id'); }
  return { success: true, id, name, mode: row.mode, user_email: row.data.user_email || null, project_id: row.data.project_id || null, warnings };
}
