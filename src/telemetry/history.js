import { HttpError } from '../core/common.js';
import { filters } from './filters.js';
import { summarizeRows } from './rollup.js';
import { statsCacheKey, writeKvStatsSnapshot } from './stats-cache.js';

const HOUR = 3600000;
const PAGE = 1000;
const CHUNK = 256 * 1024;
const MAX_BYTES = 24 * 1024 * 1024;
const detailColumns = [
  'id',
  'request_id',
  'credential_id',
  'credential_name',
  'mode',
  'model',
  'status',
  'outcome',
  'duration_ms',
  'created_at',
  'input_tokens',
  'output_tokens',
  'thought_tokens',
  'total_tokens',
  'aggregate_key',
  'api_key_id',
  'api_key_name',
];
const tokens = ['input_tokens', 'output_tokens', 'thought_tokens', 'total_tokens'];
const valid = (value) =>
  value?.version === 3 &&
  Number.isFinite(value.synced_at) &&
  Array.isArray(value.aggregates) &&
  Array.isArray(value.details) &&
  Array.isArray(value.accounts) &&
  Array.isArray(value.keys);
async function pack(value) {
  return new Response(
    new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
}
async function unpack(bytes) {
  const value = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).json();
  if (!valid(value)) throw new Error('invalid statistics snapshot');
  return value;
}

// Historical counters are one compressed snapshot, not a second indexed SQL database.
// Once loaded, filtering and rollups use memory; only live request buckets remain SQL rows.
export class StatsHistory {
  constructor(owner) {
    this.owner = owner;
    this.sql = owner.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS stats_state(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID',
    );
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS stats_snapshot_chunks(pos INTEGER PRIMARY KEY,data BLOB NOT NULL)',
    );
  }
  state(key) {
    return this.sql.exec('SELECT value FROM stats_state WHERE key=?', key).toArray()[0]?.value;
  }
  putState(key, value) {
    this.sql.exec(
      'INSERT INTO stats_state(key,value)VALUES(?,?) ON CONFLICT(key)DO UPDATE SET value=excluded.value',
      key,
      String(value),
    );
  }
  syncedAt() {
    return Number(this.state('synced_at') || 0);
  }
  async load() {
    if (this.loaded) return;
    const rows = this.sql.exec('SELECT data FROM stats_snapshot_chunks ORDER BY pos').toArray();
    if (rows.length) {
      const buffers = rows.map((row) => new Uint8Array(row.data));
      const bytes = new Uint8Array(buffers.reduce((sum, b) => sum + b.length, 0));
      let offset = 0;
      for (const buffer of buffers) {
        bytes.set(buffer, offset);
        offset += buffer.length;
      }
      this.data = await unpack(bytes);
    } else if (this.owner.env.CACHE?.get) {
      try {
        const bytes = await this.owner.env.CACHE.get(
          'gcli-history:v3:' + (await statsCacheKey(this.owner.env, 'history')),
          'arrayBuffer',
        );
        if (bytes && bytes.byteLength <= MAX_BYTES) {
          const data = await unpack(bytes);
          if (data.synced_at > Date.now() - HOUR && data.synced_at <= Date.now())
            this.persist(data, bytes);
        }
      } catch {
        /* D1 initializes history if KV is unavailable or stale. */
      }
    }
    const metadata = this.state('metadata');
    if (this.data && metadata) Object.assign(this.data, JSON.parse(metadata));
    this.loaded = true;
  }
  persist(data, bytes) {
    this.owner.ctx.storage.transactionSync(() => {
      const old = this.sql
        .exec('SELECT pos,data FROM stats_snapshot_chunks ORDER BY pos')
        .toArray();
      let count = 0;
      for (let at = 0; at < bytes.byteLength; at += CHUNK) {
        const part = bytes.slice(at, at + CHUNK);
        const previous = old[count] && new Uint8Array(old[count].data);
        const next = new Uint8Array(part);
        if (
          !previous ||
          previous.length !== next.length ||
          previous.some((value, i) => value !== next[i])
        )
          this.sql.exec(
            'INSERT INTO stats_snapshot_chunks(pos,data)VALUES(?,?) ON CONFLICT(pos)DO UPDATE SET data=excluded.data',
            count,
            part,
          );
        count++;
      }
      this.sql.exec('DELETE FROM stats_snapshot_chunks WHERE pos>=?', count);
      this.putState('synced_at', data.synced_at);
      this.putState('metadata', JSON.stringify({ accounts: data.accounts, keys: data.keys }));
    });
    this.data = data;
  }
  async ensure(force = false) {
    if (this.owner.statsSyncing) return this.owner.statsSyncing;
    const flight = (async () => {
      await this.load();
      if (!force && this.data && this.syncedAt() > Date.now() - HOUR) return;
      await this.sync();
    })();
    this.owner.statsSyncing = flight;
    try {
      await flight;
    } finally {
      if (this.owner.statsSyncing === flight) this.owner.statsSyncing = null;
    }
  }
  async metadata() {
    const db = this.owner.env.DB;
    const accounts = (
      await db
        .prepare(
          "SELECT id,name,CASE WHEN json_valid(data) THEN json_extract(data,'$.user_email') END AS email FROM credentials",
        )
        .all()
    ).results;
    const keys = (await db.prepare('SELECT id,name FROM api_keys').all()).results;
    return { accounts, keys };
  }
  async sync() {
    const db = this.owner.env.DB;
    if (!db) throw new HttpError(503, '未绑定 D1 数据库，无法初始化统计历史');
    const cutoff = Date.now() - 30 * 86400000;
    const aggregates = [];
    let cursor = '';
    for (;;) {
      const rows = (
        await db
          .prepare(
            'SELECT bucket_key,version,created_at,credential_id,api_key_id,payload FROM usage_aggregates WHERE bucket_key>? AND created_at>=? ORDER BY bucket_key LIMIT ' +
              PAGE,
          )
          .bind(cursor, cutoff)
          .all()
      ).results;
      for (const row of rows)
        aggregates.push({
          key: row.bucket_key,
          version: row.version,
          value: {
            ...JSON.parse(row.payload),
            created_at: row.created_at,
            credential_id: row.credential_id,
            api_key_id: row.api_key_id,
          },
        });
      if (rows.length < PAGE) break;
      cursor = rows.at(-1).bucket_key;
    }
    const details = [];
    let detailCursor = 0;
    const maximum = (await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM request_usage').all())
      .results[0].id;
    for (;;) {
      const rows = (
        await db
          .prepare(
            `SELECT ${detailColumns.map((column) => 'r.' + column).join(',')} FROM request_usage r WHERE r.id>? AND r.id<=? AND r.created_at>=?
        AND (r.aggregate_key IS NULL OR NOT EXISTS(SELECT 1 FROM usage_aggregates a,json_each(a.members) m WHERE a.bucket_key=r.aggregate_key AND m.value=r.request_id)) ORDER BY r.id LIMIT ${PAGE}`,
          )
          .bind(detailCursor, maximum, cutoff)
          .all()
      ).results;
      details.push(...rows);
      if (rows.length < PAGE) break;
      detailCursor = rows.at(-1).id;
    }
    const data = {
      version: 3,
      synced_at: Date.now(),
      aggregates,
      details,
      ...(await this.metadata()),
    };
    const bytes = await pack(data);
    if (bytes.byteLength > MAX_BYTES)
      throw new HttpError(503, '统计快照超过缓存容量，请缩短历史保留范围');
    this.persist(data, bytes);
    // One historical KV publication at most per hour, even after eviction or repeated manual sync.
    if (
      this.owner.env.CACHE?.put &&
      Number(this.state('history_kv_at') || 0) <= Date.now() - HOUR
    ) {
      this.putState('history_kv_at', Date.now());
      try {
        await this.owner.env.CACHE.put(
          'gcli-history:v3:' + (await statsCacheKey(this.owner.env, 'history')),
          bytes,
          { expirationTtl: 7200 },
        );
      } catch {
        console.warn(JSON.stringify({ event: 'stats_history_kv_publish_failed' }));
      }
    }
  }
  async refreshMetadata() {
    if (this.owner.statsSyncing) await this.owner.statsSyncing;
    const metadata = await this.metadata();
    this.putState('metadata', JSON.stringify(metadata));
    if (this.data) Object.assign(this.data, metadata);
  }
  live() {
    if (!this.owner.liveStatsBuckets)
      this.owner.liveStatsBuckets = new Map(
        this.sql
          .exec('SELECT * FROM buckets')
          .toArray()
          .map((row) => [row.bucket_key, row]),
      );
    return this.owner.liveStatsBuckets;
  }
  async query(params) {
    const safe = new URLSearchParams(params);
    for (const field of ['stage', 'before', 'fresh', 'sync', 'cache_key']) safe.delete(field);
    filters(safe, 'u', false);
    const id = safe.get('api_key_id');
    if (id && !/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, 'API 密钥 ID 无效');
    const ids = safe.has('api_key_ids') ? safe.get('api_key_ids').split(',') : null;
    if (ids && (ids.length > 51 || ids.some((id) => !/^[a-f0-9-]{36}$/.test(id))))
      throw new HttpError(400, 'API 密钥列表无效');
    await this.ensure(params.get('sync') === '1');
    // Snapshot references remain immutable during a concurrent historical refresh.
    const data = this.data;
    const accounts = new Map(data.accounts.map((row) => [row.id, row]));
    const keys = new Map(data.keys.map((row) => [row.id, row.name]));
    const aggregates = new Map(data.aggregates.map((row) => [row.key, row]));
    const represented = new Set();
    let pending = 0;
    for (const bucket of this.live().values()) {
      if (bucket.dirty) pending += JSON.parse(bucket.payload).requests;
      for (const id of JSON.parse(bucket.members)) represented.add(id);
      if (
        !aggregates.has(bucket.bucket_key) ||
        aggregates.get(bucket.bucket_key).version <= bucket.version
      )
        aggregates.set(bucket.bucket_key, {
          key: bucket.bucket_key,
          version: bucket.version,
          value: JSON.parse(bucket.payload),
        });
    }
    const date = (field) =>
      /^\d+$/.test(safe.get(field) || '') ? Number(safe.get(field)) : Date.parse(safe.get(field));
    const from = Math.max(Date.now() - 30 * 86400000, date('from') || 0);
    const to = safe.has('to') ? date('to') : Infinity;
    const rows = [];
    const accept = (row) => {
      if (row.created_at < from || row.created_at > to) return;
      if ((id && row.api_key_id !== id) || (ids && !ids.includes(row.api_key_id))) return;
      for (const field of ['credential_id', 'mode', 'model', 'request_id'])
        if (safe.get(field) && row[field] !== safe.get(field)) return;
      const status = safe.get('status');
      if (
        status &&
        (status.endsWith('xx')
          ? Math.floor(row.status / 100) !== Number(status[0])
          : row.status !== Number(status))
      )
        return;
      const current = accounts.get(row.credential_id);
      if (
        safe.get('email') &&
        !(current?.email ?? row.credential_name ?? '')
          .toLowerCase()
          .includes(safe.get('email').toLowerCase())
      )
        return;
      rows.push({
        ...row,
        display_name: current?.email || current?.name || row.credential_name || '未选中凭证',
        day: new Date(row.created_at + 8 * 3600000).toISOString().slice(0, 10),
      });
    };
    for (const aggregate of aggregates.values()) accept(aggregate.value);
    for (const row of data.details) {
      if (row.aggregate_key && represented.has(row.request_id)) continue;
      accept({
        ...row,
        requests: 1,
        successes: Number(row.outcome === 'success'),
        failures: Number(row.outcome === 'failed'),
        cancellations: Number(row.outcome === 'cancelled'),
        total_duration_ms: row.duration_ms,
        token_reports: Number(tokens.some((key) => row[key] != null)),
      });
    }
    const value = summarizeRows(rows, keys, { TELEMETRY: true }, pending);
    value.query_source = 'durable-object';
    value.cache_source = 'durable-object';
    value.history_synced_at = this.syncedAt();
    value.history_sync_seconds = HOUR / 1000;
    // Bound total query-snapshot KV writes across all filters and all Worker instances.
    const hash = params.get('cache_key');
    if (
      /^[a-f0-9]{64}$/.test(hash || '') &&
      this.owner.env.CACHE?.put &&
      Number(this.state('query_kv_at') || 0) <= Date.now() - 300000
    ) {
      this.putState('query_kv_at', Date.now());
      await writeKvStatsSnapshot(this.owner.env, hash, value);
    }
    return value;
  }
}
