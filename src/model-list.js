import { readShared, publishShared } from './shared-cache.js';
import { dbCache } from './db-cache.js';
import { HttpError, modeValue, operation } from './common.js';
import { parseCredentialData } from './credentials.js';
import { accountRequest, googleJson } from './account.js';
import { upstreamOrigin } from './upstream.js';

function configuredModels(env, mode) {
  return [
    ...new Set(
      String((mode === 'antigravity' ? env.ANTIGRAVITY_MODELS : env.GEMINICLI_MODELS) || '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)),
    ),
  ];
}
export function parseModelList(value) {
  const models = value?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models))
    throw new HttpError(502, 'Google 未返回有效的模型列表');
  // Return upstream model IDs only, without inventing aliases or feature prefixes.
  return Object.keys(models)
    .filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))
    .sort();
}
export async function discoverModels(env, mode, fetcher, options = {}) {
  modeValue(mode);
  const fallback = configuredModels(env, mode);
  const queriedAt = new Date().toISOString();
  if (mode === 'geminicli')
    return {
      ids: fallback,
      source: 'vars',
      queriedAt,
      warning: 'GeminiCLI 暂未接入动态模型发现，当前使用 GEMINICLI_MODELS 配置',
    };
  if (!options.fresh && env.DB) {
    const local = dbCache(env.DB).models;
    if (local?.until > Date.now()) return { ...structuredClone(local.value), cache: 'memory' };
    const shared = await readShared(env, 'models:antigravity');
    const ids = shared?.value?.ids;
    if (
      Array.isArray(ids) &&
      ids.length &&
      ids.length <= 2000 &&
      ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))
    ) {
      const value = {
        ids,
        source: 'google',
        queriedAt: new Date(shared.created).toISOString(),
        warning: null,
        cache: 'kv',
      };
      dbCache(env.DB).models = { until: Math.min(shared.expires, Date.now() + 60000), value };
      return structuredClone(value);
    }
  }
  try {
    if (!env.DB) throw new HttpError(503, '未绑定 D1 数据库');
    // Discovery must not change credential rotation order or use disabled credentials.
    const stored = await operation('model_discovery', () =>
      env.DB.prepare(
        'SELECT * FROM credentials WHERE mode=? AND disabled=0 ORDER BY last_used, id LIMIT 1',
      )
        .bind(mode)
        .first(),
    );
    if (!stored) throw new HttpError(503, 'Antigravity 没有已启用的凭证，无法动态获取模型');
    const row = { ...stored, data: parseCredentialData(stored.data) };
    const response = await accountRequest(
      env,
      row,
      upstreamOrigin(env, mode) + '/v1internal:fetchAvailableModels',
      {},
      'model_discovery',
      fetcher,
    );
    const value = await googleJson(response, 'Google 模型列表查询');
    const result = { ids: parseModelList(value), source: 'google', queriedAt, warning: null };
    dbCache(env.DB).models = { until: Date.now() + 60000, value: structuredClone(result) };
    if (options.publish && result.ids.length)
      await publishShared(env, 'models:antigravity', { ids: result.ids }, 900);
    return result;
  } catch (error) {
    if (!fallback.length) throw error;
    return {
      ids: fallback,
      source: 'fallback',
      queriedAt,
      warning:
        error instanceof HttpError
          ? `动态查询失败，使用 ANTIGRAVITY_MODELS 备用配置：${error.message}`
          : '动态查询发生内部异常，使用 ANTIGRAVITY_MODELS 备用配置',
    };
  }
}
