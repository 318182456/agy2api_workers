import { StorageScheduler } from '../storage/schedule.js';
import { bumpRevision } from './archive.js';
import { bufferedHealth } from './live-health.js';
import { primaryNodeSnapshot } from './node-usage.js';
import { StatsHistory } from './history.js';
import { HttpError } from '../core/common.js';
const WINDOW = 300000;
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function add(target, key, value) {
  if (value != null) target[key] = (target[key] ?? 0) + value;
}
// One persistent SQLite-backed coordinator. No per-request KV writes or memory-only counters.
export class TelemetryBuffer {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.alarmAt = 0;
    this.nodeActivity = {
      started_at: Date.now(),
      requests: 0,
      reads: 0,
      writes: 0,
      errors: 0,
      last_activity: null,
    };
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS buckets(bucket_key TEXT PRIMARY KEY,version INTEGER NOT NULL,created_at INTEGER NOT NULL,payload TEXT NOT NULL,members TEXT NOT NULL,dirty INTEGER NOT NULL) WITHOUT ROWID`,
      );
      this.sql.exec(
        'CREATE INDEX IF NOT EXISTS buckets_dirty ON buckets(bucket_key) WHERE dirty=1',
      );
      this.sql.exec(
        'CREATE TABLE IF NOT EXISTS quota_cache(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,value TEXT NOT NULL) WITHOUT ROWID',
      );
      this.history = new StatsHistory(this);
      this.alarmAt = (await ctx.storage.getAlarm()) || 0;
    });
  }
  async schedule(delay = WINDOW) {
    if (this.alarmAt) return;
    this.alarmAt = Date.now() + delay;
    try {
      await this.ctx.storage.setAlarm(this.alarmAt);
    } catch {
      this.alarmAt = 0;
      console.warn(JSON.stringify({ event: 'telemetry_alarm_schedule_failed' }));
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/node-usage' && request.method === 'GET')
      return json(primaryNodeSnapshot(this, url.searchParams.get('fresh') === '1'));
    let response;
    try {
      response = await this.handle(request);
      return response;
    } finally {
      this.nodeActivity.requests++;
      this.nodeActivity[request.method === 'GET' ? 'reads' : 'writes']++;
      this.nodeActivity.last_activity = Date.now();
      if (!response || response.status >= 400) this.nodeActivity.errors++;
    }
  }
  async handle(request) {
    const path = new URL(request.url).pathname;
    if (path === '/storage-schedule' && request.method === 'POST') {
      const { nodes } = await request.json();
      if (
        !Array.isArray(nodes) ||
        nodes.length > 100 ||
        nodes.some(
          (node) =>
            !/^[a-f0-9-]{36}$/.test(node.id) ||
            !/^gcli2api-storage-[a-f0-9]{12}$/.test(node.worker_name) ||
            node.url !== 'https://' + node.worker_name + '.pages.dev' ||
            !/^[a-f0-9]{64}$/.test(node.node_secret),
        )
      )
        return json({ error: 'invalid storage nodes' }, 400);
      this.storageScheduler ||= new StorageScheduler(this);
      return json(await this.storageScheduler.resolve(nodes));
    }
    const quotaId = path.match(/^\/quota\/([a-f0-9-]{36})$/)?.[1];
    if (quotaId) {
      if (request.method === 'GET') {
        const cached = this.sql
          .exec('SELECT value FROM quota_cache WHERE id=? AND expires_at>?', quotaId, Date.now())
          .toArray()[0];
        return cached
          ? json({ ...JSON.parse(cached.value), cached: true, cacheSeconds: 600 })
          : json({ cached: false }, 404);
      }
      if (request.method === 'POST') {
        const value = await request.json();
        if (
          value.credentialId !== quotaId ||
          !['geminicli', 'antigravity'].includes(value.mode) ||
          !Number.isFinite(Date.parse(value.queriedAt)) ||
          !Array.isArray(value.models) ||
          value.models.length > 2000
        )
          return json({ error: 'invalid quota cache' }, 400);
        const safe = {
          success: true,
          credentialId: quotaId,
          mode: value.mode,
          queriedAt: value.queriedAt,
          models: value.models.map((model) =>
            Object.fromEntries(
              ['id', 'remaining', 'resetTime', 'remainingAmount', 'tokenType', 'bucketIndex']
                .filter((key) => model[key] !== undefined)
                .map((key) => [key, model[key]]),
            ),
          ),
        };
        this.sql.exec(
          'INSERT INTO quota_cache(id,expires_at,value)VALUES(?,?,?) ON CONFLICT(id)DO UPDATE SET expires_at=excluded.expires_at,value=excluded.value',
          quotaId,
          Date.now() + 600000,
          JSON.stringify(safe),
        );
        this.sql.exec('DELETE FROM quota_cache WHERE expires_at<?', Date.now());
        return json({ success: true });
      }
      return json({ error: 'method not allowed' }, 405);
    }
    if (path === '/invalidate-metadata' && request.method === 'POST') {
      const value = await request.json();
      if (value.credentialId)
        this.sql.exec('DELETE FROM quota_cache WHERE id=?', value.credentialId);
      else this.sql.exec('DELETE FROM quota_cache');
      try {
        await this.history.refreshMetadata();
        return json({ success: true });
      } catch {
        return json({ error: 'metadata synchronization unavailable' }, 503);
      }
    }
    if (path === '/stats' && request.method === 'GET') {
      try {
        return json(await this.history.query(new URL(request.url).searchParams));
      } catch (error) {
        return json(
          {
            error: {
              message:
                error instanceof HttpError
                  ? error.message
                  : '统计历史同步或查询失败，未返回不完整统计，请稍后重试',
              code: error instanceof HttpError ? error.status : 503,
            },
          },
          error instanceof HttpError ? error.status : 503,
        );
      }
    }
    if (path === '/import' && request.method === 'POST') {
      const { node_id, buckets } = await request.json();
      const metrics = [
        'requests',
        'successes',
        'failures',
        'cancellations',
        'total_duration_ms',
        'token_reports',
      ];
      if (
        !/^[a-f0-9-]{36}$/.test(node_id || '') ||
        !Array.isArray(buckets) ||
        buckets.length > 1000 ||
        buckets.some(
          (row) =>
            typeof row.key !== 'string' ||
            !new RegExp('^\\d{13}:[a-f0-9]{32}:' + node_id + '$').test(row.key) ||
            !Number.isSafeInteger(row.version) ||
            row.version < 1 ||
            row.version > 2000 ||
            !Array.isArray(row.members) ||
            row.members.length !== row.version ||
            new Set(row.members).size !== row.members.length ||
            row.members.some((id) => typeof id !== 'string' || id.length > 100) ||
            !row.value ||
            row.value.created_at !== Number(row.key.slice(0, 13)) ||
            row.value.requests !== row.version ||
            !['success', 'failed', 'cancelled'].includes(row.value.outcome) ||
            metrics.some((key) => !Number.isSafeInteger(row.value[key]) || row.value[key] < 0) ||
            ['input_tokens', 'output_tokens', 'thought_tokens', 'total_tokens'].some(
              (key) =>
                row.value[key] != null &&
                (!Number.isSafeInteger(row.value[key]) || row.value[key] < 0),
            ),
        )
      )
        return json({ error: 'invalid node telemetry' }, 400);
      let changed = 0;
      const imported = [];
      this.importVersions ||= new Map();
      this.ctx.storage.transactionSync(() => {
        for (const row of buckets) {
          if ((this.importVersions.get(row.key) || 0) >= row.version) continue;
          const previous = this.sql
            .exec('SELECT version FROM buckets WHERE bucket_key=?', row.key)
            .toArray()[0];
          if (previous?.version >= row.version) {
            this.importVersions.set(row.key, previous.version);
            continue;
          }
          this.sql.exec(
            'INSERT INTO buckets(bucket_key,version,created_at,payload,members,dirty)VALUES(?,?,?,?,?,1) ON CONFLICT(bucket_key)DO UPDATE SET version=excluded.version,payload=excluded.payload,members=excluded.members,dirty=1',
            row.key,
            row.version,
            row.value.created_at,
            JSON.stringify(row.value),
            JSON.stringify(row.members),
          );
          changed++;
          imported.push([row.key, row.version]);
          if (this.liveStatsBuckets)
            this.liveStatsBuckets.set(row.key, {
              bucket_key: row.key,
              version: row.version,
              created_at: row.value.created_at,
              payload: JSON.stringify(row.value),
              members: JSON.stringify(row.members),
              dirty: 1,
            });
        }
      });
      for (const [key, version] of imported) this.importVersions.set(key, version);
      if (changed) await this.schedule();
      if (this.importVersions.size > 5000) this.importVersions.clear();
      return json({ success: true });
    }
    if (path === '/record' && request.method === 'POST') {
      const value = await request.json();
      if (
        typeof value.key !== 'string' ||
        value.key.length > 200 ||
        typeof value.request_id !== 'string' ||
        value.request_id.length > 100 ||
        !Number.isSafeInteger(value.created_at) ||
        !Number.isSafeInteger(value.completed_at) ||
        !['success', 'failed', 'cancelled'].includes(value.outcome)
      )
        return json({ error: 'invalid telemetry' }, 400);
      let result;
      this.ctx.storage.transactionSync(() => {
        const stored = this.sql
          .exec('SELECT * FROM buckets WHERE bucket_key=?', value.key)
          .toArray()[0];
        const members = stored ? JSON.parse(stored.members) : [];
        if (members.includes(value.request_id)) {
          result = { ok: true, duplicate: true };
          return;
        }
        if (members.length >= 2000) {
          result = { error: 'bucket capacity' };
          return;
        }
        const row = stored
          ? JSON.parse(stored.payload)
          : {
              api_key_id: value.api_key_id || null,
              api_key_name: value.api_key_name || null,
              credential_id: value.credential_id,
              credential_name: value.credential_name,
              mode: value.mode,
              model: value.model,
              status: value.status,
              outcome: value.outcome,
              created_at: value.created_at,
              requests: 0,
              successes: 0,
              failures: 0,
              cancellations: 0,
              total_duration_ms: 0,
              input_tokens: null,
              output_tokens: null,
              thought_tokens: null,
              total_tokens: null,
              token_reports: 0,
              last_success: null,
            };
        row.credential_name = value.credential_name;
        row.api_key_name = value.api_key_name || null;
        row.requests++;
        row[
          value.outcome === 'success'
            ? 'successes'
            : value.outcome === 'cancelled'
              ? 'cancellations'
              : 'failures'
        ]++;
        row.total_duration_ms += value.duration_ms;
        for (const key of ['input_tokens', 'output_tokens', 'thought_tokens', 'total_tokens'])
          add(row, key, value[key]);
        if (
          ['input_tokens', 'output_tokens', 'thought_tokens', 'total_tokens'].some(
            (key) => value[key] != null,
          )
        )
          row.token_reports++;
        if (value.outcome === 'success')
          row.last_success = Math.max(row.last_success || 0, value.completed_at);
        members.push(value.request_id);
        const version = (stored?.version || 0) + 1;
        if (stored)
          this.sql.exec(
            'UPDATE buckets SET version=?,payload=?,members=?' +
              (stored.dirty ? '' : ',dirty=1') +
              ' WHERE bucket_key=?',
            version,
            JSON.stringify(row),
            JSON.stringify(members),
            value.key,
          );
        else
          this.sql.exec(
            'INSERT INTO buckets(bucket_key,version,created_at,payload,members,dirty)VALUES(?,?,?,?,?,1)',
            value.key,
            version,
            value.created_at,
            JSON.stringify(row),
            JSON.stringify(members),
          );
        if (this.liveStatsBuckets)
          this.liveStatsBuckets.set(value.key, {
            bucket_key: value.key,
            version,
            created_at: value.created_at,
            payload: JSON.stringify(row),
            members: JSON.stringify(members),
            dirty: 1,
          });
        result = { ok: true };
      });
      if (result.ok) await this.schedule();
      return json(result, result.ok ? 200 : 409);
    }
    if (path === '/snapshot') {
      const rows = this.sql
        .exec('SELECT bucket_key,version,payload,members FROM buckets WHERE dirty=1 LIMIT 5001')
        .toArray();
      if (rows.length > 5000) return json({ error: 'telemetry backlog; flush required' }, 503);
      let count = 0;
      const buckets = rows.map((row) => {
        const members = JSON.parse(row.members);
        count += members.length;
        return {
          key: row.bucket_key,
          version: row.version,
          value: JSON.parse(row.payload),
          members,
        };
      });
      if (count > 40000) return json({ error: 'telemetry backlog; flush required' }, 503);
      return json({ buckets, interval_seconds: 300 });
    }
    if (path === '/flush' && request.method === 'POST') {
      try {
        return json(await this.flush());
      } catch {
        return json({ error: 'telemetry flush failed; buffer retained' }, 503);
      }
    }
    return json({ error: 'not found' }, 404);
  }
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushBatch();
    try {
      return await this.flushing;
    } finally {
      this.flushing = null;
    }
  }
  async flushBatch() {
    let size = 0;
    const rows = this.sql
      .exec('SELECT * FROM buckets WHERE dirty=1 ORDER BY bucket_key LIMIT 25')
      .toArray()
      .filter((row) => {
        const bytes = new TextEncoder().encode(row.payload + row.members).byteLength;
        if (size && size + bytes > 512000) return false;
        size += bytes;
        return true;
      });
    let written = 0;
    if (rows.length) {
      const statements = [bumpRevision(this.env.DB)];
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO usage_aggregates(bucket_key,version,created_at,credential_id,payload,members,api_key_id,change_seq)
        SELECT json_extract(value,'$.bucket_key'),json_extract(value,'$.version'),json_extract(value,'$.created_at'),json_extract(value,'$.credential_id'),json_extract(value,'$.payload'),json_extract(value,'$.members'),json_extract(value,'$.api_key_id'),(SELECT value FROM telemetry_revision WHERE id=1)
        FROM json_each(?) WHERE true ON CONFLICT(bucket_key)DO UPDATE SET version=excluded.version,payload=excluded.payload,members=excluded.members,change_seq=excluded.change_seq WHERE version<excluded.version`,
        ).bind(
          JSON.stringify(
            rows.map((row) => ({
              ...row,
              credential_id: JSON.parse(row.payload).credential_id,
              api_key_id: JSON.parse(row.payload).api_key_id || null,
            })),
          ),
        ),
      );
      statements.push(
        this.env.DB.prepare(
          `DELETE FROM request_usage WHERE outcome='success' AND attempts='[]'
        AND aggregate_key IN(SELECT json_extract(value,'$.bucket_key') FROM json_each(?))
        AND request_id IN(SELECT m.value FROM json_each(?) b,json_each(json_extract(b.value,'$.members')) m)`,
        ).bind(JSON.stringify(rows), JSON.stringify(rows)),
      );
      const health = bufferedHealth(rows.map((row) => ({ value: JSON.parse(row.payload) })));
      const states = JSON.stringify([...health.values()]);
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO credential_health(credential_id,last_success,last_failure,last_status,last_stage,last_code,failure_streak)
        SELECT c.id,NULLIF(json_extract(j.value,'$.last_success'),0),NULLIF(json_extract(j.value,'$.last_failure'),0),json_extract(j.value,'$.last_status'),json_extract(j.value,'$.last_stage'),json_extract(j.value,'$.last_code'),CASE WHEN COALESCE(json_extract(j.value,'$.last_failure'),0)>COALESCE(json_extract(j.value,'$.last_success'),0) THEN 1 ELSE 0 END
        FROM json_each(?) j JOIN credentials c ON c.id=json_extract(j.value,'$.credential_id') WHERE true
        ON CONFLICT(credential_id)DO UPDATE SET
        last_success=NULLIF(MAX(COALESCE(last_success,0),COALESCE(excluded.last_success,0)),0),
        last_failure=NULLIF(MAX(COALESCE(last_failure,0),COALESCE(excluded.last_failure,0)),0),
        last_status=CASE WHEN COALESCE(excluded.last_failure,0)>COALESCE(last_failure,0) THEN excluded.last_status ELSE last_status END,
        last_stage=CASE WHEN COALESCE(excluded.last_failure,0)>COALESCE(last_failure,0) THEN excluded.last_stage ELSE last_stage END,
        last_code=CASE WHEN COALESCE(excluded.last_failure,0)>COALESCE(last_failure,0) THEN excluded.last_code ELSE last_code END,
        failure_streak=CASE WHEN MAX(COALESCE(last_success,0),COALESCE(excluded.last_success,0))>=MAX(COALESCE(last_failure,0),COALESCE(excluded.last_failure,0)) THEN 0 WHEN COALESCE(excluded.last_failure,0)>COALESCE(last_failure,0) THEN failure_streak+1 ELSE failure_streak END
        WHERE COALESCE(excluded.last_failure,0)>COALESCE(last_failure,0) OR COALESCE(excluded.last_success,0)>COALESCE(last_success,0)+300000 OR (last_success IS NULL AND excluded.last_success IS NOT NULL) OR (failure_streak>0 AND COALESCE(excluded.last_success,0)>=COALESCE(last_failure,0))`,
        ).bind(states),
      );
      statements.push(
        this.env.DB.prepare(
          `UPDATE credentials SET last_used=MAX(COALESCE(last_used,0),(SELECT json_extract(value,'$.last_used') FROM json_each(?) WHERE json_extract(value,'$.credential_id')=credentials.id))
        WHERE id IN(SELECT json_extract(value,'$.credential_id') FROM json_each(?) WHERE COALESCE(json_extract(value,'$.last_used'),0)>0)
        AND COALESCE(last_used,0)<(SELECT json_extract(value,'$.last_used')-300000 FROM json_each(?) WHERE json_extract(value,'$.credential_id')=credentials.id)`,
        ).bind(states, states, states),
      );
      await this.env.DB.batch(statements);
    }
    for (const row of rows) {
      // A request arriving during the D1 await changes version and remains dirty for the next flush.
      this.sql.exec(
        'UPDATE buckets SET dirty=0 WHERE bucket_key=? AND version=?',
        row.bucket_key,
        row.version,
      );
      const live = this.liveStatsBuckets?.get(row.bucket_key);
      if (live && live.version === row.version) live.dirty = 0;
      written++;
    }
    const pending = !!this.sql
      .exec('SELECT bucket_key FROM buckets WHERE dirty=1 LIMIT 1')
      .toArray().length;
    this.sql.exec(
      'DELETE FROM buckets WHERE dirty=0 AND bucket_key<?',
      String(Date.now() - 86400000).padStart(13, '0') + ':',
    );
    if (this.liveStatsBuckets)
      for (const [key, row] of this.liveStatsBuckets)
        if (!row.dirty && row.created_at < Date.now() - 86400000) this.liveStatsBuckets.delete(key);
    if (pending) await this.schedule(60000);
    return { buckets_flushed: written, pending };
  }
  async alarm() {
    this.alarmAt = 0;
    try {
      await this.flush();
    } catch {
      console.warn(JSON.stringify({ event: 'telemetry_flush_failed' }));
      await this.schedule();
    }
  }
}
