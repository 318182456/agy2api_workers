import { HttpError } from './common.js';
import { dbCache } from './db-cache.js';

const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const TTL = 60000;
async function probe(fetcher) {
  const signal = AbortSignal.timeout(5000);
  let response;
  let phase = 'connect';
  const failure = (code, message) => {
    const error = new HttpError(503, message + '；不影响模型调用');
    error.operation = 'runtime_location';
    error.errorCode = code;
    return error;
  };
  try {
    response = await fetcher(TRACE_URL, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { accept: 'text/plain', 'cache-control': 'no-cache' },
      cf: { cacheTtl: 0 },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw failure(
        'REGION_PROBE_HTTP_' + response.status,
        '地区探测服务返回 HTTP ' + response.status + ' 或空响应，请稍后重试',
      );
    }
    phase = 'read';
    const reader = response.body.getReader();
    let text = '',
      size = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8192) throw failure('REGION_PROBE_LIMIT', '地区探测响应超过大小限制');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    phase = 'parse';
    const fields = Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter((line) => line.includes('='))
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1).trim()];
        }),
    );
    if (!/^[A-Z]{2}$/.test(fields.loc || '') || !/^[A-Z]{3}$/.test(fields.colo || ''))
      throw failure('REGION_PROBE_FORMAT_INVALID', '地区探测服务未返回有效的国家和节点信息');
    // Whitelist only geography metadata. Never return trace IP, request headers or arbitrary body text.
    return {
      country: fields.loc,
      probe_colo: fields.colo,
      queried_at: Date.now(),
      cache_seconds: TTL / 1000,
      source: 'cloudflare-trace',
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw failure(
      signal.aborted ? 'REGION_PROBE_TIMEOUT' : 'REGION_PROBE_CONNECTION_FAILED',
      signal.aborted
        ? '地区探测超过 5 秒，请稍后重试'
        : phase === 'read'
          ? '地区探测响应读取失败，请稍后重试'
          : '地区探测连接失败，请稍后重试',
    );
  }
}
export async function runtimeLocation(request, env, fetcher = fetch) {
  // This never queries D1 or KV. Use only the database object's identity to scope local metadata.
  const scope = dbCache(env.DB || env);
  scope.runtimeLocations ||= new Map();
  const placement = request.headers.get('cf-placement') || '';
  const execution = placement.match(/^(?:local|remote)-([A-Z]{3})$/i)?.[1]?.toUpperCase() || null;
  const key = JSON.stringify([request.cf?.colo || '', execution]);
  let entry = scope.runtimeLocations.get(key);
  const cached = !!(entry?.value && entry.until > Date.now());
  if (!cached) {
    if (!entry?.flight) {
      if (scope.runtimeLocations.size >= 20)
        scope.runtimeLocations.delete(scope.runtimeLocations.keys().next().value);
      entry = { flight: probe(fetcher) };
      scope.runtimeLocations.set(key, entry);
    }
    try {
      entry.value = await entry.flight;
      entry.until = entry.value.queried_at + TTL;
    } catch (error) {
      scope.runtimeLocations.delete(key);
      throw error;
    } finally {
      delete entry.flight;
    }
  }
  return {
    ...entry.value,
    cached,
    execution_colo: execution,
    note: '地区字段和接收节点来自 Worker 发起的 Cloudflare trace 请求；地区字段可能受入口信息影响，不用于判断 Worker 出口国家。接收节点不等同实际执行节点，也不保证 Google 看到同一个出口。',
  };
}
