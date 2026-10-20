// Authenticated admin statistics only. Cache API is shared across isolates at the executing colo.
// No OAuth tokens, API key values or authentication decisions are stored; KV receives no writes.
export const STATS_CACHE_SECONDS = 60;
async function requestKey(env, key) {
  const scope = JSON.stringify([
    env.CACHE_SCOPE || '',
    env.API_PASSWORD || '',
    env.PANEL_PASSWORD || '',
    key,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  const hash = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
  const origin = env.STATS_CACHE_ORIGIN || 'https://gcli2api-cache.invalid';
  return new Request(new URL('/__internal-cache/admin-stats/v1/' + hash, origin));
}
export async function readStatsSnapshot(env, key) {
  if (!globalThis.caches?.default?.match) return null;
  try {
    const response = await caches.default.match(await requestKey(env, key));
    if (!response) return null;
    const value = await response.json();
    const age = Date.now() - value.cached_at;
    return Number.isFinite(age) &&
      age >= 0 &&
      age < STATS_CACHE_SECONDS * 1000 &&
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
      Response.json(value, {
        headers: { 'Cache-Control': 'public, max-age=' + STATS_CACHE_SECONDS },
      }),
    );
  } catch {
    /* Statistics remain available when Cache API is unavailable. */
  }
}
