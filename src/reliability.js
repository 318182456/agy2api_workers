import { HttpError } from './common.js';
import { maybePrune, LOG_RETENTION_DAYS } from './maintenance.js';
import { filters, credentialJoin } from './filters.js';

function quotaDuration(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const input = value.trim();
  if (!/^(?:\d+(?:\.\d+)?[dhms]\s*)+$/.test(input)) return null;
  const units = { d: 86400, h: 3600, m: 60, s: 1 };
  return [...input.matchAll(/(\d+(?:\.\d+)?)([dhms])/g)].reduce(
    (sum, match) => sum + Number(match[1]) * units[match[2]],
    0,
  );
}
export function cooldownSeconds(response, now = Date.now(), body) {
  const value = response.headers.get('retry-after');
  let seconds;
  if (value && /^\d+(?:\.\d+)?$/.test(value.trim())) seconds = Number(value);
  else if (value && Number.isFinite(Date.parse(value)))
    seconds = Math.ceil((Date.parse(value) - now) / 1000);
  const candidates = Number.isFinite(seconds) && seconds > 0 ? [seconds] : [];
  const details = body?.error?.details;
  if ([429, 503].includes(response.status) && Array.isArray(details)) {
    for (const detail of details.slice(0, 50)) {
      if (detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo') {
        const metadata = detail.metadata;
        const reset =
          typeof metadata?.quotaResetTimeStamp === 'string'
            ? Date.parse(metadata.quotaResetTimeStamp)
            : NaN;
        if (Number.isFinite(reset) && reset > now) candidates.push((reset - now) / 1000);
        const delay = quotaDuration(metadata?.quotaResetDelay);
        if (delay > 0) candidates.push(delay);
      } else if (detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
        const delay = quotaDuration(detail.retryDelay);
        if (delay > 0) candidates.push(delay);
      }
    }
  }
  return Math.min(
    7 * 86400,
    Math.max(
      1,
      Math.ceil(candidates.length ? Math.max(...candidates) : response.status === 429 ? 60 : 10),
    ),
  );
}
// Error-body inspection is bounded and optional. Preserve the original response for the client.
export async function quotaCooldown(response, signal, now = Date.now()) {
  if (
    ![429, 503].includes(response.status) ||
    signal?.aborted ||
    !/application\/(?:json|[a-z0-9.+-]+\+json)/i.test(response.headers.get('content-type') || '')
  )
    return cooldownSeconds(response, now);
  let reader, timer, onAbort;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return cooldownSeconds(response, now);
    const stop = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 1000);
      onAbort = () => resolve(null);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) resolve(null);
    });
    const read = async () => {
      const decoder = new TextDecoder();
      let bytes = 0,
        text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) return null;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    return cooldownSeconds(response, now, await Promise.race([read(), stop]));
  } catch {
    return cooldownSeconds(response, now);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    // Do not await cancellation of a cloned branch: its sibling is returned to the client.
    reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
export async function putCooldown(db, row, model, status, seconds) {
  await db
    .prepare(
      `INSERT INTO credential_cooldowns (credential_id, model, until_ms, status) VALUES (?, ?, ?, ?)
    ON CONFLICT(credential_id, model) DO UPDATE SET until_ms=MAX(until_ms, excluded.until_ms), status=excluded.status`,
    )
    .bind(row.id, model, Date.now() + seconds * 1000, status)
    .run();
}
export async function recordAttempt(db, record, collector) {
  // Successful final requests are already persisted by recordUsage; no duplicate events.
  if (record.status < 400) return;
  if (Array.isArray(collector?.attempts)) {
    const attempt = {
      credential_id: record.row.id,
      credential_name: record.row.data?.user_email || record.row.name || '',
      mode: record.mode,
      model: record.model,
      status: record.status,
      stage: record.stage,
      duration_ms: Math.max(0, Date.now() - record.started),
      created_at: Date.now(),
      detail_code: record.code || null,
      ...(typeof record.detailMessage === 'string'
        ? { detail_message: record.detailMessage.slice(0, 500) }
        : {}),
    };
    if (collector.attempts.length < 16) collector.attempts.push(attempt);
    return;
  }
  try {
    const result = await db
      .prepare(
        `INSERT INTO call_logs (request_id, credential_id, credential_name, mode, model, status, stage, duration_ms, created_at, detail_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.requestId,
        record.row.id,
        record.row.data?.user_email || record.row.name || '',
        record.mode,
        record.model,
        record.status,
        record.stage,
        Math.max(0, Date.now() - record.started),
        Date.now(),
        record.code || null,
      )
      .run();
    if (record.status >= 400 && record.status !== 499)
      await db
        .prepare(
          `INSERT INTO credential_health (credential_id,last_failure,last_status,last_stage,last_code,failure_streak) SELECT id,?,?,?,?,1 FROM credentials WHERE id=?
      ON CONFLICT(credential_id) DO UPDATE SET last_failure=excluded.last_failure,last_status=excluded.last_status,last_stage=excluded.last_stage,last_code=excluded.last_code,failure_streak=failure_streak+1`,
        )
        .bind(Date.now(), record.status, record.stage, record.code || null, record.row.id)
        .run();
    await maybePrune(db, result);
  } catch {
    // Logging must not replace a successful model response or trigger another generation.
    console.warn(JSON.stringify({ event: 'call_log_save_failed', requestId: record.requestId }));
  }
}
function logRow(row) {
  const email =
    typeof row.credential_email === 'string' && row.credential_email ? row.credential_email : null;
  const name = row.current_credential_name || row.credential_name || '已删除凭证';
  return { ...row, credential_name: name, credential_email: email, display_name: email || name };
}
// Keep a bounded view of recent final requests, alongside retained retry/error events.
const events = `WITH events AS (
 SELECT id,request_id,credential_id,credential_name,mode,model,status,stage,duration_ms,created_at,detail_code,0 AS event_source,NULL AS parent_id,NULL AS attempt_index,0 AS retried,NULL AS detail_message FROM call_logs WHERE created_at>=CAST(strftime('%s','now') AS INTEGER)*1000-${LOG_RETENTION_DAYS * 86400000}
 UNION ALL
 SELECT id,request_id,credential_id,credential_name,mode,model,status,
   CASE outcome WHEN 'success' THEN 'completed' WHEN 'cancelled' THEN 'client_cancelled' ELSE 'request_failed' END AS stage,
   duration_ms,created_at+duration_ms AS created_at,NULL AS detail_code,1 AS event_source,id AS parent_id,NULL AS attempt_index,(attempts<>'[]') AS retried,NULL AS detail_message FROM request_usage
 WHERE log_visible=1 AND created_at+duration_ms>=CAST(strftime('%s','now') AS INTEGER)*1000-${LOG_RETENTION_DAYS * 86400000} AND id>(SELECT COALESCE(MAX(id),0)-2000 FROM request_usage)
 UNION ALL
 SELECT u.id*32+CAST(j.key AS INTEGER) AS id,u.request_id,
 json_extract(j.value,'$.credential_id'),json_extract(j.value,'$.credential_name'),json_extract(j.value,'$.mode'),json_extract(j.value,'$.model'),
 json_extract(j.value,'$.status'),json_extract(j.value,'$.stage'),json_extract(j.value,'$.duration_ms'),json_extract(j.value,'$.created_at'),
 json_extract(j.value,'$.detail_code'),2 AS event_source,u.id AS parent_id,CAST(j.key AS INTEGER) AS attempt_index,1 AS retried,json_extract(j.value,'$.detail_message') AS detail_message
 FROM request_usage u,json_each(u.attempts) j
 WHERE u.id>(SELECT COALESCE(MAX(id),0)-2000 FROM request_usage)
 AND json_extract(j.value,'$.created_at')>=CAST(strftime('%s','now') AS INTEGER)*1000-${LOG_RETENTION_DAYS * 86400000}
 AND NOT EXISTS(SELECT 1 FROM json_each(u.hidden_attempts) hidden WHERE CAST(hidden.value AS INTEGER)=CAST(j.key AS INTEGER))
)`;
function eventFilters(params, cursor = true) {
  const result = filters(params, 'l', false);
  if (params.get('issues') === '1')
    result.where += (result.where ? ' AND ' : ' WHERE ') + '(l.status>=400 OR l.retried=1)';
  const before = params.get('before');
  if (cursor && before) {
    const match = before.match(/^(\d+):([012]):(\d+)$/);
    if (!match || ![match[1], match[3]].every((n) => Number.isSafeInteger(Number(n))))
      throw new HttpError(400, '分页游标已更新，请重新加载最新记录');
    const [time, source, id] = match.slice(1).map(Number);
    result.where +=
      (result.where ? ' AND ' : ' WHERE ') +
      '(l.created_at<? OR (l.created_at=? AND (l.event_source<? OR (l.event_source=? AND l.id<?))))';
    result.values.push(time, time, source, source, id);
  }
  return result;
}
export async function queryCallLogs(db, params, exporting = false) {
  const { where, values } = eventFilters(params);
  const limit = exporting ? 2000 : 50;
  const sql =
    events +
    `, page AS (SELECT l.*,c.name AS current_credential_name,CASE WHEN json_valid(c.data) THEN json_extract(c.data,'$.user_email') END AS credential_email FROM events l` +
    credentialJoin('l') +
    where +
    ` ORDER BY l.created_at DESC,l.event_source DESC,l.id DESC LIMIT ${limit + 1})
      SELECT p.*,u.api_key_id,COALESCE(k.name,u.api_key_name) AS api_key_name FROM page p
      LEFT JOIN request_usage u ON u.request_id=p.request_id
      LEFT JOIN api_keys k ON k.id=u.api_key_id
      ORDER BY p.created_at DESC,p.event_source DESC,p.id DESC`;
  const result = await db
    .prepare(sql)
    .bind(...values)
    .all();
  const rows = result.results.slice(0, limit).map(logRow);
  const last = rows.at(-1);
  return {
    records: rows,
    next:
      result.results.length > limit ? `${last.created_at}:${last.event_source}:${last.id}` : null,
    ...(exporting ? { truncated: result.results.length > limit } : {}),
  };
}
export async function clearCallLogs(db, params, body) {
  if (body.confirm !== 'delete-matching-logs')
    throw new HttpError(400, '需明确确认删除筛选匹配的日志');
  const { where, values } = eventFilters(params, false);
  const matching =
    events + ', matching AS (SELECT l.* FROM events l' + credentialJoin('l') + where + ') ';
  const results = await db.batch([
    db.prepare(matching + 'SELECT COUNT(*) AS count FROM matching').bind(...values),
    db
      .prepare(
        matching +
          'DELETE FROM call_logs WHERE id IN (SELECT id FROM matching WHERE event_source=0)',
      )
      .bind(...values),
    db
      .prepare(
        matching +
          'UPDATE request_usage SET log_visible=0 WHERE id IN (SELECT id FROM matching WHERE event_source=1)',
      )
      .bind(...values),
    db
      .prepare(
        matching +
          `UPDATE request_usage SET hidden_attempts=(
      SELECT json_group_array(value) FROM (SELECT value FROM json_each(request_usage.hidden_attempts)
      UNION SELECT attempt_index AS value FROM matching WHERE event_source=2 AND parent_id=request_usage.id))
      WHERE id IN (SELECT parent_id FROM matching WHERE event_source=2)`,
      )
      .bind(...values),
  ]);
  return { success: true, deleted: results[0].results[0].count };
}
