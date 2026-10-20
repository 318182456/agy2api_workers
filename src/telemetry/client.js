import { HttpError } from '../common.js';
export function telemetryStub(env) {
  return env.TELEMETRY?.get(env.TELEMETRY.idFromName('gcli2api'));
}
export async function pendingTelemetry(env = {}) {
  const stub = telemetryStub(env);
  if (!stub) return { buckets: [] };
  const response = await stub.fetch('https://telemetry/snapshot');
  if (!response.ok)
    throw new HttpError(503, '用量持久缓冲暂时不可读，未返回不完整统计；请稍后重试或手动落盘');
  return response.json();
}
export async function flushTelemetry(env) {
  const stub = telemetryStub(env);
  if (!stub) return { buckets_flushed: 0, pending: false };
  const response = await stub.fetch('https://telemetry/flush', { method: 'POST' });
  if (!response.ok) throw new HttpError(503, '用量落盘失败，缓冲已保留，请稍后重试');
  return response.json();
}
export async function telemetryPayload(record) {
  const created_at = Math.floor(record.started / 300000) * 300000;
  const group = JSON.stringify([
    record.apiKey?.id || null,
    record.row?.id || null,
    record.mode,
    record.model,
    record.status,
    record.outcome,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(group));
  const hash = Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
  const numeric = (key) =>
    Number.isSafeInteger(record.usage?.[key]) && record.usage[key] >= 0 ? record.usage[key] : null;
  return {
    key: String(created_at).padStart(13, '0') + ':' + hash,
    request_id: record.requestId,
    api_key_id: record.apiKey?.id || null,
    api_key_name: record.apiKey?.name || null,
    credential_id: record.row?.id || null,
    credential_name: record.row?.data?.user_email || record.row?.name || '',
    mode: record.mode,
    model: record.model,
    status: record.status,
    outcome: record.outcome,
    created_at,
    completed_at: Date.now(),
    duration_ms: Math.max(0, Date.now() - record.started),
    input_tokens: numeric('promptTokenCount'),
    output_tokens: numeric('candidatesTokenCount'),
    thought_tokens: numeric('thoughtsTokenCount'),
    total_tokens: numeric('totalTokenCount'),
  };
}
