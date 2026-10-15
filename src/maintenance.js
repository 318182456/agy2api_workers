export const LOG_RETENTION_DAYS = 7;
export async function pruneTelemetry(db) {
  await db.batch([
    db.prepare('DELETE FROM call_logs WHERE created_at<?').bind(Date.now()-LOG_RETENTION_DAYS*86400000),
    db.prepare('DELETE FROM call_logs WHERE id <= (SELECT COALESCE(MAX(id),0)-2000 FROM call_logs)'),
    db.prepare('DELETE FROM request_usage WHERE id <= (SELECT COALESCE(MAX(id),0)-10000 FROM request_usage)'),
    db.prepare('DELETE FROM request_usage WHERE created_at<?').bind(Date.now()-30*86400000),
  ]);
}
export async function maybePrune(db,result) {
  if(result?.meta?.changes>0 && result.meta.last_row_id>0 && result.meta.last_row_id%128===0) await pruneTelemetry(db);
}
