import { dbCache } from '../cache/db.js';

// Node-local application counters, not Cloudflare account billing or model token consumption.
export async function nodeUsage(env, row, fetcher = fetch, fresh = false) {
  if (
    row.url !== 'https://' + row.worker_name + '.pages.dev' ||
    !/^gcli2api-storage-[a-f0-9]{12}$/.test(row.worker_name) ||
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
      };
    }
  } catch {
    value = { available: false, reason: '节点用量暂时不可读，请稍后刷新' };
  }
  if (cache.nodeUsage.size >= 100) cache.nodeUsage.delete(cache.nodeUsage.keys().next().value);
  cache.nodeUsage.set(key, { until: Date.now() + 30000, value });
  return value;
}
