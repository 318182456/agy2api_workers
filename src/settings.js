import { dbCache } from './db-cache.js';
import { HttpError } from './common.js';
const keys = ['GEMINICLI_MODELS', 'ANTIGRAVITY_MODELS', 'MAX_CREDENTIAL_ATTEMPTS', 'ANTIGRAVITY_STREAM2NOSTREAM', 'CREDENTIAL_SELECTION'];
function defaults(env) {
  const attempts = Number(env.MAX_CREDENTIAL_ATTEMPTS ?? 3);
  return { CREDENTIAL_SELECTION: ['round_robin','priority','weighted'].includes(env.CREDENTIAL_SELECTION) ? env.CREDENTIAL_SELECTION : 'round_robin', ANTIGRAVITY_STREAM2NOSTREAM: env.ANTIGRAVITY_STREAM2NOSTREAM === true || env.ANTIGRAVITY_STREAM2NOSTREAM === 'true', GEMINICLI_MODELS: String(env.GEMINICLI_MODELS || ''), ANTIGRAVITY_MODELS: String(env.ANTIGRAVITY_MODELS || ''),
    MAX_CREDENTIAL_ATTEMPTS: Number.isFinite(attempts) ? Math.min(5, Math.max(1, Math.floor(attempts))) : 3 };
}
export function validateSetting(key, value) {
  if (!keys.includes(key)) throw new HttpError(400, '不支持的配置项');
  if (value === null) return null;
  if (key === 'CREDENTIAL_SELECTION') {
    if (!['round_robin','priority','weighted'].includes(value)) throw new HttpError(400, '凭证选择策略无效');
    return value;
  }
  if (key === 'ANTIGRAVITY_STREAM2NOSTREAM') {
    if (typeof value !== 'boolean') throw new HttpError(400, '流式汇总开关必须为布尔值');
    return value;
  }
  if (key === 'MAX_CREDENTIAL_ATTEMPTS') {
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new HttpError(400, '尝试凭证数量必须是 1–5 的整数');
    return value;
  }
  if (typeof value !== 'string' || value.length > 20000) throw new HttpError(400, '模型列表必须是英文逗号分隔的字符串');
  const ids = [...new Set(value.split(',').map(id => id.trim()).filter(Boolean))];
  if (ids.length > 200 || ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))) throw new HttpError(400, '模型列表最多 200 个，模型 ID 格式无效');
  return ids.join(',');
}
export async function readSettings(env, cached = false) {
  const base = defaults(env);
  if (!env.DB) return { defaults: base, overrides: {}, effective: base };
  const scope=dbCache(env.DB);
  let overrides;
  if(cached && scope.settings?.until>Date.now()) overrides=structuredClone(scope.settings.overrides);
  else {
    const result=await env.DB.prepare('SELECT key, value FROM app_settings').all(); overrides={};
    for(const row of result.results) if(keys.includes(row.key)) overrides[row.key]=validateSetting(row.key,JSON.parse(row.value));
    scope.settings={overrides:structuredClone(overrides),until:Date.now()+30000};
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
  const statements = entries.map(([key, value]) => value === null
    ? env.DB.prepare('DELETE FROM app_settings WHERE key=?').bind(key)
    : env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value IS NOT excluded.value').bind(key, JSON.stringify(value)));
  await env.DB.batch(statements);
  delete dbCache(env.DB).settings;
  return readSettings(env);
}
