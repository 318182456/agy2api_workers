import { pendingTelemetry } from './client.js';
import { HttpError } from '../common.js';
import { dbCache } from '../db-cache.js';
import { filters, credentialJoin, displayName } from '../filters.js';

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
const source = `WITH usage_source AS (
 SELECT r.credential_id,r.credential_name,r.mode,r.model,r.status,r.outcome,r.created_at,r.request_id,
  1 AS requests,(r.outcome='success') AS successes,(r.outcome='failed') AS failures,(r.outcome='cancelled') AS cancellations,r.duration_ms AS total_duration_ms,
  r.input_tokens,r.output_tokens,r.thought_tokens,r.total_tokens,(r.input_tokens IS NOT NULL OR r.output_tokens IS NOT NULL OR r.thought_tokens IS NOT NULL OR r.total_tokens IS NOT NULL) AS token_reports,r.api_key_id,r.api_key_name
 FROM request_usage r WHERE (r.aggregate_key IS NULL OR NOT EXISTS(SELECT 1 FROM usage_aggregates a,json_each(a.members) m WHERE a.bucket_key=r.aggregate_key AND m.value=r.request_id))
 AND (r.aggregate_key IS NULL OR r.request_id NOT IN(SELECT value FROM json_each(?)))
 UNION ALL
 SELECT a.credential_id,${dimensions.map((key) => "json_extract(a.payload,'$." + key + "')").join(',')},a.created_at,NULL,
 ${metricKeys.map((key) => "json_extract(a.payload,'$." + key + "')").join(',')},a.api_key_id,json_extract(a.payload,'$.api_key_name')
 FROM usage_aggregates a WHERE a.bucket_key NOT IN(SELECT value FROM json_each(?))
)`;
const aggregates = metricKeys.map((key) => 'SUM(u.' + key + ') AS ' + key).join(',');
const sums = [
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
function combine(target, row) {
  for (const key of sums) if (row[key] != null) target[key] = (target[key] ?? 0) + row[key];
  return target;
}
function finish(row) {
  const { total_duration_ms, ...result } = row;
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    cancellations: 0,
    token_reports: 0,
    input_tokens: null,
    output_tokens: null,
    thought_tokens: null,
    total_tokens: null,
    ...result,
    avg_duration_ms: row.requests ? Math.round(total_duration_ms / row.requests) : null,
  };
}
export async function usageStats(db, params, env = {}) {
  const safe = new URLSearchParams(params);
  safe.delete('stage');
  safe.delete('before');
  safe.delete('fresh');
  const key =
    (env.TELEMETRY ? (env.USAGE_STORAGE_MODE || 'aggregate') + ':' : 'detailed:') +
    [...safe.entries()]
      .sort()
      .map((entry) => JSON.stringify(entry))
      .join(',');
  const cache = dbCache(db);
  cache.stats ||= new Map();
  if (params.get('fresh') !== '1' && cache.stats.get(key)?.until > Date.now())
    return structuredClone(cache.stats.get(key).value);
  if (!safe.has('from')) safe.set('from', String(Date.now() - 30 * 86400000));
  let { where, values } = filters(safe, 'u', false);
  const apiKeyId = safe.get('api_key_id');
  if (apiKeyId) {
    if (!/^[a-f0-9-]{36}$/.test(apiKeyId)) throw new HttpError(400, 'API 密钥 ID 无效');
    where += (where ? ' AND ' : ' WHERE ') + 'u.api_key_id=?';
    values.push(apiKeyId);
  }
  values.push(Date.now() - 30 * 86400000);
  const snapshot = await pendingTelemetry(env);
  const pendingKeys = snapshot.buckets.map((bucket) => bucket.key),
    pendingIds = snapshot.buckets.flatMap((bucket) => bucket.members);
  const sql =
    source +
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
      .bind(JSON.stringify(pendingIds), JSON.stringify(pendingKeys), ...values)
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
  const summary = {};
  const models = new Map(),
    credentials = new Map(),
    days = new Map(),
    apiKeys = new Map();
  for (const row of rows) {
    row.api_key_id ||= null;
    combine(summary, row);
    if (!apiKeys.has(row.api_key_id))
      apiKeys.set(row.api_key_id, {
        api_key_id: row.api_key_id,
        display_name:
          keyLookup.get(row.api_key_id) ||
          row.api_key_name ||
          (row.api_key_id === '00000000-0000-0000-0000-000000000000'
            ? '总密钥（兼容）'
            : row.api_key_id
              ? '已删除密钥'
              : '未归属（历史记录）'),
        deleted:
          !!row.api_key_id &&
          row.api_key_id !== '00000000-0000-0000-0000-000000000000' &&
          !keyLookup.has(row.api_key_id),
      });
    combine(apiKeys.get(row.api_key_id), row);
    const modelKey = JSON.stringify([row.mode, row.model]);
    if (!models.has(modelKey)) models.set(modelKey, { model: row.model, mode: row.mode });
    combine(models.get(modelKey), row);
    if (!credentials.has(row.credential_id))
      credentials.set(row.credential_id, {
        credential_id: row.credential_id,
        display_name: row.display_name,
      });
    combine(credentials.get(row.credential_id), row);
    if (!days.has(row.day)) days.set(row.day, { day: row.day });
    combine(days.get(row.day), row);
  }
  const ranked = (map) =>
    [...map.values()]
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 200)
      .map(finish);
  const value = {
    summary: finish(summary),
    models: ranked(models),
    credentials: ranked(credentials),
    api_keys: [...apiKeys.values()]
      .sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0) || b.requests - a.requests)
      .slice(0, 200)
      .map(finish),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(finish),
    groups_truncated: models.size > 200 || credentials.size > 200 || apiKeys.size > 200,
    retention: { days: 30, max_requests: env.TELEMETRY ? null : 10127, max_detail_requests: 10127 },
    timezone: 'Asia/Shanghai',
    cached_at: Date.now(),
    cache_seconds: 30,
    aggregation_seconds: env.TELEMETRY ? 300 : 0,
    storage_mode: env.TELEMETRY && env.USAGE_STORAGE_MODE !== 'detailed' ? 'aggregate' : 'detailed',
    pending_requests: snapshot.buckets.reduce((sum, bucket) => sum + bucket.value.requests, 0),
  };
  if (cache.stats.size >= 20) cache.stats.delete(cache.stats.keys().next().value);
  cache.stats.set(key, { until: Date.now() + 30000, value: structuredClone(value) });
  return value;
}
