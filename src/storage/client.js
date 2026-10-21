import { dbCache } from '../cache/db.js';

const HOUR = 3600000;
const CONFIG_TTL = 300000;
const failures = new WeakMap();
export function resetStorageNodes(env) {
  if (env.DB) {
    delete dbCache(env.DB).storageNodes;
    delete dbCache(env.DB).storagePanel;
    delete dbCache(env.DB).storagePanelFlight;
    delete dbCache(env.DB).storagePanelFlightOrigin;
    delete dbCache(env.DB).nodeTelemetryBackoff;
    delete dbCache(env.DB).telemetryNodeAuth;
  }
}
export async function storageNodes(env) {
  if (!env.DB || env.INTERNAL_DO_STATS) return [];
  const cache = dbCache(env.DB);
  if (cache.storageNodes?.until > Date.now()) return cache.storageNodes.value;
  if (cache.storageNodesFlight) return cache.storageNodesFlight;
  const flight = (async () => {
    let rows = [];
    try {
      rows = (
        await env.DB.prepare(
          "SELECT id,email,worker_name,url,node_secret,activated_at FROM storage_nodes WHERE status='ready' ORDER BY id",
        ).all()
      ).results.filter(
        (row) =>
          /^[a-f0-9-]{36}$/.test(row.id) &&
          /^gcli2api-storage-[a-f0-9]{12}$/.test(row.worker_name) &&
          row.url === 'https://' + row.worker_name + '.pages.dev' &&
          /^[a-f0-9]{64}$/.test(row.node_secret),
      );
    } catch {
      /* Older deployments without the nodes migration retain local caches. */
    }
    const now = Date.now(),
      hourEnd = (Math.floor(now / HOUR) + 1) * HOUR;
    // Refresh before preheating and at the hour boundary, even if the 5-minute TTL remains.
    const boundary = now < hourEnd - 60000 ? hourEnd - 60000 : hourEnd;
    cache.storageNodes = { until: Math.min(now + CONFIG_TTL, boundary), value: rows };
    return rows;
  })();
  cache.storageNodesFlight = flight;
  try {
    return await flight;
  } finally {
    if (cache.storageNodesFlight === flight) delete cache.storageNodesFlight;
  }
}
export function nodeSchedule(nodes, now = Date.now()) {
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const available = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const joined = (node) => node.activated_at ?? 0;
  // Membership is frozen as of this hour's start. A new/recovered node joins next hour.
  let eligible = available.filter((node) => joined(node) <= hourStart);
  if (!eligible.length && available.length) {
    // Bootstrap or total outage: use the oldest available node without waiting an hour.
    eligible = [
      [...available].sort((a, b) => joined(a) - joined(b) || a.id.localeCompare(b.id))[0],
    ];
  }
  if (!eligible.length)
    return { current: null, next: null, warming: false, switches_at: hourStart + HOUR };
  const current = eligible[Math.floor(now / HOUR) % eligible.length];
  const next = available[(Math.floor(now / HOUR) + 1) % available.length];
  return {
    current,
    next,
    warming: next.id !== current.id && now % HOUR >= HOUR - 60000,
    switches_at: hourStart + HOUR,
  };
}
async function keyFor(env, kind, key) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      'node-cache-v1',
      env.CACHE_SCOPE || '',
      env.API_PASSWORD || '',
      env.PANEL_PASSWORD || '',
      kind,
      key,
    ]),
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
async function call(env, node, path, init = {}) {
  let state = failures.get(env.DB);
  if (!state) {
    state = new Map();
    failures.set(env.DB, state);
  }
  if (state.get(node.id) > Date.now()) return null;
  try {
    const response = await (env.STORAGE_NODE_FETCH || fetch)(node.url + path, {
      ...init,
      headers: { authorization: 'Bearer ' + node.node_secret, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(2500),
      redirect: 'manual',
    });
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel();
      throw new Error('node unavailable');
    }
    return response;
  } catch {
    state.set(node.id, Date.now() + 60000);
    console.warn(JSON.stringify({ event: 'storage_node_cache_fallback', node_id: node.id }));
    return null;
  }
}
function used(env, node, operation) {
  const cache = dbCache(env.DB);
  if ((cache.storageNodeLoggedAt || 0) > Date.now() - 60000) return;
  cache.storageNodeLoggedAt = Date.now();
  console.log(JSON.stringify({ event: 'storage_node_cache_used', node_id: node.id, operation }));
}
async function warm(env, schedule) {
  if (!schedule.warming) return;
  const cache = dbCache(env.DB),
    hour = Math.floor(Date.now() / HOUR);
  if (cache.storageWarmHour === hour) return;
  cache.storageWarmHour = hour;
  const response = await call(env, schedule.current, '/cache-transfer');
  if (!response?.ok) return;
  try {
    const value = await response.json();
    if (value?.node_id !== schedule.current.id || !Array.isArray(value.entries)) return;
    const target = await call(env, schedule.next, '/cache-transfer', {
      method: 'POST',
      body: JSON.stringify({ entries: value.entries }),
    });
    if (target?.ok) used(env, schedule.next, 'preheat');
    await target?.body?.cancel();
  } catch {
    /* A cold next node will refill from the authoritative main coordinator. */
  }
}
export async function readNodeCache(env, kind, key) {
  const schedule = nodeSchedule(await storageNodes(env));
  if (!schedule.current) return null;
  await warm(env, schedule);
  const response = await call(env, schedule.current, '/cache/' + (await keyFor(env, kind, key)));
  if (!response?.ok) {
    await response?.body?.cancel();
    return null;
  }
  try {
    const entry = await response.json();
    if (
      entry?.node_id !== schedule.current.id ||
      !Number.isFinite(entry.expires_at) ||
      entry.expires_at <= Date.now() ||
      entry.expires_at > Date.now() + 600000
    )
      return null;
    used(env, schedule.current, 'read');
    return { value: entry.value, node_id: schedule.current.id, node_name: schedule.current.email };
  } catch {
    return null;
  }
}
export async function writeNodeCache(env, kind, key, value, expiresAt) {
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  const schedule = nodeSchedule(await storageNodes(env));
  if (!schedule.current) return false;
  const body = JSON.stringify({ expires_at: expiresAt, value });
  if (new TextEncoder().encode(body).length > 524288) return false;
  const path = '/cache/' + (await keyFor(env, kind, key));
  const response = await call(env, schedule.current, path, { method: 'PUT', body });
  let saved = false;
  if (response?.ok) {
    try {
      const ack = await response.json();
      saved = ack?.success === true && ack.node_id === schedule.current.id;
    } catch {
      /* A non-JSON 200 response is not a successful cache write. */
    }
  } else await response?.body?.cancel();
  if (saved) used(env, schedule.current, 'write');
  if (schedule.warming) {
    await warm(env, schedule);
    const next = await call(env, schedule.next, path, { method: 'PUT', body });
    await next?.body?.cancel();
  }
  return saved;
}
export async function invalidateNodeCaches(env) {
  // Metadata changes are rare. Clear every registered cache to cover changes in node membership.
  const nodes = await storageNodes(env);
  for (let at = 0; at < nodes.length; at += 5) {
    await Promise.all(
      nodes.slice(at, at + 5).map(async (node) => {
        const response = await call(env, node, '/cache-transfer', { method: 'DELETE' });
        await response?.body?.cancel();
      }),
    );
  }
}
