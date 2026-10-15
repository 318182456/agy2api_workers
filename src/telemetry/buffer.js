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
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS buckets(bucket_key TEXT PRIMARY KEY,version INTEGER NOT NULL,created_at INTEGER NOT NULL,payload TEXT NOT NULL,members TEXT NOT NULL,dirty INTEGER NOT NULL) WITHOUT ROWID`,
      );
      this.sql.exec(
        'CREATE INDEX IF NOT EXISTS buckets_dirty ON buckets(bucket_key) WHERE dirty=1',
      );
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
    const path = new URL(request.url).pathname;
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
    const rows = this.sql
      .exec('SELECT * FROM buckets WHERE dirty=1 ORDER BY bucket_key LIMIT 25')
      .toArray();
    let written = 0;
    for (const row of rows) {
      const payload = JSON.parse(row.payload),
        statements = [
          this.env.DB.prepare(
            `INSERT INTO usage_aggregates(bucket_key,version,created_at,credential_id,payload,members)VALUES(?,?,?,?,?,?) ON CONFLICT(bucket_key) DO UPDATE SET version=excluded.version,payload=excluded.payload,members=excluded.members WHERE version<excluded.version`,
          ).bind(
            row.bucket_key,
            row.version,
            row.created_at,
            payload.credential_id,
            row.payload,
            row.members,
          ),
          this.env.DB.prepare(
            `DELETE FROM request_usage WHERE aggregate_key=? AND outcome='success' AND attempts='[]' AND request_id IN (SELECT value FROM json_each(?))`,
          ).bind(row.bucket_key, row.members),
        ];
      if (payload.credential_id && payload.last_success)
        statements.push(
          this.env.DB.prepare(
            `INSERT INTO credential_health(credential_id,last_success,failure_streak)SELECT id,?,0 FROM credentials WHERE id=? ON CONFLICT(credential_id)DO UPDATE SET last_success=MAX(COALESCE(last_success,0),excluded.last_success),failure_streak=CASE WHEN COALESCE(last_failure,0)<=excluded.last_success THEN 0 ELSE failure_streak END WHERE last_success IS NULL OR last_success<excluded.last_success-300000 OR failure_streak>0`,
          ).bind(payload.last_success, payload.credential_id),
        );
      await this.env.DB.batch(statements);
      // A request arriving during the D1 await changes version and remains dirty for the next flush.
      this.sql.exec(
        'UPDATE buckets SET dirty=0 WHERE bucket_key=? AND version=?',
        row.bucket_key,
        row.version,
      );
      written++;
    }
    const pending = !!this.sql
      .exec('SELECT bucket_key FROM buckets WHERE dirty=1 LIMIT 1')
      .toArray().length;
    this.sql.exec(
      'DELETE FROM buckets WHERE dirty=0 AND bucket_key<?',
      String(Date.now() - 86400000).padStart(13, '0') + ':',
    );
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
