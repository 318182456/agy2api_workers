// KV contains only settings and model IDs. Telemetry/tokens are never written here.
async function cacheKey(env, name) {
  const scope = JSON.stringify([
    env.CACHE_SCOPE || '',
    env.API_PASSWORD || '',
    env.PANEL_PASSWORD || '',
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  const hash = Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
  return 'gcli-cache:v1:' + hash + ':' + name;
}
export async function readShared(env, name) {
  if (!env.CACHE?.get) return null;
  try {
    const entry = await env.CACHE.get(await cacheKey(env, name), { type: 'json', cacheTtl: 60 });
    if (
      !entry ||
      entry.version !== 1 ||
      !Number.isFinite(entry.expires) ||
      entry.expires <= Date.now()
    )
      return null;
    return entry;
  } catch {
    return null;
  }
}
// Called only for an explicit settings save/model refresh or the hourly warmer.
export async function publishShared(env, name, value, ttl) {
  if (!env.CACHE?.put) return false;
  try {
    const key = await cacheKey(env, name);
    const old = await env.CACHE.get(key, { type: 'json', cacheTtl: 60 });
    if (
      old?.version === 1 &&
      old.expires > Date.now() + Math.min(ttl * 500, 300000) &&
      JSON.stringify(old.value) === JSON.stringify(value)
    )
      return false;
    const now = Date.now();
    await env.CACHE.put(
      key,
      JSON.stringify({ version: 1, created: now, expires: now + ttl * 1000, value }),
      { expirationTtl: Math.max(60, ttl) },
    );
    return true;
  } catch {
    console.warn(JSON.stringify({ event: 'shared_cache_publish_failed', kind: name }));
    return false;
  }
}
