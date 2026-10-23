import { dbCache } from '../cache/db.js';
import { storageNodes } from './client.js';
import { storageSchedule } from './schedule.js';
import { HttpError, readJson } from '../core/common.js';

async function rpc(env, node, path, body) {
  return (env.STORAGE_NODE_FETCH || fetch)(node.url + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + node.node_secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
}
export async function recordNodeTelemetry(env, payload) {
  if (!env.TELEMETRY_ORIGIN) return null;
  const node = (await storageSchedule(env, await storageNodes(env))).current;
  if (!node) return null;
  const cache = dbCache(env.DB);
  cache.nodeTelemetryBackoff ||= new Map();
  if ((cache.nodeTelemetryBackoff.get(node.id) || 0) > Date.now()) return null;
  const key = payload.key + ':' + node.id;
  try {
    const response = await rpc(env, node, '/telemetry/record', {
      ...payload,
      key,
      origin: env.TELEMETRY_ORIGIN,
    });
    const ack = response.ok ? await response.json() : null;
    if (ack?.success && ack.node_id === node.id) return { accepted: true, key };
    // Old cache-only nodes reject this path before storing anything.
    if ([404, 405, 409].includes(response.status)) {
      cache.nodeTelemetryBackoff.set(node.id, Date.now() + 60000);
      await response.body?.cancel();
      return null;
    }
  } catch {
    /* An acknowledgement can be lost after persistence: keep the same aggregate key. */
  }
  cache.nodeTelemetryBackoff.set(node.id, Date.now() + 60000);
  console.warn(JSON.stringify({ event: 'storage_node_telemetry_uncertain', node_id: node.id }));
  return { accepted: false, key };
}
export async function importNodeBuckets(env, nodeId, buckets) {
  const response = await env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api')).fetch(
    'https://telemetry/import',
    {
      method: 'POST',
      body: JSON.stringify({ node_id: nodeId, buckets }),
    },
  );
  if (!response.ok) throw new HttpError(503, '子节点用量汇总暂时不可用，数据仍保留在子节点');
  return response.json();
}
export async function syncNodeTelemetry(env, selected) {
  if (!env.DB || !env.TELEMETRY || env.INTERNAL_DO_STATS) return;
  if (selected) return syncNodes(env, selected);
  const cache = dbCache(env.DB);
  if (cache.nodeTelemetrySyncFlight) return cache.nodeTelemetrySyncFlight;
  const flight = syncNodes(env);
  cache.nodeTelemetrySyncFlight = flight;
  try {
    return await flight;
  } finally {
    if (cache.nodeTelemetrySyncFlight === flight) delete cache.nodeTelemetrySyncFlight;
  }
}
async function syncNodes(env, selected) {
  const nodes = selected || (await storageNodes(env));
  for (let start = 0; start < nodes.length; start += 5)
    await Promise.all(
      nodes.slice(start, start + 5).map(async (node) => {
        const cache = dbCache(env.DB);
        cache.nodeTelemetryVersions ||= new Map();
        const known = cache.nodeTelemetryVersions.get(node.id) || {};
        const response = await rpc(env, node, '/telemetry/snapshot', { known_versions: known });
        if (response.status === 404) {
          await response.body?.cancel();
          return;
        }
        if (!response.ok) throw new HttpError(503, '子节点用量暂时不可读，未返回不完整统计');
        const value = await response.json();
        if (value.node_id !== node.id || !Array.isArray(value.buckets))
          throw new HttpError(503, '子节点用量响应无效');
        const changed = value.buckets.filter(
          (row) => !Number.isSafeInteger(row.version) || (known[row.key] || 0) < row.version,
        );
        if (changed.length) {
          await importNodeBuckets(env, node.id, changed);
          const next = { ...known };
          for (const row of changed) next[row.key] = row.version;
          // Bound isolate memory; forgetting versions only causes a safe re-import.
          cache.nodeTelemetryVersions.set(
            node.id,
            Object.fromEntries(Object.entries(next).slice(-1000)),
          );
        }
      }),
    );
}
export async function receiveNodeTelemetry(request, env) {
  if (request.method !== 'POST') throw new HttpError(405, '请求方法不支持');
  // Include disconnected nodes: pending delivery must survive a temporary unhealthy status.
  const id = request.headers.get('x-storage-node-id');
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new HttpError(401, '节点认证失败');
  const cache = dbCache(env.DB);
  cache.telemetryNodeAuth ||= new Map();
  let row = cache.telemetryNodeAuth.get(id);
  if (!row || row.until < Date.now()) {
    const found = await env.DB.prepare('SELECT node_secret FROM storage_nodes WHERE id=?')
      .bind(id)
      .first();
    row = { secret: found?.node_secret || '', until: Date.now() + 60000 };
    cache.telemetryNodeAuth.set(id, row);
  }
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  const digest = async (value) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(token), digest(row.secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (!row.secret || diff) throw new HttpError(401, '节点认证失败');
  const value = await readJson(request);
  const result = await importNodeBuckets(env, id, value.buckets);
  return Response.json({ success: true, node_id: id, ...result });
}
