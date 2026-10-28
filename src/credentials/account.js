import { HttpError, googleFetch, operation } from '../core/common.js';
import { accessToken, parseCredentialData } from './index.js';
import { upstreamOrigin, upstreamPayload } from '../upstream/index.js';

export async function credentialById(db, id) {
  const row = await operation('credential_read', () =>
    db.prepare('SELECT * FROM credentials WHERE id=?').bind(id).first(),
  );
  if (!row || row.mode !== 'antigravity') throw new HttpError(404, '凭证不存在');
  return { ...row, data: parseCredentialData(row.data) };
}
export async function saveData(db, row, changes) {
  const previous = JSON.stringify(row.data);
  const next = { ...row.data, ...changes };
  const result = await operation('credential_save', () =>
    db
      .prepare('UPDATE credentials SET data=? WHERE id=? AND data=?')
      .bind(JSON.stringify(next), row.id, previous)
      .run(),
  );
  if (result.meta?.changes === 0) throw new HttpError(409, '凭证刚被更新，请重试此操作');
  row.data = next;
}
export async function accountRequest(env, row, path, body, stage, fetcher = fetch) {
  let token = await operation('oauth_refresh', () => accessToken(env.DB, row, fetcher, false, env));
  const send = () =>
    googleFetch(
      fetcher,
      path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'antigravity/hub/2.23.1 darwin/arm64',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      },
      stage,
    );
  let response = await send();
  if (response.status === 401 && row.data.refresh_token) {
    await response.body?.cancel();
    token = await operation('oauth_refresh', () => accessToken(env.DB, row, fetcher, true, env));
    response = await send();
  }
  return response;
}
export async function googleJson(response, label) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      response.status >= 400 ? response.status : 502,
      `${label}失败 (HTTP ${response.status})，请检查账号权限、地区和凭证`,
    );
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new HttpError(502, `${label}返回了无效 JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(502, `${label}返回格式不正确`);
  return value;
}
export async function fetchEmail(env, row, fetcher) {
  const value = await googleJson(
    await accountRequest(
      env,
      row,
      'https://www.googleapis.com/oauth2/v2/userinfo',
      undefined,
      'email_fetch',
      fetcher,
    ),
    'Google 邮箱查询',
  );
  if (typeof value.email !== 'string' || !value.email.includes('@') || value.email.length > 320)
    throw new HttpError(502, 'Google 未返回邮箱，授权可能缺少 userinfo.email 权限');
  await saveData(env.DB, row, { user_email: value.email });
  return { success: true, user_email: value.email };
}
export async function verifyProject(env, row, fetcher, options = {}) {
  if (row.mode !== 'antigravity') throw new HttpError(400, '仅支持 Antigravity 凭证');
  let projectId;
  let tier = null;
  let credits = null;
  const value = await googleJson(
    await accountRequest(
      env,
      row,
      upstreamOrigin(env, row.mode) + '/v1internal:loadCodeAssist',
      { metadata: { ideType: 'ANTIGRAVITY' } },
      'project_verify',
      fetcher,
    ),
    'Google 项目校验',
  );
  const project = value.cloudaicompanionProject;
  projectId =
    typeof project === 'string' ? project : typeof project?.id === 'string' ? project.id : null;
  const rawTier = value.paidTier?.id || value.currentTier?.id;
  tier = typeof rawTier === 'string' ? rawTier : null;
  const rawCredits = value.paidTier?.availableCredits?.[0]?.creditAmount;
  credits =
    typeof rawCredits === 'string' || typeof rawCredits === 'number' ? String(rawCredits) : null;

  if (!projectId)
    throw new HttpError(
      400,
      '未获取到可用项目，账号可能尚未开通服务；可填写已知 project_id 后重新导入',
    );
  await saveData(env.DB, row, {
    project_id: projectId,
    subscription_tier: tier,
    credit_amount: credits,
  });
  return { success: true, project_id: projectId, subscription_tier: tier, credit_amount: credits };
}
export async function testCredential(env, row, model, fetcher) {
  model ||= 'gemini-2.5-flash';
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model))
    throw new HttpError(400, '测试模型名称无效');
  if (!row.data.project_id) throw new HttpError(400, '请先校验项目或补充 project_id');
  const payload = upstreamPayload(
    {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 1 },
    },
    model,
    row.data.project_id,
    row.mode,
  );
  const response = await accountRequest(
    env,
    row,
    upstreamOrigin(env, row.mode) + '/v1internal:generateContent',
    payload,
    'credential_test',
    fetcher,
  );
  const status = response.status;
  if (status === 200) await googleJson(response, '凭证测试');
  else if (status === 429) await response.body?.cancel();
  else await googleJson(response, '凭证测试');
  const result = {
    success: status === 200,
    limited: status === 429,
    upstream_status: status,
    model,
    tested_at: new Date().toISOString(),
  };
  await saveData(env.DB, row, { last_test: result });
  return result;
}
