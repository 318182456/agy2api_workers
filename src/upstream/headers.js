import { readJson } from '../core/common.js';
export const ANTIGRAVITY_RELEASE_URL =
  'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest';
export const ANTIGRAVITY_CLIENT_CACHE_KEY = 'antigravity-cli-release:v1';
const fallback = '1.4.7'; // Same fallback as the Python reference project.
const day = 86400000;
const versions = new WeakMap();
const validVersion = (value) =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]{1,40})?$/.test(value);
function validEntry(value) {
  return (
    value &&
    validVersion(value.cliVersion) &&
    Number.isFinite(value.checkedAt) &&
    value.checkedAt <= Date.now() + 60000 &&
    value.checkedAt > Date.now() - 7 * day
  );
}
async function cachedVersion(env) {
  const cache = env.CACHE;
  if (!cache?.get) return fallback;
  let state = versions.get(cache);
  if (state?.until > Date.now()) return state.version;
  if (state?.flight) return state.flight;
  state = { version: state?.version || fallback, until: 0 };
  versions.set(cache, state);
  const flight = (async () => {
    try {
      const value = await cache.get(ANTIGRAVITY_CLIENT_CACHE_KEY, { type: 'json', cacheTtl: 300 });
      if (validEntry(value)) state.version = value.cliVersion;
    } catch {
      /* Keep a validated last-known version. */
    }
    state.until = Date.now() + 300000;
    return state.version;
  })();
  state.flight = flight;
  try {
    return await flight;
  } finally {
    state.flight = null;
  }
}
export async function refreshAntigravityClient(env, fetcher = fetch) {
  if (!env.CACHE?.put) return { skipped: true };
  try {
    const old = await env.CACHE.get(ANTIGRAVITY_CLIENT_CACHE_KEY, { type: 'json', cacheTtl: 60 });
    if (validEntry(old) && old.checkedAt > Date.now() - day)
      return { version: old.cliVersion, cached: true };
    // ASVS V13.2.4: fixed public metadata endpoint; never forward provider/client credentials.
    const response = await fetcher(ANTIGRAVITY_RELEASE_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agy2api-workers' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { skipped: true };
    }
    const value = await readJson({ headers: response.headers, body: response.body });
    const cliVersion =
      typeof value.tag_name === 'string' ? value.tag_name.trim().replace(/^v/i, '') : null;
    if (!validVersion(cliVersion)) return { skipped: true };
    await env.CACHE.put(
      ANTIGRAVITY_CLIENT_CACHE_KEY,
      JSON.stringify({ cliVersion, checkedAt: Date.now() }),
      { expirationTtl: 7 * 86400 },
    );
    versions.set(env.CACHE, { version: cliVersion, until: Date.now() + 300000 });
    return { version: cliVersion, cached: false };
  } catch {
    return { skipped: true };
  }
}
export async function antigravityHeaders(env, token, model = '') {
  const headers = {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
    'user-agent': 'antigravity/cli/' + (await cachedVersion(env)) + ' windows/amd64',
    accept: '*/*',
    'accept-encoding': 'gzip',
    requestId: 'req-' + crypto.randomUUID(),
  };
  if (model) headers.requestType = /image/i.test(model) ? 'image_gen' : 'agent';
  // Connection is hop-by-hop; Workers manages the upstream connection and TLS itself.
  return headers;
}
