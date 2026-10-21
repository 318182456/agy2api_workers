// Authenticated admin statistics only. Cache API is shared across isolates at the executing colo.
// No OAuth tokens, API key values or authentication decisions are stored.
export const STATS_CACHE_SECONDS = 60;
export async function statsCacheKey(env, key) {
  const scope = JSON.stringify([
    env.CACHE_SCOPE || '',
    env.API_PASSWORD || '',
    env.PANEL_PASSWORD || '',
    key,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  const hash = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
  return hash;
}
async function requestKey(env, key) {
  const hash = await statsCacheKey(env, key);
  const origin = env.STATS_CACHE_ORIGIN || 'https://gcli2api-cache.invalid';
  return new Request(new URL('/__internal-cache/admin-stats/v2/' + hash, origin));
}
export async function readStatsSnapshot(env, key) {
  if (!globalThis.caches?.default?.match) return null;
  try {
    const response = await caches.default.match(await requestKey(env, key));
    if (!response) return null;
    const value = await response.json();
    const age = Date.now() - value.edge_cached_at;
    return Number.isFinite(age) &&
      age >= 0 &&
      age < STATS_CACHE_SECONDS * 1000 &&
      Date.now() - value.cached_at < (value.cache_seconds || STATS_CACHE_SECONDS) * 1000 &&
      value.summary &&
      Array.isArray(value.api_keys)
      ? value
      : null;
  } catch {
    return null;
  }
}
export async function writeStatsSnapshot(env, key, value) {
  if (!globalThis.caches?.default?.put) return;
  try {
    await caches.default.put(
      await requestKey(env, key),
      Response.json(
        { ...value, edge_cached_at: Date.now() },
        {
          headers: { 'Cache-Control': 'public, max-age=' + STATS_CACHE_SECONDS },
        },
      ),
    );
  } catch {
    /* Statistics remain available when Cache API is unavailable. */
  }
}

export const KV_STATS_SECONDS = 300;
export async function readKvStatsSnapshot(env, key) {
  if (!env.CACHE?.get) return null;
  try {
    const value = await env.CACHE.get('gcli-stats:v2:' + (await statsCacheKey(env, key)), {
      type: 'json',
      cacheTtl: 60,
    });
    const age = Date.now() - value?.cached_at;
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age >= KV_STATS_SECONDS * 1000 ||
      value.query_source !== 'durable-object' ||
      !value.summary ||
      !Array.isArray(value.api_keys)
    )
      return null;
    return { ...value, cache_source: 'kv', cache_seconds: KV_STATS_SECONDS };
  } catch {
    return null;
  }
}
// Only the single telemetry DO publishes these keys, with one global 5-minute write gate.
export async function writeKvStatsSnapshot(env, hash, value) {
  if (!env.CACHE?.put || !/^[a-f0-9]{64}$/.test(hash || '')) return false;
  try {
    await env.CACHE.put(
      'gcli-stats:v2:' + hash,
      JSON.stringify({ ...value, cache_seconds: KV_STATS_SECONDS }),
      { expirationTtl: KV_STATS_SECONDS },
    );
    return true;
  } catch {
    return false;
  }
}
