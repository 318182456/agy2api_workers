export function bufferedHealth(buckets) {
  const result = new Map();
  const merge = (id, value) => {
    if (!id) return;
    const row = result.get(id) || {
      credential_id: id,
      last_success: 0,
      last_failure: 0,
      last_used: 0,
    };
    row.last_success = Math.max(row.last_success || 0, value.last_success || 0);
    row.last_used = Math.max(row.last_used || 0, value.last_used || 0);
    if (value.last_failure > (row.last_failure || 0))
      for (const key of ['last_failure', 'last_status', 'last_stage', 'last_code'])
        row[key] = value[key] ?? null;
    result.set(id, row);
  };
  for (const { value } of buckets) {
    merge(value.credential_id, value);
    for (const [id, failure] of Object.entries(value.attempt_health || {})) merge(id, failure);
  }
  return result;
}
export function combineHealth(stored, live, id) {
  if (!live) return stored;
  const value = { ...(stored || {}), credential_id: id };
  value.last_success = Math.max(value.last_success || 0, live.last_success || 0) || null;
  if (live.last_failure > (value.last_failure || 0)) {
    for (const key of ['last_failure', 'last_status', 'last_stage', 'last_code'])
      value[key] = live[key] ?? null;
    value.failure_streak = Math.max(1, value.failure_streak || 0);
  }
  if (value.last_success && value.last_success >= (value.last_failure || 0))
    value.failure_streak = 0;
  return value;
}
