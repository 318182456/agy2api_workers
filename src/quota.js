import { HttpError, googleFetch, operation } from './common.js';
import { accessToken, parseCredentialData } from './credentials.js';
import { upstreamOrigin } from './upstream.js';

export function normalizeQuota(value) {
  const source = value?.models;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new HttpError(502, 'Google 未返回有效的模型额度信息');
  }
  return Object.entries(source).map(([id, model]) => {
    const quota = model?.quotaInfo;
    const fraction = quota?.remainingFraction;
    // Missing, null and malformed values do not imply a zero balance.
    const remaining = typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
      ? fraction : null;
    const reset = quota?.resetTime;
    const resetTime = typeof reset === 'string' && Number.isFinite(Date.parse(reset)) ? reset : null;
    return { id, remaining, resetTime };
  });
}

export async function credentialQuota(env, id, fetcher = fetch) {
  const row = await operation('credential_read', () => env.DB.prepare('SELECT * FROM credentials WHERE id=?').bind(id).first());
  if (!row) throw new HttpError(404, '凭证不存在');
  if (row.mode !== 'antigravity') throw new HttpError(400, '额度查询仅支持 Antigravity 凭证，GeminiCLI 暂不支持');
  row.data = parseCredentialData(row.data);
  const origin = upstreamOrigin(env, row.mode);
  let token = await operation('oauth_refresh', () => accessToken(env.DB, row, fetcher, false, env));
  const signal = AbortSignal.timeout(30000);
  const send = () => googleFetch(fetcher, `${origin}/v1internal:fetchAvailableModels`, {
    method: 'POST', redirect: 'manual', signal,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'user-agent': 'antigravity/hub/2.23.1 darwin/arm64' },
    body: '{}',
  }, 'quota_fetch');
  let response;
  try {
    response = await send();
    if (response.status === 401 && row.data.refresh_token) {
      await response.body?.cancel();
      token = await accessToken(env.DB, row, fetcher, true, env);
      response = await send();
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Google 额度查询连接失败或超时，请稍后重试');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status >= 400 && response.status < 600 ? response.status : 502,
      `Google 额度查询失败 (HTTP ${response.status})，请检查账号资格、凭证和地区限制`);
  }
  let value;
  try { value = await response.json(); }
  catch { throw new HttpError(502, 'Google 额度接口返回了无效 JSON'); }
  if (value?.error) throw new HttpError(502, 'Google 额度接口返回了错误');
  return { success: true, credentialId: id, mode: row.mode, queriedAt: new Date().toISOString(), models: normalizeQuota(value) };
}
