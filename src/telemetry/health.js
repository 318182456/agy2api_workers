import { bufferedHealth, combineHealth } from './live-health.js';
import { pendingTelemetry } from './client.js';

export async function credentialHealth(db, id, env = {}) {
  const stored = await db
    .prepare(
      `SELECT h.*,(SELECT created_at+duration_ms FROM request_usage WHERE credential_id=c.id AND outcome='success' ORDER BY created_at DESC LIMIT 1) AS observed_success FROM credentials c LEFT JOIN credential_health h ON h.credential_id=c.id WHERE c.id=?`,
    )
    .bind(id)
    .first();
  let health = null;
  if (stored && (stored.credential_id || stored.observed_success)) {
    const { observed_success, ...fields } = stored;
    health = {
      ...fields,
      credential_id: id,
      last_success: Math.max(fields.last_success || 0, observed_success || 0) || null,
    };
    if (health.last_success && health.last_success >= (health.last_failure || 0))
      health.failure_streak = 0;
  }
  const cooldowns = await db
    .prepare(
      'SELECT model, until_ms, status FROM credential_cooldowns WHERE credential_id=? AND until_ms>? ORDER BY until_ms',
    )
    .bind(id, Date.now())
    .all();
  const aggregate = await db
    .prepare(
      "SELECT json_extract(payload,'$.last_success') AS last_success FROM usage_aggregates WHERE credential_id=? AND json_extract(payload,'$.last_success') IS NOT NULL ORDER BY json_extract(payload,'$.last_success') DESC LIMIT 1",
    )
    .bind(id)
    .first();
  const snapshot = await pendingTelemetry(env);
  const observed = Math.max(
    aggregate?.last_success || 0,
    ...snapshot.buckets
      .filter((bucket) => bucket.value.credential_id === id)
      .map((bucket) => bucket.value.last_success || 0),
  );
  if (observed) {
    health ||= { credential_id: id, last_failure: null, failure_streak: 0 };
    health.last_success = Math.max(health.last_success || 0, observed);
    if (health.last_success >= (health.last_failure || 0)) health.failure_streak = 0;
  }
  health = combineHealth(health, bufferedHealth(snapshot.buckets).get(id), id);
  return { health, cooldowns: cooldowns.results };
}
