import { refreshOfficialModels } from './official.js';
import { readShared, publishShared } from '../cache/shared.js';
import { dbCache } from '../cache/db.js';
import { HttpError, modeValue, operation } from '../core/common.js';
import { parseCredentialData } from '../credentials/index.js';
import { accountRequest, googleJson } from '../credentials/account.js';
import { upstreamOrigin } from '../upstream/index.js';

import { modelCatalog, validModelId as validId, validRoutes } from './names.js';
export function parseModelList(value) {
  const models = value?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models))
    throw new HttpError(502, 'Google 未返回有效的模型列表');
  return Object.keys(models).filter(validId).sort();
}
export function parseCliModels(value) {
  if (!Array.isArray(value?.buckets))
    throw new HttpError(502, 'Google 未返回有效的 GeminiCLI 配额信息');
  return [
    ...new Set(
      value.buckets
        .map((bucket) => bucket?.modelId)
        .filter((id) => validId(id) && id.startsWith('gemini-')),
    ),
  ].sort();
}
export async function discoverModels(env, mode, fetcher, options = {}) {
  modeValue(mode);
  if (!env.DB) throw new HttpError(503, '未绑定 D1 数据库，无法动态获取模型');
  const cacheKey = mode === 'antigravity' ? 'models' : 'cliModels',
    scope = dbCache(env.DB);
  const source = mode === 'antigravity' ? 'google' : 'quota';
  if (!options.fresh) {
    const local = scope[cacheKey];
    if (local?.until > Date.now()) return { ...structuredClone(local.value), cache: 'memory' };
    const shared = await readShared(env, 'models:' + mode),
      ids = shared?.value?.ids;
    if (
      Array.isArray(ids) &&
      ids.length &&
      ids.length <= 2000 &&
      ids.every(validId) &&
      shared.created > Date.now() - 900000
    ) {
      const value = {
        ids,
        routes: validRoutes(ids, shared.value.routes)
          ? shared.value.routes
          : Object.fromEntries(ids.map((id) => [id, id])),
        source,
        queriedAt: new Date(shared.created).toISOString(),
        warning: null,
        cache: 'kv',
      };
      scope[cacheKey] = { until: Math.min(shared.expires, Date.now() + 60000), value };
      return structuredClone(value);
    }
  }
  try {
    const stored = await operation('model_discovery', () =>
      env.DB.prepare(
        'SELECT * FROM credentials WHERE mode=? AND disabled=0 ORDER BY last_used, id LIMIT 1',
      )
        .bind(mode)
        .first(),
    );
    if (!stored) throw new HttpError(503, mode + ' 没有已启用的凭证，无法动态获取模型');
    const row = { ...stored, data: parseCredentialData(stored.data) };
    const cli = mode === 'geminicli';
    if (cli && !row.data.project_id)
      throw new HttpError(400, 'GeminiCLI 凭证缺少 project_id，请先校验项目');
    const response = await accountRequest(
      env,
      row,
      upstreamOrigin(env, mode) +
        '/v1internal:' +
        (cli ? 'retrieveUserQuota' : 'fetchAvailableModels'),
      cli ? { project: row.data.project_id } : {},
      'model_discovery',
      fetcher,
    );
    const data = await googleJson(response, 'Google 模型列表查询');
    const rawIds = cli ? parseCliModels(data) : parseModelList(data);
    const catalog = modelCatalog(rawIds.map((id) => [id, cli ? null : data.models[id]]));
    const ids = catalog.ids;
    const reference = await refreshOfficialModels(env, rawIds, fetcher);
    const officialIds = new Set(reference?.ids || []);
    const value = {
      ...catalog,
      reference: reference
        ? {
            source: reference.source,
            queriedAt: reference.queriedAt,
            error: reference.error,
            matched: ids.filter((id) => officialIds.has(id)).length,
          }
        : null,
      source,
      queriedAt: new Date().toISOString(),
      warning: cli
        ? 'GeminiCLI 列表来自 Google 配额中的模型 ID，可能不是完整可用模型清单；未返回的模型仍可由客户端显式指定。'
        : null,
    };
    scope[cacheKey] = { until: Date.now() + 60000, value: structuredClone(value) };
    if (ids.length) {
      await publishShared(env, 'models:' + mode, catalog, 900);
      await publishShared(env, 'model-names:' + mode, catalog, 86400);
    }
    return value;
  } catch (error) {
    const previous = scope[cacheKey]?.value;
    if (previous?.ids?.length && Date.parse(previous.queriedAt) > Date.now() - 86400000)
      return {
        ...structuredClone(previous),
        source: 'cache',
        warning: '实时查询失败，展示最近一次动态发现的模型，可能已过期；不代表当前凭证一定可用。',
      };
    throw error;
  }
}
