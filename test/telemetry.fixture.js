import worker, { TelemetryBuffer as Buffer } from '../src/index.js';
export default worker;
// Test-only barrier: hold a D1 commit while a new record reaches the same real DO.
export class TelemetryBuffer extends Buffer {
  constructor(ctx, env) {
    const control = { writes: 0, reads: 0, batches: 0 };
    const storage = ctx.storage;
    const sql = {
      exec: (...args) => {
        const cursor = storage.sql.exec(...args);
        control.sqlWrites = (control.sqlWrites || 0) + cursor.rowsWritten;
        return {
          toArray: () => {
            const rows = cursor.toArray();
            control.sqlReads = (control.sqlReads || 0) + cursor.rowsRead;
            return rows;
          },
        };
      },
    };
    super(
      {
        storage: {
          sql,
          getAlarm: () => storage.getAlarm(),
          setAlarm: (...args) => storage.setAlarm(...args),
          transactionSync: (fn) => storage.transactionSync(fn),
        },
        blockConcurrencyWhile: (fn) => ctx.blockConcurrencyWhile(fn),
      },
      {
        ...env,
        CACHE: env.CACHE && {
          get: (...args) => env.CACHE.get(...args),
          put: async (...args) => {
            control.kvWrites = (control.kvWrites || 0) + 1;
            if (control.failKv) throw new Error('test KV unavailable');
            return env.CACHE.put(...args);
          },
        },
        DB: {
          prepare: (sql) => {
            const wrap = (raw) => ({
              raw,
              bind: (...values) => wrap(raw.bind(...values)),
              all: async () => {
                if (control.failHistory) throw new Error('test history unavailable');
                const value = await raw.all();
                control.queries = (control.queries || 0) + 1;
                control.queryReads = (control.queryReads || 0) + (value.meta.rows_read || 0);
                return value;
              },
              first: (...values) => raw.first(...values),
              run: () => raw.run(),
            });
            return wrap(env.DB.prepare(sql));
          },
          batch: async (statements) => {
            control.waiting = true;
            if (control.gate) await control.gate;
            const results = await env.DB.batch(
              statements.map((statement) => statement.raw || statement),
            );
            control.batches++;
            control.statements = (control.statements || 0) + statements.length;
            for (const result of results) {
              control.writes += result.meta.rows_written || 0;
              control.reads += result.meta.rows_read || 0;
            }
            control.waiting = false;
            return results;
          },
        },
      },
    );
    this.control = control;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/test/block')
      this.control.gate = new Promise((resolve) => {
        this.control.release = resolve;
      });
    else if (path === '/test/release') {
      this.control.release();
      this.control.gate = null;
    } else if (path === '/test/expire-history') {
      this.history.putState('synced_at', 0);
    } else if (path === '/test/expire-query-kv') this.history.putState('query_kv_at', 0);
    else if (path === '/test/forget-history') {
      this.sql.exec('DELETE FROM stats_snapshot_chunks');
      this.history.data = null;
      this.history.loaded = false;
    } else if (path === '/test/fail-kv') this.control.failKv = true;
    else if (path === '/test/fail-history') this.control.failHistory = true;
    else if (path === '/test/recover-history') this.control.failHistory = false;
    else if (path === '/test/expire-quota') this.sql.exec('UPDATE quota_cache SET expires_at=0');
    else if (path !== '/test/status') return super.fetch(request);
    return Response.json({
      waiting: !!this.control.waiting,
      writes: this.control.writes,
      reads: this.control.reads,
      batches: this.control.batches,
      statements: this.control.statements || 0,
      queries: this.control.queries || 0,
      queryReads: this.control.queryReads || 0,
      sqlReads: this.control.sqlReads || 0,
      sqlWrites: this.control.sqlWrites || 0,
      kvWrites: this.control.kvWrites || 0,
    });
  }
}
