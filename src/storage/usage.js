import { dbCache } from '../cache/db.js';

// Node-local application counters, not Cloudflare account billing or model token consumption.
export async function nodeUsage(env, row, fetcher = fetch, fresh = false) {
  if (
    row.url !== 'https://' + row.worker_name + '.pages.dev' ||
    !/^(?:gcli2api|agy2api)-storage-[a-f0-9]{12}$/.test(row.worker_name) ||
    !row.node_secret
  )
    return { available: false, reason: '节点入口尚未部署' };
  const cache = dbCache(env.DB);
  cache.nodeUsage ||= new Map();
  const key = row.id + ':' + row.url;
  const previous = cache.nodeUsage.get(key);
  if (!fresh && previous?.until > Date.now()) return { ...previous.value, cached: true };
  let value;
  const fields = ['requests', 'reads', 'hits', 'misses', 'writes', 'imports', 'exports', 'errors'];
  try {
    const response = await fetcher(row.url + '/usage', {
      headers: { authorization: 'Bearer ' + row.node_secret },
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      value = {
        available: false,
        reason:
          response.status === 404
            ? '需重新部署节点以启用统计'
            : '节点用量查询失败（HTTP ' + response.status + '）',
      };
    } else {
      const data = await response.json();
      if (
        data?.success !== true ||
        data.node_id !== row.id ||
        !/^\d{4}-\d{2}-\d{2}$/.test(data.day || '') ||
        !Number.isFinite(data.sampled_at) ||
        !Number.isFinite(data.started_at) ||
        fields.some(
          (field) => !Number.isSafeInteger(data.today?.[field]) || data.today[field] < 0,
        ) ||
        !Number.isSafeInteger(data.cache_entries) ||
        data.cache_entries < 0 ||
        !Number.isSafeInteger(data.cache_bytes) ||
        data.cache_bytes < 0
      )
        throw new Error('invalid metrics');
      const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
      const today = Object.fromEntries(fields.map((field) => [field, count(data.today?.[field])]));
      value = {
        available: true,
        day: data.day,
        today,
        last_activity: Number.isFinite(data.today?.last_activity) ? data.today.last_activity : null,
        cache_entries: count(data.cache_entries),
        cache_bytes: count(data.cache_bytes),
        started_at: data.started_at,
        sampled_at: data.sampled_at,
        approximate: true,
        telemetry:
          data.telemetry?.supported === true
            ? {
                supported: true,
                today_requests: count(data.telemetry.today_requests),
                pending_requests: count(data.telemetry.pending_requests),
                pending_buckets: count(data.telemetry.pending_buckets),
                interval_seconds: 300,
                events: count(data.telemetry.events),
              }
            : { supported: false },
      };
    }
  } catch {
    value = { available: false, reason: '节点用量暂时不可读，请稍后刷新' };
  }
  if (cache.nodeUsage.size >= 100) cache.nodeUsage.delete(cache.nodeUsage.keys().next().value);
  cache.nodeUsage.set(key, { until: Date.now() + 30000, value });
  return value;
}

export async function primaryUsage(env, fresh = false) {
  if (!env.TELEMETRY) return { available: false, reason: '未绑定主节点 TELEMETRY DO' };
  const cache = dbCache(env.DB),
    previous = cache.primaryNodeUsage;
  if (!fresh && previous?.until > Date.now()) return { ...previous.value, cached: true };
  let value;
  try {
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api'));
    const response = await stub.fetch('https://telemetry/node-usage' + (fresh ? '?fresh=1' : ''));
    if (!response.ok) throw new Error('main DO unavailable');
    const data = await response.json();
    const fields = [
      'today_requests',
      'pending_buckets',
      'pending_requests',
      'buffer_buckets',
      'buffer_bytes',
      'quota_entries',
      'quota_bytes',
      'history_bytes',
    ];
    if (
      data.available !== true ||
      data.kind !== 'primary' ||
      fields.some((field) => !Number.isSafeInteger(data[field]) || data[field] < 0) ||
      !Number.isFinite(data.sampled_at) ||
      !Number.isFinite(data.activity?.started_at) ||
      ['requests', 'reads', 'writes', 'errors'].some(
        (field) => !Number.isSafeInteger(data.activity[field]) || data.activity[field] < 0,
      )
    )
      throw new Error('invalid primary metrics');
    value = {
      available: true,
      kind: 'primary',
      ...Object.fromEntries(fields.map((key) => [key, data[key]])),
      sampled_at: data.sampled_at,
      history_synced_at: Number.isFinite(data.history_synced_at) ? data.history_synced_at : null,
      next_flush_at: Number.isFinite(data.next_flush_at) ? data.next_flush_at : null,
      activity: Object.fromEntries(
        ['started_at', 'requests', 'reads', 'writes', 'errors', 'last_activity'].map((key) => [
          key,
          data.activity[key] ?? null,
        ]),
      ),
    };
  } catch {
    value = { available: false, reason: '主节点用量暂时不可读，请稍后刷新' };
  }
  cache.primaryNodeUsage = { until: Date.now() + 30000, value };
  return value;
}
