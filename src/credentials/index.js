import { storageNodes } from '../storage/client.js';
import { bufferedHealth } from '../telemetry/live-health.js';
import { pendingTelemetry } from '../telemetry/client.js';
import { dbCache } from '../cache/db.js';
import { HttpError, modeValue, googleFetch, operation } from '../core/common.js';

export function oauthClients(env = {}) {
  return Object.fromEntries(
    ['geminicli', 'antigravity'].map((mode) => [
      mode,
      {
        client_id: env[mode.toUpperCase() + '_CLIENT_ID'] || '',
        client_secret: env[mode.toUpperCase() + '_CLIENT_SECRET'] || '',
      },
    ]),
  );
}

export function oauthClient(env, mode) {
  const client = oauthClients(env)[modeValue(mode)];
  if (!client.client_id || !client.client_secret)
    throw new HttpError(
      503,
      mode +
        ' 缺少 OAuth 配置，请设置 ' +
        mode.toUpperCase() +
        '_CLIENT_ID 和 ' +
        mode.toUpperCase() +
        '_CLIENT_SECRET',
    );
  return client;
}

export function parseCredentialData(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new HttpError(500, '保存的凭证 JSON 无效，请重新导入该凭证');
    error.errorCode = 'CREDENTIAL_DATA_INVALID';
    error.operation = 'credential_read';
    throw error;
  }
  return value;
}

export function detectedMode(data, env = {}) {
  for (const [mode, client] of Object.entries(oauthClients(env))) {
    if (client.client_id && data?.client_id === client.client_id) return mode;
  }
  return null;
}

export async function updateCredential(db, id, body, env = {}) {
  if (
    typeof body.disabled !== 'boolean' &&
    body.mode === undefined &&
    body.name === undefined &&
    body.priority === undefined &&
    body.weight === undefined
  )
    throw new HttpError(400, '需要 name、disabled、mode、priority 或 weight');
  if (
    body.name !== undefined &&
    (typeof body.name !== 'string' ||
      !body.name.trim() ||
      body.name.trim().length > 200 ||
      /[\x00-\x1f\x7f]/.test(body.name))
  )
    throw new HttpError(400, '名称须为 1–200 个字符，不能包含换行或控制字符');
  if (body.disabled !== undefined && typeof body.disabled !== 'boolean')
    throw new HttpError(400, 'disabled 必须为布尔值');
  for (const [key, min, max] of [
    ['priority', -100, 100],
    ['weight', 1, 100],
  ]) {
    if (
      body[key] !== undefined &&
      (!Number.isInteger(body[key]) || body[key] < min || body[key] > max)
    )
      throw new HttpError(400, key + ' 超出允许的整数范围');
  }
  const row = await db.prepare('SELECT * FROM credentials WHERE id=?').bind(id).first();
  if (!row) throw new HttpError(404, '凭证不存在');
  const mode = body.mode === undefined ? row.mode : modeValue(body.mode);
  const known = detectedMode(parseCredentialData(row.data), env);
  if (body.mode !== undefined && known && known !== mode)
    throw new HttpError(400, `凭证客户端属于 ${known}，不能改为 ${mode}`);
  const disabled = body.disabled === undefined ? row.disabled : Number(body.disabled);
  try {
    const extras = ['name', 'priority', 'weight'].filter((key) => body[key] !== undefined);
    const fields = extras.map((key) => ', ' + key + '=?').join('');
    const values = [
      mode,
      disabled,
      ...extras.map((key) => (key === 'name' ? body[key].trim() : body[key])),
      id,
    ];
    await db
      .prepare(`UPDATE credentials SET mode=?, disabled=?${fields} WHERE id=?`)
      .bind(...values)
      .run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message || ''))
      throw new HttpError(409, '该渠道已存在同名凭证，请使用其他名称或先处理重名');
    throw error;
  }
  return {
    success: true,
    mode,
    disabled: !!disabled,
    name: body.name === undefined ? row.name : body.name.trim(),
    priority: body.priority ?? row.priority,
    weight: body.weight ?? row.weight,
  };
}

export async function importCredential(db, body, env = {}) {
  const mode = modeValue(body.mode || 'geminicli');
  if (body.disabled !== undefined && typeof body.disabled !== 'boolean')
    throw new HttpError(400, 'disabled 必须为布尔值');
  for (const [key, min, max] of [
    ['priority', -100, 100],
    ['weight', 1, 100],
  ])
    if (
      body[key] !== undefined &&
      (!Number.isInteger(body[key]) || body[key] < min || body[key] > max)
    )
      throw new HttpError(400, key + ' 超出允许的整数范围');
  const data = body.credential;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new HttpError(400, '缺少 credential 对象');
  if (typeof data.project_id !== 'string' || !data.project_id.trim())
    throw new HttpError(400, '凭证必须包含 project_id');
  if (!data.refresh_token && !data.token && !data.access_token)
    throw new HttpError(400, '凭证缺少 refresh_token 或访问令牌');
  for (const key of [
    'refresh_token',
    'token',
    'access_token',
    'client_id',
    'client_secret',
    'expiry',
  ]) {
    if (data[key] !== undefined && typeof data[key] !== 'string')
      throw new HttpError(400, `${key} 必须为字符串`);
  }
  if (data.enable_credit !== undefined && typeof data.enable_credit !== 'boolean')
    throw new HttpError(400, 'enable_credit 必须为布尔值');
  const known = detectedMode(data, env);
  if (known && known !== mode)
    throw new HttpError(400, `凭证客户端属于 ${known}，请将导入渠道改为 ${known}`);
  const name = String(body.name || `${mode}-${crypto.randomUUID()}`).slice(0, 200);
  const id = crypto.randomUUID();
  // Persist known fields only. Never honor an imported token_uri (SSRF).
  const safe = { ...oauthClients(env)[mode], project_id: data.project_id.trim() };
  for (const key of [
    'refresh_token',
    'token',
    'access_token',
    'client_id',
    'client_secret',
    'expiry',
  ]) {
    if (data[key]) safe[key] = data[key];
  }
  if (typeof data.enable_credit === 'boolean') safe.enable_credit = data.enable_credit;
  if (
    typeof data.user_email === 'string' &&
    data.user_email.includes('@') &&
    data.user_email.length <= 320
  )
    safe.user_email = data.user_email;
  await db
    .prepare(
      `INSERT INTO credentials (id, mode, name, data, created_at, disabled, priority, weight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mode, name) DO UPDATE SET data=excluded.data,
    disabled=CASE WHEN ? THEN excluded.disabled ELSE credentials.disabled END,
    priority=CASE WHEN ? THEN excluded.priority ELSE credentials.priority END, weight=CASE WHEN ? THEN excluded.weight ELSE credentials.weight END`,
    )
    .bind(
      id,
      mode,
      name,
      JSON.stringify(safe),
      Date.now(),
      Number(body.disabled || false),
      body.priority ?? 0,
      body.weight ?? 1,
      Number(body.disabled !== undefined),
      Number(body.priority !== undefined),
      Number(body.weight !== undefined),
    )
    .run();
  return { success: true, name, mode };
}

export async function listCredentials(db, env = {}) {
  const result = await db
    .prepare(
      `SELECT id, mode, name, disabled, last_used, created_at, priority, weight, data, (SELECT last_success FROM credential_health WHERE credential_id=credentials.id) AS last_success, (SELECT created_at+duration_ms FROM request_usage WHERE credential_id=credentials.id AND outcome='success' ORDER BY created_at DESC LIMIT 1) AS observed_success, (SELECT json_extract(payload,'$.last_success') FROM usage_aggregates WHERE credential_id=credentials.id AND json_extract(payload,'$.last_success') IS NOT NULL ORDER BY json_extract(payload,'$.last_success') DESC LIMIT 1) AS aggregate_success, (SELECT last_failure FROM credential_health WHERE credential_id=credentials.id) AS last_failure, (SELECT last_status FROM credential_health WHERE credential_id=credentials.id) AS last_failure_status, (SELECT COUNT(*) FROM credential_cooldowns WHERE credential_id=credentials.id AND until_ms>strftime('%s','now')*1000) AS cooling_models FROM credentials ORDER BY created_at DESC`,
    )
    .all();
  const latest = new Map();
  const snapshot = await pendingTelemetry(env);
  const liveHealth = bufferedHealth(snapshot.buckets);
  for (const bucket of snapshot.buckets)
    latest.set(
      bucket.value.credential_id,
      Math.max(latest.get(bucket.value.credential_id) || 0, bucket.value.last_success || 0),
    );
  return result.results.map(({ data, observed_success, aggregate_success, ...row }) => {
    const credential = parseCredentialData(data);
    return {
      ...row,
      last_used: Math.max(row.last_used || 0, liveHealth.get(row.id)?.last_used || 0),
      last_failure:
        Math.max(row.last_failure || 0, liveHealth.get(row.id)?.last_failure || 0) || null,
      last_failure_status:
        (liveHealth.get(row.id)?.last_failure || 0) > (row.last_failure || 0)
          ? liveHealth.get(row.id).last_status
          : row.last_failure_status,
      last_success:
        Math.max(
          row.last_success || 0,
          observed_success || 0,
          aggregate_success || 0,
          latest.get(row.id) || 0,
        ) || null,
      detected_mode: detectedMode(credential, env),
      user_email: credential.user_email || null,
      project_id: credential.project_id || null,
      subscription_tier: credential.subscription_tier || null,
      credit_amount: credential.credit_amount ?? null,
      enable_credit: credential.enable_credit === true,
      preview_channel: credential.preview_channel || null,
      last_test: credential.last_test || null,
    };
  });
}

export async function selectCredential(
  db,
  mode,
  model = '',
  excluded = [],
  strategy = 'round_robin',
  routing = null,
  env = {},
) {
  const exclusions = excluded.length
    ? ` AND c.id NOT IN (${excluded.map(() => '?').join(',')})`
    : '';
  const unified = mode === 'auto';
  const channelPredicate = unified ? 'c.mode IN (SELECT value FROM json_each(?))' : 'c.mode=?';
  const quotaModel = unified ? "CASE c.mode WHEN 'geminicli' THEN ? ELSE ? END" : '?';
  const selectionValues = unified
    ? [
        JSON.stringify(routing?.modes || ['geminicli', 'antigravity']),
        routing?.models?.geminicli || model,
        routing?.models?.antigravity || model,
      ]
    : [mode, model];
  const eligible = `FROM credentials c WHERE ${channelPredicate} AND c.disabled=0
    AND NOT EXISTS (SELECT 1 FROM credential_cooldowns q WHERE q.credential_id=c.id AND q.model=${quotaModel} AND q.until_ms>?)${exclusions}`;
  const values = [...selectionValues, Date.now(), ...excluded];
  const scope = dbCache(db);
  scope.rotation ||= new Map();
  for (const [id, seen] of scope.rotation)
    if (seen.used < Date.now() - 600000) scope.rotation.delete(id);
  let row;
  if (strategy === 'weighted') {
    const candidates = (
      await db
        .prepare('SELECT c.id,c.weight ' + eligible)
        .bind(...values)
        .all()
    ).results;
    const id = weightedChoice(candidates);
    if (id)
      row = await db
        .prepare('SELECT c.* ' + eligible + ' AND c.id=?')
        .bind(...values, id)
        .first();
  } else {
    const entries = [...scope.rotation.entries()];
    const recent = entries.length
      ? 'CASE c.id ' + entries.map(() => 'WHEN ? THEN ?').join(' ') + ' ELSE c.last_used END'
      : 'c.last_used';
    for (const [id, seen] of entries) values.push(id, seen.used);
    const order = (strategy === 'priority' ? 'c.priority DESC,' : '') + recent + ',c.id';
    row = await db
      .prepare('SELECT c.* ' + eligible + ' ORDER BY ' + order + ' LIMIT 1')
      .bind(...values)
      .first();
  }
  if (!row) {
    const cooling = await db
      .prepare(
        `SELECT MIN(q.until_ms) AS earliest FROM credential_cooldowns q JOIN credentials c ON c.id=q.credential_id
      WHERE ${channelPredicate} AND c.disabled=0 AND q.model=${quotaModel} AND q.until_ms>?`,
      )
      .bind(...selectionValues, Date.now())
      .first();
    if (cooling?.earliest) {
      const error = new HttpError(429, `${mode} 当前模型的可用凭证正在冷却，请稍后重试或切换模型`);
      error.retryAfter = Math.max(1, Math.ceil((cooling.earliest - Date.now()) / 1000));
      throw error;
    }
    const base = mode === 'antigravity' ? '/antigravity/v1' : '/v1';
    throw new HttpError(
      503,
      unified
        ? '当前模型没有可用凭证，请检查账号启用状态、模型支持和额度冷却。'
        : `${mode} 渠道没有已启用的凭证。请检查管理页的渠道与启用状态；本次调用的 Base URL 应为 ${base}。Antigravity 凭证请通过 /antigravity/v1 调用。`,
    );
  }
  const now = Date.now();
  const recent = scope.rotation.get(row.id);
  const shouldSave = Math.max(row.last_used || 0, recent?.saved || 0) < now - 300000;
  if (scope.rotation.size >= 40) scope.rotation.delete(scope.rotation.keys().next().value);
  scope.rotation.set(row.id, {
    used: Math.max(now, (recent?.used || 0) + 1),
    saved: shouldSave ? now : Math.max(row.last_used || 0, recent?.saved || 0),
  });
  if (shouldSave && !(env.TELEMETRY && (await storageNodes(env)).length)) {
    try {
      await db
        .prepare('UPDATE credentials SET last_used=? WHERE id=? AND last_used<?')
        .bind(now, row.id, now - 300000)
        .run();
    } catch {
      console.warn(JSON.stringify({ event: 'rotation_snapshot_save_failed' }));
    }
  }
  return { ...row, data: parseCredentialData(row.data) };
}

export async function accessToken(db, row, fetcher = fetch, force = false, env = {}, signal) {
  const data = row.data;
  const token = data.token || data.access_token;
  const expiry = Date.parse(data.expiry);
  if (
    !force &&
    token &&
    (Number.isFinite(expiry) ? expiry > Date.now() + 180000 : !data.refresh_token)
  )
    return token;
  if (!data.refresh_token)
    throw new HttpError(401, '访问令牌过期，请重新导入包含 refresh_token 的凭证');
  const response = await googleFetch(
    fetcher,
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: data.client_id || oauthClients(env)[row.mode]?.client_id,
        client_secret: data.client_secret || oauthClients(env)[row.mode]?.client_secret,
        refresh_token: data.refresh_token,
        grant_type: 'refresh_token',
      }),
    },
    'oauth_refresh',
  );
  if (!response.ok) {
    let reason;
    try {
      reason = (await response.json())?.error;
    } catch {}
    if ([400, 401].includes(response.status) && reason === 'invalid_grant') {
      if (env.AUTO_DISABLE_INVALID_CREDENTIALS === true)
        await operation('credential_save', () =>
          db
            .prepare('UPDATE credentials SET disabled=1 WHERE id=? AND data=? AND disabled=0')
            .bind(row.id, JSON.stringify(data))
            .run(),
        );
      const error = new HttpError(
        401,
        'Google 刷新令牌已失效，请重新授权；启用自动停用时该凭证已停用',
      );
      error.operation = 'oauth_refresh';
      error.errorCode = 'OAUTH_REAUTH_REQUIRED';
      throw error;
    }
    throw new HttpError(
      502,
      `Google OAuth 刷新失败 (HTTP ${response.status})，请检查凭证和账号状态`,
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new HttpError(502, 'Google OAuth 刷新返回了无效 JSON');
  }
  if (!result || typeof result.access_token !== 'string' || !result.access_token)
    throw new HttpError(502, 'Google OAuth 未返回访问令牌');
  const previousData = JSON.stringify(data);
  data.token = result.access_token;
  const seconds = Number(result.expires_in ?? 3600);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 31536000)
    throw new HttpError(502, 'Google OAuth 返回了无效的令牌有效期');
  data.expiry = new Date(Date.now() + seconds * 1000).toISOString();
  if (result.refresh_token) data.refresh_token = result.refresh_token;
  // Avoid overwriting a credential that was re-imported while refresh was in flight.
  await operation('credential_save', () =>
    db
      .prepare('UPDATE credentials SET data=? WHERE id=? AND data=?')
      .bind(JSON.stringify(data), row.id, previousData)
      .run(),
  );
  return data.token;
}

// Weighted random selection; simultaneous calls remain best effort, like round robin.
export function weightedChoice(
  candidates,
  random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296,
) {
  if (!candidates.length) return null;
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let position = random() * total;
  for (const candidate of candidates) {
    position -= candidate.weight;
    if (position < 0) return candidate.id;
  }
  return candidates.at(-1).id;
}
