import { storageNodes, readNodeCache, writeNodeCache } from '../storage/client.js';
import { readKvStatsSnapshot, statsCacheKey } from './stats-cache.js';
import { summarizeRows } from './rollup.js';
import { readStatsSnapshot, writeStatsSnapshot, STATS_CACHE_SECONDS } from './stats-cache.js';
import { pendingTelemetry, queryTelemetryStats } from './client.js';
import { HttpError } from '../core/common.js';
import { dbCache } from '../cache/db.js';
import { filters, credentialJoin, displayName } from './filters.js';

const metricKeys = [
  'requests',
  'successes',
  'failures',
  'cancellations',
  'total_duration_ms',
  'input_tokens',
  'output_tokens',
  'thought_tokens',
  'total_tokens',
  'token_reports',
];
const dimensions = ['credential_name', 'mode', 'model', 'status', 'outcome'];
const source = (detailWhere, aggregateWhere) => `WITH usage_source AS (
 SELECT r.credential_id,r.credential_name,r.mode,r.model,r.status,r.outcome,r.created_at,r.request_id,
  1 AS requests,(r.outcome='success') AS successes,(r.outcome='failed') AS failures,(r.outcome='cancelled') AS cancellations,r.duration_ms AS total_duration_ms,
  r.input_tokens,r.output_tokens,r.thought_tokens,r.total_tokens,(r.input_tokens IS NOT NULL OR r.output_tokens IS NOT NULL OR r.thought_tokens IS NOT NULL OR r.total_tokens IS NOT NULL) AS token_reports,r.api_key_id,r.api_key_name
 FROM request_usage r WHERE ${detailWhere} AND (r.aggregate_key IS NULL OR NOT EXISTS(SELECT 1 FROM usage_aggregates a,json_each(a.members) m WHERE a.bucket_key=r.aggregate_key AND m.value=r.request_id))
 AND (r.aggregate_key IS NULL OR r.request_id NOT IN(SELECT value FROM json_each(?)))
 UNION ALL
 SELECT a.credential_id,${dimensions.map((key) => "json_extract(a.payload,'$." + key + "')").join(',')},a.created_at,NULL,
 ${metricKeys.map((key) => "json_extract(a.payload,'$." + key + "')").join(',')},a.api_key_id,json_extract(a.payload,'$.api_key_name')
 FROM usage_aggregates a WHERE ${aggregateWhere} AND a.bucket_key NOT IN(SELECT value FROM json_each(?))
)`;
const aggregates = metricKeys.map((key) => 'SUM(u.' + key + ') AS ' + key).join(',');
export async function usageStats(db, params, env = {}) {
  const liveNodes =
    !env.INTERNAL_DO_STATS &&
    env.TELEMETRY &&
    env.USAGE_STORAGE_MODE !== 'detailed' &&
    (await storageNodes(env)).length > 0;
  if (liveNodes) {
    params = new URLSearchParams(params);
    params.set('fresh', '1');
  }
  const safe = new URLSearchParams(params);
  safe.delete('stage');
  safe.delete('before');
  safe.delete('fresh');
  safe.delete('sync');
  let apiKeyIds = null;
  if (safe.has('api_key_ids')) {
    apiKeyIds = safe.get('api_key_ids').split(',');
    if (
      !apiKeyIds.length ||
      apiKeyIds.length > 51 ||
      apiKeyIds.some((id) => !/^[a-f0-9-]{36}$/.test(id))
    )
      throw new HttpError(400, 'API 密钥列表无效，单次最多 51 个');
    apiKeyIds = [...new Set(apiKeyIds)].sort();
    safe.set('api_key_ids', apiKeyIds.join(','));
  }
  const key =
    (env.TELEMETRY ? (env.USAGE_STORAGE_MODE || 'aggregate') + ':' : 'detailed:') +
    [...safe.entries()]
      .sort()
      .map((entry) => JSON.stringify(entry))
      .join(',');
  const cache = dbCache(db);
  cache.stats ||= new Map();
  if (
    params.get('fresh') !== '1' &&
    params.get('sync') !== '1' &&
    cache.stats.get(key)?.until > Date.now()
  )
    return structuredClone(cache.stats.get(key).value);
  if (!env.INTERNAL_DO_STATS && params.get('fresh') !== '1' && params.get('sync') !== '1') {
    let shared = await readStatsSnapshot(env, key);
    if (!shared && env.TELEMETRY && env.USAGE_STORAGE_MODE !== 'detailed') {
      const remote = await readNodeCache(env, 'stats', key);
      const value = remote?.value;
      if (
        value?.query_source === 'durable-object' &&
        value.summary &&
        Array.isArray(value.api_keys) &&
        Number.isFinite(value.cached_at) &&
        value.cached_at <= Date.now() &&
        value.cached_at > Date.now() - STATS_CACHE_SECONDS * 1000
      )
        shared = {
          ...value,
          cache_source: 'storage-node',
          storage_node_name: remote.node_name,
          cache_seconds: STATS_CACHE_SECONDS,
        };
      shared ||= await readKvStatsSnapshot(env, key);
    }
    if (shared) {
      if (cache.stats.size >= 20) cache.stats.delete(cache.stats.keys().next().value);
      cache.stats.set(key, {
        until: Math.min(
          Date.now() + STATS_CACHE_SECONDS * 1000,
          shared.cached_at + (shared.cache_seconds || STATS_CACHE_SECONDS) * 1000,
        ),
        value: structuredClone(shared),
      });
      return shared;
    }
  }
  const flightKey = key + (params.get('sync') === '1' ? ':sync' : ':query');
  cache.statsFlights ||= new Map();
  if (cache.statsFlights.has(flightKey))
    return structuredClone(await cache.statsFlights.get(flightKey));
  const flight = calculate();
  cache.statsFlights.set(flightKey, flight);
  try {
    return structuredClone(await flight);
  } finally {
    if (cache.statsFlights.get(flightKey) === flight) cache.statsFlights.delete(flightKey);
  }
  async function calculate() {
    if (env.TELEMETRY && env.USAGE_STORAGE_MODE !== 'detailed' && !env.INTERNAL_DO_STATS) {
      const query = new URLSearchParams(params);
      query.set('cache_key', await statsCacheKey(env, key));
      const value = await queryTelemetryStats(env, query);
      value.live_nodes = liveNodes;
      if (cache.stats.size >= 20) cache.stats.delete(cache.stats.keys().next().value);
      cache.stats.set(key, {
        until: Date.now() + STATS_CACHE_SECONDS * 1000,
        value: structuredClone(value),
      });
      if (!liveNodes) {
        await writeStatsSnapshot(env, key, value);
        await writeNodeCache(
          env,
          'stats',
          key,
          value,
          value.cached_at + STATS_CACHE_SECONDS * 1000,
        );
      }
      return value;
    }
    if (!safe.has('from')) safe.set('from', String(Date.now() - 30 * 86400000));
    let { where, values } = filters(safe, 'u', false);
    const apiKeyId = safe.get('api_key_id');
    if (apiKeyId) {
      if (!/^[a-f0-9-]{36}$/.test(apiKeyId)) throw new HttpError(400, 'API 密钥 ID 无效');
      where += (where ? ' AND ' : ' WHERE ') + 'u.api_key_id=?';
      values.push(apiKeyId);
    }
    if (apiKeyIds) {
      where += (where ? ' AND ' : ' WHERE ') + 'u.api_key_id IN(SELECT value FROM json_each(?))';
      values.push(JSON.stringify(apiKeyIds));
    }
    values.push(Date.now() - 30 * 86400000);
    const snapshot = await pendingTelemetry(env);
    const pendingKeys = snapshot.buckets.map((bucket) => bucket.key),
      pendingIds = snapshot.buckets.flatMap((bucket) => bucket.members);
    // Push indexed time/key/account predicates into BOTH union branches before JSON expansion
    // and deduplication, rather than scanning every retained account and then filtering.
    const sourceFilters = (alias) => {
      const date = (key) =>
        /^\d+$/.test(safe.get(key) || '') ? Number(safe.get(key)) : Date.parse(safe.get(key));
      const predicates = [alias + '.created_at>=?'];
      const bindings = [Math.max(Date.now() - 30 * 86400000, date('from'))];
      if (safe.has('to')) {
        predicates.push(alias + '.created_at<=?');
        bindings.push(date('to'));
      }
      for (const [field, value] of [
        ['credential_id', safe.get('credential_id')],
        ['api_key_id', apiKeyId],
      ])
        if (value) {
          predicates.push(alias + '.' + field + '=?');
          bindings.push(value);
        }
      if (apiKeyIds) {
        predicates.push(alias + '.api_key_id IN(SELECT value FROM json_each(?))');
        bindings.push(JSON.stringify(apiKeyIds));
      }
      return { where: predicates.join(' AND '), values: bindings };
    };
    const detailFilter = sourceFilters('r'),
      aggregateFilter = sourceFilters('a');
    const sql =
      source(detailFilter.where, aggregateFilter.where) +
      ` SELECT u.api_key_id,MAX(u.api_key_name) AS api_key_name,u.credential_id,${displayName('u')} AS display_name,u.mode,u.model,
 strftime('%Y-%m-%d',u.created_at/1000,'unixepoch','+8 hours') AS day,${aggregates}
 FROM usage_source u` +
      credentialJoin('u') +
      where +
      (where ? ' AND ' : ' WHERE ') +
      'u.created_at>=? GROUP BY u.api_key_id,u.credential_id,u.mode,u.model,day';
    const rows = (
      await db
        .prepare(sql)
        .bind(
          ...detailFilter.values,
          JSON.stringify(pendingIds),
          ...aggregateFilter.values,
          JSON.stringify(pendingKeys),
          ...values,
        )
        .all()
    ).results;
    if (snapshot.buckets.length) {
      const ids = [
        ...new Set(snapshot.buckets.map((bucket) => bucket.value.credential_id).filter(Boolean)),
      ];
      const names = ids.length
        ? (
            await db
              .prepare(
                "SELECT id,name,CASE WHEN json_valid(data) THEN json_extract(data,'$.user_email') END AS email FROM credentials WHERE id IN(SELECT value FROM json_each(?))",
              )
              .bind(JSON.stringify(ids))
              .all()
          ).results
        : [];
      const lookup = new Map(names.map((row) => [row.id, row]));
      for (const bucket of snapshot.buckets) {
        const row = bucket.value,
          current = lookup.get(row.credential_id);
        const label = current?.email || current?.name || row.credential_name || '未选中凭证';
        if (safe.get('request_id')) continue;
        if (apiKeyId && row.api_key_id !== apiKeyId) continue;
        if (apiKeyIds && !apiKeyIds.includes(row.api_key_id)) continue;
        if (safe.get('credential_id') && row.credential_id !== safe.get('credential_id')) continue;
        if (safe.get('mode') && row.mode !== safe.get('mode')) continue;
        if (safe.get('model') && row.model !== safe.get('model')) continue;
        if (
          safe.get('email') &&
          !(current?.email || row.credential_name || '')
            .toLowerCase()
            .includes(safe.get('email').toLowerCase())
        )
          continue;
        const status = safe.get('status');
        if (
          status &&
          (status.endsWith('xx')
            ? Math.floor(row.status / 100) !== Number(status[0])
            : row.status !== Number(status))
        )
          continue;
        const time = (key) =>
          /^\d+$/.test(safe.get(key) || '') ? Number(safe.get(key)) : Date.parse(safe.get(key));
        if (
          row.created_at < Math.max(Date.now() - 30 * 86400000, time('from') || 0) ||
          (safe.has('to') && row.created_at > time('to'))
        )
          continue;
        rows.push({
          ...row,
          display_name: label,
          day: new Date(row.created_at + 8 * 3600000).toISOString().slice(0, 10),
        });
      }
    }
    const keyIds = [
      ...new Set(
        rows
          .map((row) => row.api_key_id)
          .filter((id) => id && id !== '00000000-0000-0000-0000-000000000000'),
      ),
    ];
    const keyNames = keyIds.length
      ? (
          await db
            .prepare('SELECT id,name FROM api_keys WHERE id IN(SELECT value FROM json_each(?))')
            .bind(JSON.stringify(keyIds))
            .all()
        ).results
      : [];
    const keyLookup = new Map(keyNames.map((row) => [row.id, row.name]));
    const value = summarizeRows(
      rows,
      keyLookup,
      env,
      snapshot.buckets.reduce((sum, bucket) => sum + bucket.value.requests, 0),
    );
    if (cache.stats.size >= 20) cache.stats.delete(cache.stats.keys().next().value);
    cache.stats.set(key, {
      until: Date.now() + STATS_CACHE_SECONDS * 1000,
      value: structuredClone(value),
    });
    if (!env.INTERNAL_DO_STATS) await writeStatsSnapshot(env, key, value);
    return value;
  }
}
