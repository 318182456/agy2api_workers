import { storageNodes } from './client.js';
import { HttpError } from '../core/common.js';

export async function diagnosticEvents(record) {
  if (record.outcome === 'success' && !record.attempts?.length) return [];
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.requestId)),
  );
  const base =
    parseInt(
      Array.from(digest.slice(0, 6), (n) => n.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 11),
      16,
    ) * 32;
  const event = (row, index) => ({
    id: base + index,
    event_source: 3,
    parent_id: null,
    attempt_index: index === 31 ? null : index,
    request_id: record.requestId,
    api_key_id: record.apiKey?.id || null,
    api_key_name: record.apiKey?.name || null,
    credential_id: row.credential_id || null,
    credential_name: row.credential_name || '',
    display_name: row.credential_name || '未选中凭证',
    credential_email: row.credential_name?.includes('@') ? row.credential_name : null,
    mode: row.mode,
    model: row.model,
    status: row.status,
    stage: row.stage,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    detail_code: row.detail_code || null,
    detail_message:
      typeof row.detail_message === 'string' ? row.detail_message.slice(0, 500) : null,
    retried: Number(!!record.attempts?.length),
  });
  const events = (record.attempts || []).slice(0, 16).map(event);
  events.push(
    event(
      {
        credential_id: record.row?.id,
        credential_name: record.row?.data?.user_email || record.row?.name || '',
        mode: record.mode,
        model: record.model,
        status: record.status,
        stage:
          record.outcome === 'success'
            ? 'completed'
            : record.outcome === 'cancelled'
              ? 'client_cancelled'
              : 'request_failed',
        duration_ms: Math.max(0, Date.now() - record.started),
        created_at: Date.now(),
      },
      31,
    ),
  );
  return events;
}
export async function nodeEvents(env, params, { deleting = false, limit = 50 } = {}) {
  const nodes = await storageNodes(env);
  const batches = await Promise.all(
    nodes.map(async (node) => {
      const response = await (env.STORAGE_NODE_FETCH || fetch)(
        node.url + '/events/' + (deleting ? 'delete' : 'query'),
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + node.node_secret,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ params: Object.fromEntries(params), limit }),
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        },
      );
      if (response.status === 404) {
        await response.body?.cancel();
        return { records: [], deleted: 0 };
      }
      if (!response.ok) throw new HttpError(503, '子节点问题记录暂时不可读，请稍后重试');
      const value = await response.json();
      if (value.node_id !== node.id || (!deleting && !Array.isArray(value.records)))
        throw new HttpError(503, '子节点问题记录响应无效');
      return value;
    }),
  );
  return deleting
    ? batches.reduce((n, b) => n + (b.deleted || 0), 0)
    : batches.flatMap((b) => b.records);
}
export function mergeEvents(local, remote, limit) {
  const key = (row) =>
    JSON.stringify([row.request_id, row.stage, row.credential_id, row.status, row.attempt_index]);
  const represented = new Set(remote.map(key));
  const sorted = [...remote, ...local.filter((row) => !represented.has(key(row)))].sort(
    (a, b) => b.created_at - a.created_at || b.event_source - a.event_source || b.id - a.id,
  );
  const last = sorted[Math.min(limit, sorted.length) - 1];
  return {
    records: sorted.slice(0, limit),
    next: sorted.length > limit ? last.created_at + ':' + last.event_source + ':' + last.id : null,
    truncated: sorted.length > limit,
  };
}
