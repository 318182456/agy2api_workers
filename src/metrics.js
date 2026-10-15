import { filters, credentialJoin, displayName } from './filters.js';
export function reportedUsage(meta) {
  const number = key => Number.isSafeInteger(meta?.[key]) && meta[key] >= 0 ? meta[key] : null;
  return { input: number('promptTokenCount'), output: number('candidatesTokenCount'), thought: number('thoughtsTokenCount'), total: number('totalTokenCount') };
}
export async function recordUsage(db, record) {
  if (!db) return;
  const u = reportedUsage(record.usage);
  const now = Date.now();
  try {
    const insert = db.prepare(`INSERT OR IGNORE INTO request_usage
      (request_id, credential_id, credential_name, mode, model, status, outcome, duration_ms, created_at, input_tokens, output_tokens, thought_tokens, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(record.requestId, record.row?.id || null, record.row?.data?.user_email || record.row?.name || '', record.mode, record.model,
        record.status, record.outcome, Math.max(0, now-record.started), record.started, u.input, u.output, u.thought, u.total);
    const statements = [insert];
    if (record.row && record.outcome === 'success') statements.push(db.prepare(`INSERT INTO credential_health (credential_id, last_success, failure_streak) SELECT id, ?, 0 FROM credentials WHERE id=?
      ON CONFLICT(credential_id) DO UPDATE SET last_success=excluded.last_success, failure_streak=CASE WHEN COALESCE(last_failure,0)<=excluded.last_success THEN 0 ELSE failure_streak END`).bind(now,record.row.id));
    statements.push(db.prepare('DELETE FROM request_usage WHERE created_at<? OR id <= (SELECT COALESCE(MAX(id),0)-10000 FROM request_usage)').bind(now-30*86400000));
    await db.batch(statements);
  } catch { console.warn(JSON.stringify({ event: 'usage_save_failed', requestId: record.requestId })); }
}
const aggregates = `COUNT(*) AS requests, SUM(u.outcome='success') AS successes, SUM(u.outcome='failed') AS failures,
  SUM(u.outcome='cancelled') AS cancellations, ROUND(AVG(u.duration_ms)) AS avg_duration_ms,
  SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(u.thought_tokens) AS thought_tokens,
  SUM(u.total_tokens) AS total_tokens, SUM(u.input_tokens IS NOT NULL OR u.output_tokens IS NOT NULL OR u.thought_tokens IS NOT NULL OR u.total_tokens IS NOT NULL) AS token_reports`;
export async function usageStats(db, params) {
  // Stats use final requests, never response-header or retry records.
  const safe = new URLSearchParams(params); safe.delete('stage'); safe.delete('before');
  if (!safe.has('from')) safe.set('from',String(Date.now()-30*86400000));
  const { where, values } = filters(safe, 'u', false);
  values.push(Date.now()-30*86400000);
  const source = ' FROM request_usage u' + credentialJoin('u') + where + (where ? ' AND ' : ' WHERE ') + 'u.created_at>=?';
  const queries = [
    `SELECT ${aggregates}${source}`,
    `SELECT u.model, u.mode, ${aggregates}${source} GROUP BY u.mode,u.model ORDER BY requests DESC LIMIT 201`,
    `SELECT u.credential_id, ${displayName('u')} AS display_name, ${aggregates}${source} GROUP BY u.credential_id ORDER BY requests DESC LIMIT 201`,
    `SELECT strftime('%Y-%m-%d',u.created_at/1000,'unixepoch','+8 hours') AS day, ${aggregates}${source} GROUP BY day ORDER BY day`,
  ];
  const result = await db.batch(queries.map(sql => db.prepare(sql).bind(...values)));
  return { summary: result[0].results[0], models: result[1].results.slice(0,200), credentials: result[2].results.slice(0,200), days: result[3].results,
    groups_truncated: result[1].results.length>200 || result[2].results.length>200, retention: { days: 30, max_requests: 10000 }, timezone: 'Asia/Shanghai' };
}
export async function credentialHealth(db, id) {
  const health = await db.prepare('SELECT * FROM credential_health WHERE credential_id=?').bind(id).first();
  const cooldowns = await db.prepare('SELECT model, until_ms, status FROM credential_cooldowns WHERE credential_id=? AND until_ms>? ORDER BY until_ms').bind(id, Date.now()).all();
  return { health, cooldowns: cooldowns.results };
}
