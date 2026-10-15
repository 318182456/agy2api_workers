import { telemetryStub, telemetryPayload } from './client.js';
import { maybePrune } from '../maintenance.js';

export function reportedUsage(meta) {
  const number = (key) => (Number.isSafeInteger(meta?.[key]) && meta[key] >= 0 ? meta[key] : null);
  return {
    input: number('promptTokenCount'),
    output: number('candidatesTokenCount'),
    thought: number('thoughtsTokenCount'),
    total: number('totalTokenCount'),
  };
}
export async function recordUsage(db, record) {
  if (!db) return;
  const u = reportedUsage(record.usage);
  const now = Date.now();
  try {
    const insert = db
      .prepare(
        `INSERT OR IGNORE INTO request_usage
      (request_id, credential_id, credential_name, mode, model, status, outcome, duration_ms, created_at, input_tokens, output_tokens, thought_tokens, total_tokens, attempts, aggregate_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.requestId,
        record.row?.id || null,
        record.row?.data?.user_email || record.row?.name || '',
        record.mode,
        record.model,
        record.status,
        record.outcome,
        Math.max(0, now - record.started),
        record.started,
        u.input,
        u.output,
        u.thought,
        u.total,
        JSON.stringify((record.attempts || []).slice(0, 16)),
        record.aggregateKey || null,
      );
    const statements = [insert];
    if (record.row && record.outcome === 'success')
      statements.push(
        db
          .prepare(
            `INSERT INTO credential_health (credential_id, last_success, failure_streak) SELECT id, ?, 0 FROM credentials WHERE id=? AND changes()>0
      ON CONFLICT(credential_id) DO UPDATE SET last_success=excluded.last_success, failure_streak=CASE WHEN COALESCE(last_failure,0)<=excluded.last_success THEN 0 ELSE failure_streak END WHERE last_success IS NULL OR last_success<excluded.last_success-300000 OR failure_streak>0`,
          )
          .bind(now, record.row.id),
      );
    const failures = new Map();
    for (const attempt of record.attempts || [])
      if (attempt.status >= 400 && attempt.status !== 499)
        failures.set(attempt.credential_id, attempt);
    for (const attempt of failures.values())
      statements.push(
        db
          .prepare(
            `INSERT INTO credential_health
      (credential_id,last_failure,last_status,last_stage,last_code,failure_streak) SELECT id,?,?,?,?,1 FROM credentials WHERE id=?
      ON CONFLICT(credential_id) DO UPDATE SET last_failure=excluded.last_failure,last_status=excluded.last_status,last_stage=excluded.last_stage,last_code=excluded.last_code,failure_streak=failure_streak+1
      WHERE last_failure IS NULL OR last_failure<excluded.last_failure-60000 OR last_status IS NOT excluded.last_status OR last_stage IS NOT excluded.last_stage OR last_code IS NOT excluded.last_code OR COALESCE(last_success,0)>=last_failure`,
          )
          .bind(
            attempt.created_at,
            attempt.status,
            attempt.stage,
            attempt.detail_code,
            attempt.credential_id,
          ),
      );
    const results = await db.batch(statements);
    await maybePrune(db, results[0]);
  } catch {
    console.warn(JSON.stringify({ event: 'usage_save_failed', requestId: record.requestId }));
  }
}
export async function recordTelemetry(env, record) {
  const stub = telemetryStub(env);
  if (!stub || env.USAGE_STORAGE_MODE === 'detailed') return recordUsage(env.DB, record);
  const payload = await telemetryPayload(record);
  let accepted = false,
    uncertain = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await stub.fetch('https://telemetry/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        accepted = true;
        break;
      }
      if (response.status === 409) {
        uncertain = false;
        break;
      }
      uncertain = true;
    } catch {
      uncertain = true;
    }
  }
  // Clean successful requests have no D1 detail rows. Errors/cancellations/retry diagnostics remain available.
  if (accepted && record.outcome === 'success' && !record.attempts?.length) return;
  if (!accepted)
    console.warn(
      JSON.stringify({ event: 'telemetry_buffer_fallback', requestId: record.requestId }),
    );
  return recordUsage(env.DB, {
    ...record,
    aggregateKey: accepted || uncertain ? payload.key : null,
  });
}
