export const LOG_RETENTION_DAYS = 7;
export async function pruneTelemetry(db) {
  await db.batch([
    // Aggregate totals survive removing expired diagnostic detail rows.
    db
      .prepare(
        `DELETE FROM request_usage WHERE created_at<? AND aggregate_key IS NOT NULL
      AND EXISTS(SELECT 1 FROM usage_aggregates a,json_each(a.members) m
        WHERE a.bucket_key=request_usage.aggregate_key AND m.value=request_usage.request_id)`,
      )
      .bind(Date.now() - LOG_RETENTION_DAYS * 86400000),
    db
      .prepare(
        'DELETE FROM request_usage WHERE created_at<? AND id IN(SELECT m.value FROM usage_daily_archive a,json_each(a.detail_ids) m)',
      )
      .bind(Date.now() - LOG_RETENTION_DAYS * 86400000),
    // Historical detailed rows still supply statistics; erase only their packed diagnostics.
    db
      .prepare(
        "UPDATE request_usage SET attempts='[]',hidden_attempts='[]',log_visible=0,failure_stage=NULL,failure_code=NULL,failure_message=NULL WHERE created_at<? AND (attempts<>'[]' OR failure_stage IS NOT NULL OR failure_code IS NOT NULL OR failure_message IS NOT NULL)",
      )
      .bind(Date.now() - LOG_RETENTION_DAYS * 86400000),
    db
      .prepare('DELETE FROM call_logs WHERE created_at<?')
      .bind(Date.now() - LOG_RETENTION_DAYS * 86400000),
    db.prepare(
      'DELETE FROM call_logs WHERE id <= (SELECT COALESCE(MAX(id),0)-2000 FROM call_logs)',
    ),
    db.prepare(
      'DELETE FROM request_usage WHERE id <= (SELECT COALESCE(MAX(id),0)-10000 FROM request_usage)',
    ),
    db.prepare('DELETE FROM request_usage WHERE created_at<?').bind(Date.now() - 30 * 86400000),
    db.prepare('DELETE FROM usage_aggregates WHERE created_at<?').bind(Date.now() - 30 * 86400000),
    db
      .prepare('DELETE FROM usage_daily_archive WHERE day<?')
      .bind(Math.floor((Date.now() - 30 * 86400000 + 28800000) / 86400000) * 86400000 - 28800000),
  ]);
}
export async function maybePrune(db, result) {
  if (
    result?.meta?.changes > 0 &&
    result.meta.last_row_id > 0 &&
    result.meta.last_row_id % 128 === 0
  )
    await pruneTelemetry(db);
}
