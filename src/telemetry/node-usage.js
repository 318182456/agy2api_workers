// Read only the main DO's existing state. Never synchronize history or query D1 here.
export function primaryNodeSnapshot(owner, fresh = false) {
  const now = Date.now();
  if (!fresh && owner.primaryInventory?.until > now)
    return { ...owner.primaryInventory.value, activity: { ...owner.nodeActivity } };
  const dayStart = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  const buffers = owner.sql
    .exec(
      `SELECT COUNT(*) AS buckets,
    COALESCE(SUM(CASE WHEN created_at>=? THEN json_extract(payload,'$.requests') ELSE 0 END),0) AS today_requests,
    COALESCE(SUM(dirty),0) AS pending_buckets,
    COALESCE(SUM(CASE WHEN dirty=1 THEN json_extract(payload,'$.requests') ELSE 0 END),0) AS pending_requests,
    COALESCE(SUM(length(CAST(payload AS BLOB))+length(CAST(members AS BLOB))),0) AS buffer_bytes FROM buckets`,
      dayStart,
    )
    .toArray()[0];
  const quota = owner.sql
    .exec(
      'SELECT COUNT(*) AS entries,COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM quota_cache WHERE expires_at>?',
      now,
    )
    .toArray()[0];
  const history = owner.sql
    .exec('SELECT COALESCE(SUM(length(data)),0) AS bytes FROM stats_snapshot_chunks')
    .toArray()[0];
  const value = {
    available: true,
    kind: 'primary',
    day: new Date(dayStart + 8 * 3600000).toISOString().slice(0, 10),
    sampled_at: now,
    today_requests: buffers.today_requests,
    pending_buckets: buffers.pending_buckets,
    pending_requests: buffers.pending_requests,
    buffer_buckets: buffers.buckets,
    buffer_bytes: buffers.buffer_bytes,
    quota_entries: quota.entries,
    quota_bytes: quota.bytes,
    history_bytes: history.bytes,
    history_synced_at: owner.history.syncedAt() || null,
    next_flush_at: owner.alarmAt || null,
  };
  owner.primaryInventory = { until: Math.min(now + 30000, dayStart + 86400000), value };
  return { ...value, activity: { ...owner.nodeActivity } };
}
