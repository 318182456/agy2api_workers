import {
  upstreamErrorBody,
  upstreamErrorMessage,
  serviceDisabled,
  putCooldown,
  recordAttempt,
} from '../upstream/reliability.js';
import { antigravityHeaders } from '../upstream/headers.js';
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
  const send = async () =>
    googleFetch(
      fetcher,
      path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: await antigravityHeaders(env, token, body?.model || ''),
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
function googleFailure(status, body, label, secrets) {
  const message = upstreamErrorMessage(body, secrets);
  const error = new HttpError(
    status,
    message
      ? label + '失败 (HTTP ' + status + ')：' + message
      : label + '失败 (HTTP ' + status + ')，请检查账号权限、地区和凭证',
  );
  if (serviceDisabled({ status }, body)) error.errorCode = 'ANTIGRAVITY_SERVICE_DISABLED';
  return error;
}
export async function googleJson(response, label, secrets = []) {
  if (!response.ok) {
    const body = await upstreamErrorBody(response);
    await response.body?.cancel();
    throw googleFailure(response.status >= 400 ? response.status : 502, body, label, secrets);
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new HttpError(502, label + '返回了无效 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(502, label + '返回格式不正确');
  const error = value.error || value.response?.error;
  if (error) {
    const code = Number(error.code);
    throw googleFailure(
      Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502,
      { error },
      label,
      secrets,
    );
  }
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
  if (
    options.model != null &&
    options.model !== '' &&
    (typeof options.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(options.model))
  )
    throw new HttpError(400, '验证模型名称无效');
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
  const result = {
    success: true,
    project_id: projectId,
    subscription_tier: tier,
    credit_amount: credits,
  };
  if (options.testGeneration === true) {
    const tested = await testCredential(env, row, options.model, fetcher);
    if (!tested.success) {
      const error = new HttpError(
        tested.upstream_status || 502,
        '项目资料已更新，但实际生成测试未通过；Google 当前限流或未返回有效生成结果',
      );
      error.operation = 'credential_test';
      throw error;
    }
    return { ...result, project_verified: true, generation_verified: true, model: tested.model };
  }
  return result;
}
export async function testCredential(env, row, model, fetcher) {
  if (!model) model = row.data.last_test?.model;
  if (!model) {
    const catalog = await googleJson(
      await accountRequest(
        env,
        row,
        upstreamOrigin(env, row.mode) + '/v1internal:fetchAvailableModels',
        {},
        'model_discovery',
        fetcher,
      ),
      '测试模型目录',
    );
    const ids =
      catalog.models && typeof catalog.models === 'object' && !Array.isArray(catalog.models)
        ? Object.keys(catalog.models).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))
        : [];
    const textModels = ids.filter(
      (id) => !/image|tts|audio|embedding|robotic|live|video|veo/i.test(id),
    );
    model =
      textModels.find((id) => /^gemini-/i.test(id) && /flash/i.test(id)) ||
      textModels.find((id) => /^claude-/i.test(id)) ||
      textModels.find((id) => /^gemini-/i.test(id)) ||
      textModels[0];
    if (!model) throw new HttpError(503, '目录中没有可自动选择的文本模型，请填写验证模型 ID');
  }
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(model))
    throw new HttpError(400, '测试模型名称无效');
  if (!row.data.project_id) throw new HttpError(400, '请先执行校验并测试或补充 project_id');
  const payload = upstreamPayload(
    {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 1 },
    },
    model,
    row.data.project_id,
    row.mode,
  );
  const started = Date.now();
  try {
    const response = await accountRequest(
      env,
      row,
      upstreamOrigin(env, row.mode) + '/v1internal:generateContent',
      payload,
      'credential_test',
      fetcher,
    );
    const status = response.status;
    if (status === 429) await response.body?.cancel();
    else {
      const value = await googleJson(response, '模型实际调用测试', [
        row.data.token,
        row.data.access_token,
        row.data.refresh_token,
        env.API_PASSWORD,
        env.PANEL_PASSWORD,
      ]);
      const candidates = (value.response || value).candidates;
      if (
        !Array.isArray(candidates) ||
        !candidates.some(
          (candidate) =>
            candidate &&
            typeof candidate === 'object' &&
            (/^(?:STOP|MAX_TOKENS)$/.test(candidate.finishReason || '') ||
              (!candidate.finishReason &&
                Array.isArray(candidate.content?.parts) &&
                candidate.content.parts.length)),
        )
      )
        throw new HttpError(502, '模型没有返回有效生成结果，不能确认生成权限可用');
    }
    const result = {
      success: status === 200,
      limited: status === 429,
      upstream_status: status,
      model,
      tested_at: new Date().toISOString(),
    };
    await saveData(env.DB, row, { last_test: result });
    if (result.success) {
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM credential_cooldowns WHERE credential_id=? AND model='*' AND status=403",
        ).bind(row.id),
        env.DB.prepare(
          'INSERT INTO credential_health(credential_id,last_success,failure_streak) SELECT id,?,0 FROM credentials WHERE id=? ON CONFLICT(credential_id) DO UPDATE SET last_success=MAX(COALESCE(last_success,0),excluded.last_success),failure_streak=CASE WHEN COALESCE(last_failure,0)<=excluded.last_success THEN 0 ELSE failure_streak END',
        ).bind(now, row.id),
      ]);
    }
    return result;
  } catch (error) {
    error.operation ||= 'credential_test';
    error.message = '模型 ' + model + '：' + error.message;
    if (error.errorCode === 'ANTIGRAVITY_SERVICE_DISABLED') {
      await putCooldown(env.DB, row, '*', 403, 86400);
      await recordAttempt(env.DB, {
        requestId: crypto.randomUUID(),
        row,
        mode: row.mode,
        model,
        status: 403,
        stage: 'credential_test',
        code: error.errorCode,
        started,
      });
    }
    try {
      await saveData(env.DB, row, {
        last_test: {
          success: false,
          limited: false,
          upstream_status: error.status || 502,
          model,
          tested_at: new Date().toISOString(),
        },
      });
    } catch {
      /* Preserve the actual test failure if the credential changed concurrently. */
    }
    throw error;
  }
}
