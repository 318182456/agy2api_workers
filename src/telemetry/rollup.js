const sums = [
  'requests',
  'successes',
  'failures',
  'cancellations',
  'total_duration_ms',
  'input_tokens',
  'output_tokens',
  'thought_tokens',
  'total_tokens',
  'token_reports',
];
function combine(target, row) {
  for (const key of sums) if (row[key] != null) target[key] = (target[key] ?? 0) + row[key];
  return target;
}
function finish(row) {
  const { total_duration_ms, ...result } = row;
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    cancellations: 0,
    token_reports: 0,
    input_tokens: null,
    output_tokens: null,
    thought_tokens: null,
    total_tokens: null,
    ...result,
    avg_duration_ms: row.requests ? Math.round(total_duration_ms / row.requests) : null,
  };
}

export function summarizeRows(rows, keyLookup, env = {}, pendingRequests = 0) {
  const summary = {};
  const models = new Map(),
    credentials = new Map(),
    days = new Map(),
    apiKeys = new Map();
  for (const row of rows) {
    row.api_key_id ||= null;
    combine(summary, row);
    if (!apiKeys.has(row.api_key_id))
      apiKeys.set(row.api_key_id, {
        api_key_id: row.api_key_id,
        display_name:
          keyLookup.get(row.api_key_id) ||
          row.api_key_name ||
          (row.api_key_id === '00000000-0000-0000-0000-000000000000'
            ? '总密钥（兼容）'
            : row.api_key_id
              ? '已删除密钥'
              : '未归属（历史记录）'),
        deleted:
          !!row.api_key_id &&
          row.api_key_id !== '00000000-0000-0000-0000-000000000000' &&
          !keyLookup.has(row.api_key_id),
      });
    combine(apiKeys.get(row.api_key_id), row);
    const modelKey = JSON.stringify([row.mode, row.model]);
    if (!models.has(modelKey)) models.set(modelKey, { model: row.model, mode: row.mode });
    combine(models.get(modelKey), row);
    if (!credentials.has(row.credential_id))
      credentials.set(row.credential_id, {
        credential_id: row.credential_id,
        display_name: row.display_name,
      });
    combine(credentials.get(row.credential_id), row);
    if (!days.has(row.day)) days.set(row.day, { day: row.day });
    combine(days.get(row.day), row);
  }
  const ranked = (map) =>
    [...map.values()]
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 200)
      .map(finish);
  const value = {
    summary: finish(summary),
    models: ranked(models),
    credentials: ranked(credentials),
    api_keys: [...apiKeys.values()]
      .sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0) || b.requests - a.requests)
      .slice(0, 200)
      .map(finish),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(finish),
    groups_truncated: models.size > 200 || credentials.size > 200 || apiKeys.size > 200,
    retention: {
      days: 30,
      max_requests: env.TELEMETRY ? null : 10127,
      max_detail_requests: 10127,
    },
    timezone: 'Asia/Shanghai',
    cached_at: Date.now(),
    cache_seconds: 60,
    aggregation_seconds: env.TELEMETRY ? 300 : 0,
    storage_mode: env.TELEMETRY && env.USAGE_STORAGE_MODE !== 'detailed' ? 'aggregate' : 'detailed',
    pending_requests: pendingRequests,
  };

  return value;
}
