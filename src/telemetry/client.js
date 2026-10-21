import { timed } from '../core/timing.js';
import { syncNodeTelemetry } from '../storage/telemetry.js';
import { readNodeCache, writeNodeCache, invalidateNodeCaches } from '../storage/client.js';
import { HttpError } from '../core/common.js';
export function telemetryStub(env) {
  return env.TELEMETRY?.get(env.TELEMETRY.idFromName('gcli2api'));
}
export async function pendingTelemetry(env = {}) {
  if (env.INTERNAL_DO_STATS) return { buckets: [] };
  const stub = telemetryStub(env);
  if (!stub) return { buckets: [] };
  if (env.PENDING_TELEMETRY) return env.PENDING_TELEMETRY;
  const flight = (async () => {
    await timed(env, 'nodes', () => syncNodeTelemetry(env));
    const response = await timed(env, 'buffer', () => stub.fetch('https://telemetry/snapshot'));
    if (!response.ok)
      throw new HttpError(503, '用量持久缓冲暂时不可读，未返回不完整统计；请稍后重试或手动落盘');
    return response.json();
  })();
  // Only request-scoped environments may retain this Promise; shared test/caller envs stay live.
  if (env.REQUEST_TIMINGS) env.PENDING_TELEMETRY = flight;
  return flight;
}
export async function flushTelemetry(env) {
  const stub = telemetryStub(env);
  if (!stub) return { buckets_flushed: 0, pending: false };
  await timed(env, 'nodes', () => syncNodeTelemetry(env));
  const response = await stub.fetch('https://telemetry/flush', { method: 'POST' });
  if (!response.ok) throw new HttpError(503, '用量落盘失败，缓冲已保留，请稍后重试');
  return response.json();
}
export async function telemetryPayload(record) {
  const created_at = Math.floor(record.started / 300000) * 300000;
  const group = JSON.stringify([
    record.apiKey?.id || null,
    record.row?.id || null,
    record.mode,
    record.model,
    record.status,
    record.outcome,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(group));
  const hash = Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
  const numeric = (key) =>
    Number.isSafeInteger(record.usage?.[key]) && record.usage[key] >= 0 ? record.usage[key] : null;
  return {
    key: String(created_at).padStart(13, '0') + ':' + hash,
    request_id: record.requestId,
    api_key_id: record.apiKey?.id || null,
    api_key_name: record.apiKey?.name || null,
    credential_id: record.row?.id || null,
    credential_name: record.row?.data?.user_email || record.row?.name || '',
    mode: record.mode,
    model: record.model,
    status: record.status,
    outcome: record.outcome,
    created_at,
    completed_at: Date.now(),
    duration_ms: Math.max(0, Date.now() - record.started),
    input_tokens: numeric('promptTokenCount'),
    output_tokens: numeric('candidatesTokenCount'),
    thought_tokens: numeric('thoughtsTokenCount'),
    total_tokens: numeric('totalTokenCount'),
  };
}

export async function queryTelemetryStats(env, params) {
  await timed(env, 'nodes', () => syncNodeTelemetry(env));
  const response = await timed(env, 'stats_do', () =>
    telemetryStub(env).fetch('https://telemetry/stats?' + params),
  );
  const value = await response.json();
  if (!response.ok)
    throw new HttpError(
      value.error?.code || 503,
      value.error?.message || '用量查询暂时不可用，请稍后重试',
    );
  if (!value.summary || value.query_source !== 'durable-object')
    throw new HttpError(503, '用量持久查询返回无效数据，未返回不完整统计');
  for (const [field, name] of [
    ['history_sync_ms', 'history'],
    ['aggregate_ms', 'rollup'],
  ])
    if (Number.isFinite(value.timings?.[field]))
      env.REQUEST_TIMINGS?.push({ name, ms: value.timings[field] });
  return value;
}

export async function cachedQuota(env, id) {
  const remote = await readNodeCache(env, 'quota', id);
  if (
    remote?.value?.credentialId === id &&
    remote.value.success === true &&
    Array.isArray(remote.value.models) &&
    Date.parse(remote.value.queriedAt) <= Date.now() &&
    Date.parse(remote.value.queriedAt) > Date.now() - 600000
  )
    return {
      ...remote.value,
      cached: true,
      cacheSeconds: 600,
      cache_source: 'storage-node',
      storage_node_name: remote.node_name,
    };
  const stub = telemetryStub(env);
  if (!stub) return null;
  try {
    const response = await stub.fetch('https://telemetry/quota/' + id);
    if (response.ok) return await response.json();
  } catch {
    /* A cache failure does not prevent an explicit Google quota query. */
  }
  return null;
}
export async function saveQuotaCache(env, id, value) {
  const safe = {
    success: true,
    credentialId: id,
    mode: value.mode,
    queriedAt: value.queriedAt,
    models: value.models.map((model) =>
      Object.fromEntries(
        ['id', 'remaining', 'resetTime', 'remainingAmount', 'tokenType', 'bucketIndex']
          .filter((key) => model[key] !== undefined)
          .map((key) => [key, model[key]]),
      ),
    ),
  };
  if (await writeNodeCache(env, 'quota', id, safe, Date.parse(value.queriedAt) + 600000)) return;
  const stub = telemetryStub(env);
  if (!stub) return;
  try {
    const response = await stub.fetch('https://telemetry/quota/' + id, {
      method: 'POST',
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error('quota cache unavailable');
  } catch {
    console.warn(JSON.stringify({ event: 'quota_cache_save_failed' }));
  }
}
export async function invalidateTelemetryMetadata(env, credentialId) {
  await invalidateNodeCaches(env);
  const stub = telemetryStub(env);
  if (!stub) return;
  try {
    const response = await stub.fetch('https://telemetry/invalidate-metadata', {
      method: 'POST',
      body: JSON.stringify({ credentialId }),
    });
    if (!response.ok) throw new Error('metadata cache unavailable');
  } catch {
    console.warn(JSON.stringify({ event: 'telemetry_metadata_refresh_failed' }));
  }
}
