import { HttpError, googleFetch, operation } from '../core/common.js';
import { accessToken, parseCredentialData } from './index.js';
import { upstreamOrigin, upstreamPayload } from '../upstream/index.js';

export async function credentialById(db, id) {
  const row = await operation('credential_read', () =>
    db.prepare('SELECT * FROM credentials WHERE id=?').bind(id).first(),
  );
  if (!row) throw new HttpError(404, '凭证不存在');
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
          'user-agent':
            row.mode === 'antigravity'
              ? 'antigravity/hub/2.23.1 darwin/arm64'
              : 'Google-Gemini-CLI/1.0',
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
  const suppliedProject = options?.project_id;
  if (
    suppliedProject !== undefined &&
    (row.mode !== 'geminicli' ||
      typeof suppliedProject !== 'string' ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(suppliedProject.trim()))
  )
    throw new HttpError(
      400,
      '请输入有效的 Google Cloud 项目 ID（6–30 位小写字母、数字或短横线），不是项目名称或数字编号',
    );
  const projectRequired = (message) => {
    const error = new HttpError(400, message);
    error.errorCode = 'PROJECT_REQUIRED';
    error.operation = 'project_verify';
    return error;
  };
  let projectId;
  let tier = null;
  let credits = null;
  if (row.mode === 'antigravity') {
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
  } else {
    const origin = upstreamOrigin(env, row.mode);
    const metadata = {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    };
    const knownProject =
      suppliedProject?.trim() ||
      (typeof row.data.project_id === 'string' ? row.data.project_id.trim() : '');
    const readProject = (value) =>
      typeof value === 'string'
        ? value.trim()
        : typeof value?.id === 'string'
          ? value.id.trim()
          : '';
    const pending = row.data.project_verification_operation;
    let onboarding;
    if (pending) {
      if (suppliedProject !== undefined)
        throw new HttpError(
          409,
          '项目开通仍在处理中，请先点击“校验项目”查询已有任务，完成后再更换项目',
        );
      if (
        typeof pending !== 'string' ||
        !/^operations\/[A-Za-z0-9_/-]{1,250}$/.test(pending) ||
        pending.includes('..')
      )
        throw new HttpError(400, '项目开通任务格式无效，请重新导入凭证');
      onboarding = await googleJson(
        await accountRequest(
          env,
          row,
          origin + '/v1internal/' + pending,
          undefined,
          'project_verify',
          fetcher,
        ),
        'Google 项目开通状态查询',
      );
      tier = row.data.subscription_tier || null;
    } else {
      const value = await googleJson(
        await accountRequest(
          env,
          row,
          origin + '/v1internal:loadCodeAssist',
          {
            ...(knownProject ? { cloudaicompanionProject: knownProject } : {}),
            metadata: { ...metadata, ...(knownProject ? { duetProject: knownProject } : {}) },
          },
          'project_verify',
          fetcher,
        ),
        'Google GeminiCLI 项目校验',
      );
      if (value.error) throw new HttpError(502, 'Google 项目校验返回错误，未保存项目');
      const rawTier = value.paidTier?.id || value.currentTier?.id;
      tier = typeof rawTier === 'string' ? rawTier : null;
      projectId = readProject(value.cloudaicompanionProject);
      if (!projectId && value.currentTier) {
        if (knownProject) projectId = knownProject;
        else
          throw projectRequired(
            'Google 未返回已开通账号的 GeminiCLI 项目，请填写该账号有权限使用的 Google Cloud 项目 ID',
          );
      }
      if (!projectId) {
        if (value.ineligibleTiers?.some((item) => item?.reasonCode === 'VALIDATION_REQUIRED'))
          throw new HttpError(
            400,
            'Google 要求先完成账号验证，请使用官方 GeminiCLI 登录并按提示验证后重试',
          );
        const selected = Array.isArray(value.allowedTiers)
          ? value.allowedTiers.find((item) => item?.isDefault && typeof item.id === 'string')
          : null;
        if (!selected) {
          const validation = value.ineligibleTiers?.some(
            (item) => item?.reasonCode === 'VALIDATION_REQUIRED',
          );
          throw new HttpError(
            400,
            validation
              ? 'Google 要求先完成账号验证，请使用官方 GeminiCLI 登录并按提示验证后重试'
              : '此账号尚未获得 GeminiCLI 服务资格，Google 未返回可开通的等级',
          );
        }
        const free = selected.id === 'free-tier';
        if (!free && selected.userDefinedCloudaicompanionProject === true && !knownProject)
          throw projectRequired(
            'Google 明确要求此等级（' +
              selected.id +
              '）使用自有 Cloud 项目，请在下方填写项目 ID 后校验',
          );
        tier = selected.id;
        onboarding = await googleJson(
          await accountRequest(
            env,
            row,
            origin + '/v1internal:onboardUser',
            {
              tierId: tier,
              ...(!free && knownProject ? { cloudaicompanionProject: knownProject } : {}),
              metadata: {
                ...metadata,
                ...(!free && knownProject ? { duetProject: knownProject } : {}),
              },
            },
            'project_verify',
            fetcher,
          ),
          'Google GeminiCLI 服务开通',
        );
      }
    }
    if (onboarding) {
      if (onboarding.error) {
        if (pending) await saveData(env.DB, row, { project_verification_operation: null });
        throw new HttpError(400, 'Google GeminiCLI 服务开通失败，请在官方 CLI 确认账号资格后重试');
      }
      if (!onboarding.done) {
        const name = onboarding.name || pending;
        if (
          typeof name !== 'string' ||
          !/^operations\/[A-Za-z0-9_/-]{1,250}$/.test(name) ||
          name.includes('..')
        )
          throw new HttpError(502, 'Google 未返回有效的项目开通任务');
        if (name !== pending)
          await saveData(env.DB, row, {
            project_verification_operation: name,
            subscription_tier: tier,
          });
        throw new HttpError(
          409,
          'Google 正在开通 GeminiCLI 项目，请稍后再次点击“校验项目”查看结果',
        );
      }
      projectId = readProject(onboarding.response?.cloudaicompanionProject) || knownProject;
    }
  }
  if (!projectId)
    throw new HttpError(
      400,
      '未获取到可用项目，账号可能尚未开通服务；可填写已知 project_id 后重新导入',
    );
  await saveData(env.DB, row, {
    project_id: projectId,
    ...(row.mode === 'geminicli' ? { project_verification_operation: null } : {}),
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
