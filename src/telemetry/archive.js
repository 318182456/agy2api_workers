import { DailyStatsIndex, dayStart } from './preaggregate.js';
export const DAY = 86400000;
export const bumpRevision = (db) =>
  db.prepare('UPDATE telemetry_revision SET value=value+1 WHERE id=1');
export async function encodeArchive(value) {
  return new Response(
    new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
}
export async function decodeArchive(bytes) {
  return new Response(
    new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).json();
}
export function aggregateEntry(row) {
  return {
    key: row.bucket_key,
    version: row.version,
    members: JSON.parse(row.members),
    value: {
      ...JSON.parse(row.payload),
      created_at: row.created_at,
      credential_id: row.credential_id,
      api_key_id: row.api_key_id,
    },
  };
}
// Bounded maintenance: one day / at most 200 buckets per pass. Deletes only versions
// actually archived in the same atomic D1 batch; concurrent late updates remain hot.
export async function archiveUsage(db) {
  const cutoff = dayStart(Date.now() - 2 * DAY);
  const rows = (
    await db
      .prepare(
        'SELECT bucket_key,version,created_at,credential_id,api_key_id,payload,members FROM usage_aggregates WHERE created_at<? ORDER BY created_at LIMIT 200',
      )
      .bind(cutoff)
      .all()
  ).results;
  if (!rows.length) return { archived: 0 };
  const day = dayStart(rows[0].created_at),
    selected = rows.filter((row) => dayStart(row.created_at) === day);
  let size = 0;
  const bounded = selected.filter((row) => {
    const bytes = new TextEncoder().encode(row.payload + row.members).byteLength;
    if (size && size + bytes > 512000) return false;
    size += bytes;
    return true;
  });
  const entries = bounded.map(aggregateEntry);
  const groups = new DailyStatsIndex({ aggregates: entries, details: [] }).query(
    day,
    day + DAY - 1,
  ).rows;
  const bytes = await encodeArchive({ entries, groups });
  if (bytes.byteLength > 900000) return { archived: 0 };
  const detailIds = (
    await db
      .prepare(
        'SELECT id FROM request_usage WHERE aggregate_key IN(SELECT value FROM json_each(?)) AND request_id IN(SELECT value FROM json_each(?))',
      )
      .bind(
        JSON.stringify(entries.map((entry) => entry.key)),
        JSON.stringify(entries.flatMap((entry) => entry.members)),
      )
      .all()
  ).results.map((row) => row.id);
  await db.batch([
    bumpRevision(db),
    db
      .prepare(
        'INSERT INTO usage_daily_archive(archive_key,day,change_seq,payload,detail_ids)VALUES(?,?,(SELECT value FROM telemetry_revision WHERE id=1),?,?)',
      )
      .bind(crypto.randomUUID(), day, Array.from(new Uint8Array(bytes)), JSON.stringify(detailIds)),
    db
      .prepare(
        "DELETE FROM usage_aggregates WHERE (bucket_key,version) IN(SELECT json_extract(value,'$.key'),json_extract(value,'$.version') FROM json_each(?))",
      )
      .bind(JSON.stringify(entries.map((entry) => ({ key: entry.key, version: entry.version })))),
  ]);
  return { archived: entries.length };
}
export async function archivedEntries(db, from = Date.now() - 30 * DAY, to = Date.now()) {
  const rows = (
    await db
      .prepare('SELECT payload FROM usage_daily_archive WHERE day>=? AND day<=? ORDER BY day')
      .bind(dayStart(from), dayStart(to))
      .all()
  ).results;
  const entries = new Map();
  for (const row of rows)
    for (const entry of (await decodeArchive(row.payload)).entries)
      if ((entries.get(entry.key)?.version || 0) < entry.version) entries.set(entry.key, entry);
  return entries;
}
