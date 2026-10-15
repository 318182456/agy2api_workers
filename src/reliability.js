import { HttpError } from './common.js';
import { filters, credentialJoin } from './filters.js';

export function cooldownSeconds(response, now = Date.now()) {
  const value = response.headers.get('retry-after');
  let seconds;
  if (value && /^\d+(?:\.\d+)?$/.test(value.trim())) seconds = Number(value);
  else if (value && Number.isFinite(Date.parse(value))) seconds = Math.ceil((Date.parse(value) - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = response.status === 429 ? 60 : 10;
  return Math.min(86400, Math.max(1, Math.ceil(seconds)));
}
export async function putCooldown(db, row, model, status, seconds) {
  await db.prepare(`INSERT INTO credential_cooldowns (credential_id, model, until_ms, status) VALUES (?, ?, ?, ?)
    ON CONFLICT(credential_id, model) DO UPDATE SET until_ms=MAX(until_ms, excluded.until_ms), status=excluded.status`)
    .bind(row.id, model, Date.now() + seconds * 1000, status).run();
}
export async function recordAttempt(db, record) {
  try {
    await db.prepare(`INSERT INTO call_logs (request_id, credential_id, credential_name, mode, model, status, stage, duration_ms, created_at, detail_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(record.requestId, record.row.id, record.row.data?.user_email || record.row.name || '', record.mode, record.model, record.status,
        record.stage, Math.max(0, Date.now() - record.started), Date.now(), record.code || null).run();
    if (record.status >= 400 && record.status !== 499) await db.prepare(`INSERT INTO credential_health (credential_id,last_failure,last_status,last_stage,last_code,failure_streak) SELECT id,?,?,?,?,1 FROM credentials WHERE id=?
      ON CONFLICT(credential_id) DO UPDATE SET last_failure=excluded.last_failure,last_status=excluded.last_status,last_stage=excluded.last_stage,last_code=excluded.last_code,failure_streak=failure_streak+1`)
      .bind(Date.now(),record.status,record.stage,record.code || null,record.row.id).run();
    // Indexed primary-key range pruning, avoiding a full COUNT or an OFFSET scan per call.
    await db.prepare('DELETE FROM call_logs WHERE id <= (SELECT COALESCE(MAX(id), 0) - 2000 FROM call_logs)').run();
  } catch {
    // Logging must not replace a successful model response or trigger another generation.
    console.warn(JSON.stringify({ event: 'call_log_save_failed', requestId: record.requestId }));
  }
}
function logRow(row) {
  const email = typeof row.credential_email === 'string' && row.credential_email ? row.credential_email : null;
  const name = row.current_credential_name || row.credential_name || '已删除凭证';
  return { ...row, credential_name: name, credential_email: email, display_name: email || name };
}
export async function queryCallLogs(db, params, exporting = false) {
  const { where, values } = filters(params);
  const limit = exporting ? 2000 : 50;
  const sql = `SELECT l.*, c.name AS current_credential_name,
    CASE WHEN json_valid(c.data) THEN json_extract(c.data, '$.user_email') END AS credential_email
    FROM call_logs l` + credentialJoin('l') + where + ` ORDER BY l.id DESC LIMIT ${limit+1}`;
  const result = await db.prepare(sql).bind(...values).all();
  const rows = result.results.slice(0,limit).map(logRow);
  return { records: rows, next: result.results.length>limit ? rows.at(-1).id : null, ...(exporting ? { truncated: result.results.length>limit } : {}) };
}
export async function clearCallLogs(db, params, body) {
  if (body.confirm !== 'delete-matching-logs') throw new HttpError(400, '需明确确认删除筛选匹配的日志');
  const { where, values } = filters(params, 'l', false);
  const result = await db.prepare('DELETE FROM call_logs WHERE id IN (SELECT l.id FROM call_logs l' + credentialJoin('l') + where + ')').bind(...values).run();
  return { success: true, deleted: result.meta.changes };
}
