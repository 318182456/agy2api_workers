import { dbCache } from '../cache/db.js';
import { nodeUsage } from './usage.js';
const HOUR = 3600000;
const day = (now) => new Date(now + 8 * HOUR).toISOString().slice(0, 10);
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

// Unknown/unreachable counters never compete as zero usage. Tie ordering rotates by hour.
export function leastUsedNode(nodes, metrics, now) {
  const fallback = nodeSchedule(nodes, now).current;
  const ranked = nodes
    .map((node) => {
      const value = metrics.get(node.id);
      if (!value?.available || value.day !== day(now) || Math.abs(value.sampled_at - now) > 120000)
        return null;
      return { node, count: value.today.requests };
    })
    .filter(Boolean);
  if (!ranked.length) return { id: fallback?.id || null, basis: 'fallback' };
  const minimum = Math.min(...ranked.map((entry) => entry.count));
  const tied = ranked.filter((entry) => entry.count === minimum).map((entry) => entry.node);
  return {
    id: nodeSchedule(
      tied.map((n) => ({ ...n, activated_at: 0 })),
      now,
    ).current.id,
    basis: 'daily_requests',
  };
}

// Decisions survive eviction and are shared by all main Worker instances.
export class StorageScheduler {
  constructor(owner) {
    this.owner = owner;
  }
  async resolve(nodes, now = Date.now()) {
    if (this.flight) {
      await this.flight;
      return this.resolve(nodes, now);
    }
    const flight = this.choose(nodes, now);
    this.flight = flight;
    try {
      return await flight;
    } finally {
      if (this.flight === flight) this.flight = null;
    }
  }
  async choose(nodes, now) {
    const hour = Math.floor(now / HOUR) * HOUR;
    let state;
    try {
      state = JSON.parse(this.owner.history.state('storage_schedule') || '{}');
    } catch {
      state = {};
    }
    const available = (id) => nodes.some((n) => n.id === id);
    const eligible = nodes.filter((n) => (n.activated_at || 0) <= hour);
    const candidates = eligible.length
      ? eligible
      : nodes.length
        ? [
            [...nodes].sort(
              (a, b) => (a.activated_at || 0) - (b.activated_at || 0) || a.id.localeCompare(b.id),
            )[0],
          ]
        : [];
    let changed = false;
    const measure = async (pool, at) => {
      const metrics = new Map();
      for (let offset = 0; offset < pool.length; offset += 5) {
        await Promise.all(
          pool.slice(offset, offset + 5).map(async (node) => {
            const value = await nodeUsage(
              this.owner.env,
              node,
              this.owner.env.STORAGE_NODE_FETCH || fetch,
              true,
            );
            // At midnight, healthy nodes start the new day on equal footing.
            if (value.available && day(at) !== day(now) && value.day === day(now))
              metrics.set(node.id, {
                ...value,
                day: day(at),
                sampled_at: at,
                today: { ...value.today, requests: 0 },
              });
            else metrics.set(node.id, value);
          }),
        );
      }
      return leastUsedNode(pool, metrics, at);
    };
    if (state.hour !== hour || !available(state.current?.id)) {
      const planned = state.hour === hour - HOUR && available(state.next?.id) ? state.next : null;
      state = { hour, current: planned || (await measure(candidates, now)), next: null };
      changed = true;
    }
    if (now >= hour + HOUR - 60000 && (!state.next || !available(state.next.id))) {
      state.next = await measure(nodes, hour + HOUR);
      changed = true;
    }
    if (changed) this.owner.history.putState('storage_schedule', JSON.stringify(state));
    return {
      current_id: state.current.id,
      next_id: state.next?.id || null,
      basis: state.current.basis,
      switches_at: hour + HOUR,
      warming: !!state.next?.id && state.next.id !== state.current.id && now >= hour + HOUR - 60000,
    };
  }
}

export async function storageSchedule(env, nodes, now = Date.now()) {
  const fallback = () => nodeSchedule(nodes, now);
  if (nodes.length === 1) return { ...fallback(), basis: 'single_node' };
  if (!nodes.length || !env.TELEMETRY || !env.DB) return fallback();
  const cache = dbCache(env.DB);
  const key = JSON.stringify(nodes.map((n) => [n.id, n.activated_at]).sort());
  if (cache.storageSchedule?.key === key && cache.storageSchedule.until > now)
    return materialize(cache.storageSchedule.value);
  if (cache.storageScheduleFlight) {
    await cache.storageScheduleFlight;
    return storageSchedule(env, nodes, now);
  }
  function materialize(value) {
    return {
      ...value,
      current: nodes.find((n) => n.id === value.current_id) || null,
      next: nodes.find((n) => n.id === value.next_id) || null,
    };
  }
  const flight = (async () => {
    try {
      const response = await env.TELEMETRY.get(env.TELEMETRY.idFromName('gcli2api')).fetch(
        'https://telemetry/storage-schedule',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nodes }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('schedule unavailable');
      }
      const value = await response.json();
      const end = (Math.floor(now / HOUR) + 1) * HOUR;
      if (
        value.switches_at !== end ||
        !nodes.some((n) => n.id === value.current_id) ||
        (value.next_id && !nodes.some((n) => n.id === value.next_id))
      )
        throw new Error('invalid schedule');
      cache.storageSchedule = { key, until: now < end - 60000 ? end - 60000 : end, value };
      return materialize(value);
    } catch {
      // A bounded fallback also covers rolling upgrades of the coordinator.
      const value = fallback();
      cache.storageSchedule = {
        key,
        until: Math.min(now + 30000, value.switches_at),
        value: {
          current_id: value.current?.id || null,
          next_id: value.next?.id || null,
          switches_at: value.switches_at,
          warming: value.warming,
          basis: 'fallback',
        },
      };
      return { ...value, basis: 'fallback' };
    }
  })();
  cache.storageScheduleFlight = flight;
  try {
    return await flight;
  } finally {
    if (cache.storageScheduleFlight === flight) delete cache.storageScheduleFlight;
  }
}
