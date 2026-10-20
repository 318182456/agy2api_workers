import { boundedSeconds } from './timeouts.js';
import { readShared, publishShared } from './shared-cache.js';
import { dbCache } from './db-cache.js';
import { HttpError } from './common.js';
const booleanKeys = [
  'AUTO_DISABLE_INVALID_CREDENTIALS',
  'STABLE_SESSION',
  'RETURN_THOUGHTS',
  'ENABLE_AI_CREDITS',
  'FAKE_STREAMING',
];
const keys = [
  ...booleanKeys,
  'CONTINUATION_ATTEMPTS',
  'MAX_CREDENTIAL_ATTEMPTS',
  'UPSTREAM_TIMEOUT_SECONDS',
  'REQUEST_TIMEOUT_SECONDS',
  'ANTIGRAVITY_STREAM2NOSTREAM',
  'CREDENTIAL_SELECTION',
  'USAGE_STORAGE_MODE',
];
function defaults(env) {
  const attempts = Number(env.MAX_CREDENTIAL_ATTEMPTS ?? 3);
  return {
    ...Object.fromEntries(
      booleanKeys.map((key) => [
        key,
        env[key] == null
          ? ['AUTO_DISABLE_INVALID_CREDENTIALS', 'STABLE_SESSION', 'RETURN_THOUGHTS'].includes(key)
          : env[key] === true || env[key] === 'true',
      ]),
    ),
    CONTINUATION_ATTEMPTS: boundedSeconds(env.CONTINUATION_ATTEMPTS, 0, 0, 2),
    UPSTREAM_TIMEOUT_SECONDS: boundedSeconds(env.UPSTREAM_TIMEOUT_SECONDS, 45, 5, 90),
    REQUEST_TIMEOUT_SECONDS: boundedSeconds(env.REQUEST_TIMEOUT_SECONDS, 100, 10, 110),
    USAGE_STORAGE_MODE: env.USAGE_STORAGE_MODE === 'detailed' ? 'detailed' : 'aggregate',
    CREDENTIAL_SELECTION: ['round_robin', 'priority', 'weighted'].includes(env.CREDENTIAL_SELECTION)
      ? env.CREDENTIAL_SELECTION
      : 'round_robin',
    ANTIGRAVITY_STREAM2NOSTREAM:
      env.ANTIGRAVITY_STREAM2NOSTREAM == null ||
      env.ANTIGRAVITY_STREAM2NOSTREAM === '' ||
      env.ANTIGRAVITY_STREAM2NOSTREAM === true ||
      env.ANTIGRAVITY_STREAM2NOSTREAM === 'true',
    MAX_CREDENTIAL_ATTEMPTS: Number.isFinite(attempts)
      ? Math.min(5, Math.max(1, Math.floor(attempts)))
      : 3,
  };
}
export function validateSetting(key, value) {
  if (!keys.includes(key)) throw new HttpError(400, '不支持的配置项');
  if (value === null) return null;
  if (booleanKeys.includes(key)) {
    if (typeof value !== 'boolean') throw new HttpError(400, '开关必须为布尔值');
    return value;
  }
  if (key === 'CONTINUATION_ATTEMPTS') {
    if (!Number.isInteger(value) || value < 0 || value > 2)
      throw new HttpError(400, '续写次数须为 0–2');
    return value;
  }
  if (key === 'USAGE_STORAGE_MODE') {
    if (!['aggregate', 'detailed'].includes(value)) throw new HttpError(400, '用量存储模式无效');
    return value;
  }
  if (key === 'CREDENTIAL_SELECTION') {
    if (!['round_robin', 'priority', 'weighted'].includes(value))
      throw new HttpError(400, '凭证选择策略无效');
    return value;
  }
  if (key === 'ANTIGRAVITY_STREAM2NOSTREAM') {
    if (typeof value !== 'boolean') throw new HttpError(400, '流式汇总开关必须为布尔值');
    return value;
  }
  if (key === 'UPSTREAM_TIMEOUT_SECONDS' || key === 'REQUEST_TIMEOUT_SECONDS') {
    const min = key === 'UPSTREAM_TIMEOUT_SECONDS' ? 5 : 10;
    const max = key === 'UPSTREAM_TIMEOUT_SECONDS' ? 90 : 110;
    if (!Number.isInteger(value) || value < min || value > max)
      throw new HttpError(400, '超时须为 ' + min + '–' + max + ' 秒的整数');
    return value;
  }
  if (key === 'MAX_CREDENTIAL_ATTEMPTS') {
    if (!Number.isInteger(value) || value < 1 || value > 5)
      throw new HttpError(400, '尝试凭证数量必须是 1–5 的整数');
    return value;
  }
  throw new HttpError(400, '不支持的配置项');
}
export async function readSettings(env, cached = false) {
  const base = defaults(env);
  if (!env.DB) return { defaults: base, overrides: {}, effective: base };
  const scope = dbCache(env.DB);
  let overrides;
  if (cached && scope.settings?.until > Date.now())
    overrides = structuredClone(scope.settings.overrides);
  else {
    const shared = cached ? await readShared(env, 'settings') : null;
    if (shared?.value && typeof shared.value === 'object' && !Array.isArray(shared.value)) {
      try {
        overrides = {};
        for (const [key, value] of Object.entries(shared.value))
          if (keys.includes(key)) overrides[key] = validateSetting(key, value);
      } catch {
        overrides = null;
      }
    }
    if (!overrides) {
      const result = await env.DB.prepare('SELECT key, value FROM app_settings').all();
      overrides = {};
      for (const row of result.results)
        if (keys.includes(row.key))
          overrides[row.key] = validateSetting(row.key, JSON.parse(row.value));
    }
    scope.settings = { overrides: structuredClone(overrides), until: Date.now() + 30000 };
  }
  return { defaults: base, overrides, effective: { ...base, ...overrides } };
}
export async function effectiveEnv(env) {
  const settings = await readSettings(env, true);
  return { ...env, ...settings.effective };
}
export async function saveSettings(env, body) {
  if (!Object.keys(body).length) throw new HttpError(400, '没有配置项');
  const entries = Object.entries(body).map(([key, value]) => [key, validateSetting(key, value)]);
  const statements = entries.map(([key, value]) =>
    value === null
      ? env.DB.prepare('DELETE FROM app_settings WHERE key=?').bind(key)
      : env.DB.prepare(
          'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value IS NOT excluded.value',
        ).bind(key, JSON.stringify(value)),
  );
  await env.DB.batch(statements);
  delete dbCache(env.DB).settings;
  const result = await readSettings(env);
  await publishShared(env, 'settings', result.overrides, 7200);
  return result;
}

export async function warmSharedSettings(env) {
  if (!env.DB || !env.CACHE) return;
  const settings = await readSettings(env);
  await publishShared(env, 'settings', settings.overrides, 7200);
}
