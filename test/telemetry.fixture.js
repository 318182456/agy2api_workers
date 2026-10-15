import worker, { TelemetryBuffer as Buffer } from '../src/index.js';
export default worker;
// Test-only barrier: hold a D1 commit while a new record reaches the same real DO.
export class TelemetryBuffer extends Buffer {
  constructor(ctx, env) {
    const control = { writes: 0, reads: 0, batches: 0 };
    super(ctx, {
      ...env,
      DB: {
        prepare: (sql) => env.DB.prepare(sql),
        batch: async (statements) => {
          control.waiting = true;
          if (control.gate) await control.gate;
          const results = await env.DB.batch(statements);
          control.batches++;
          for (const result of results) {
            control.writes += result.meta.rows_written || 0;
            control.reads += result.meta.rows_read || 0;
          }
          control.waiting = false;
          return results;
        },
      },
    });
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
    } else if (path !== '/test/status') return super.fetch(request);
    return Response.json({
      waiting: !!this.control.waiting,
      writes: this.control.writes,
      reads: this.control.reads,
      batches: this.control.batches,
    });
  }
}
