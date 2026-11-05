import { HttpError, readJson } from '../core/common.js';
import { readSettings } from '../config/settings.js';
import { publishShared } from '../cache/shared.js';
import { dbCache } from '../cache/db.js';
const key = 'aistudio_upstream';
const cache = new WeakMap();
export function renderOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, '请输入有效的 Render HTTPS 地址');
  }
  // ASVS V1.2.2: restrict egress to Render service origins; never follow redirects.
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '2048') ||
    !['/', '/v1', '/v1/'].includes(url.pathname)
  )
    throw new HttpError(
      400,
      '仅支持 https://服务名.onrender.com，不能包含账号、查询参数或其他路径',
    );
  return 'https://' + url.hostname;
}
export async function aistudioConfig(env, fresh = false) {
  if (!env.DB) return null;
  const hit = cache.get(env.DB);
  if (!fresh && hit?.until > Date.now()) return hit.value;
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first();
  let value = null;
  if (row) {
    try {
      value = JSON.parse(row.value);
    } catch {
      throw new HttpError(503, 'AI Studio 配置损坏，请重新保存');
    }
  }
  if (value) value = { ...value, url: renderOrigin(value.url) };
  cache.set(env.DB, { value, until: Date.now() + 30000 });
  return value;
}
export async function publicAistudio(env) {
  const config = await aistudioConfig(env, true);
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?')
    .bind('aistudio_probe')
    .first();
  let probe = null;
  try {
    probe = row ? JSON.parse(row.value) : null;
  } catch {}
  return {
    enabled: !!config?.enabled,
    url: config?.url || '',
    has_key: !!config?.api_key,
    routing: config?.routing || 'explicit',
    keepalive: config?.keepalive !== false,
    revision: config?.revision || '',
    probe: probe?.url === config?.url ? probe : null,
    interval_minutes: 10,
  };
}
export async function saveAistudio(env, body) {
  const previous = await aistudioConfig(env, true);
  if (body.revision !== (previous?.revision || ''))
    throw new HttpError(409, '配置已被修改，请重新加载后重试');
  for (const field of ['enabled', 'keepalive'])
    if (typeof body[field] !== 'boolean') throw new HttpError(400, '启用和定期探测必须是开关');
  if (!['explicit', 'default'].includes(body.routing)) throw new HttpError(400, '路由方式无效');
  if (
    body.api_key != null &&
    (typeof body.api_key !== 'string' ||
      body.api_key.length > 512 ||
      /[^\x21-\x7e]/.test(body.api_key))
  )
    throw new HttpError(400, '上游密钥格式无效');
  const value = {
    url: renderOrigin(body.url),
    enabled: body.enabled,
    keepalive: body.keepalive,
    routing: body.routing,
    api_key: body.api_key || previous?.api_key || '',
    revision: crypto.randomUUID(),
  };
  if (value.enabled && !value.api_key) throw new HttpError(400, '启用前请填写上游 API 密钥');
  const serialized = JSON.stringify(value);
  const change = previous
    ? env.DB.prepare('UPDATE app_settings SET value=? WHERE key=? AND value=?').bind(
        serialized,
        key,
        JSON.stringify(previous),
      )
    : env.DB.prepare('INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)').bind(
        key,
        serialized,
      );
  // CAS plus derived routing flags commit together. A stale revision changes neither.
  const results = await env.DB.batch([
    change,
    env.DB.prepare(
      "INSERT INTO app_settings(key,value) SELECT 'AISTUDIO_ENABLED',CASE WHEN json_extract(value,'$.enabled') THEN 'true' ELSE 'false' END FROM app_settings WHERE key=? AND json_extract(value,'$.revision')=? ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(key, value.revision),
    env.DB.prepare(
      "INSERT INTO app_settings(key,value) SELECT 'AISTUDIO_ROUTING',json_quote(json_extract(value,'$.routing')) FROM app_settings WHERE key=? AND json_extract(value,'$.revision')=? ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(key, value.revision),
  ]);
  if (!results[0].meta?.changes) throw new HttpError(409, '配置刚被更新，请重新加载');
  cache.delete(env.DB);
  delete dbCache(env.DB).settings;
  const settings = await readSettings(env);
  await publishShared(env, 'settings', settings.overrides, 7200);
  return publicAistudio(env);
}
export async function probeAistudio(env, fetcher = fetch, models = false) {
  const config = await aistudioConfig(env, true);
  if (!config?.enabled || !config.url || (!models && config.keepalive === false))
    return { skipped: true };
  const started = Date.now();
  let response;
  let result;
  try {
    response = await fetcher(config.url + (models ? '/v1/models' : '/'), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: models
        ? { authorization: 'Bearer ' + config.api_key, accept: 'application/json' }
        : { accept: 'text/html' },
    });
    if (models && response.ok) {
      const data = await readJson({ headers: response.headers, body: response.body });
      if (!Array.isArray(data.data) || data.data.length > 10000) throw new Error('invalid catalog');
      result = {
        ok: true,
        model_count: data.data.length,
        models: data.data
          .map((row) => row.id)
          .filter((id) => typeof id === 'string' && id.length <= 200)
          .slice(0, 2000),
      };
    } else
      result = {
        ok: response.ok,
        message: response.ok ? '首页连通，未调用模型' : '上游返回 HTTP ' + response.status,
      };
  } catch {
    result = { ok: false, message: '连接失败或超过 20 秒；请检查 Render 服务状态' };
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
  result = {
    ...result,
    url: config.url,
    checked_at: Date.now(),
    duration_ms: Date.now() - started,
    http_status: response?.status || null,
    kind: models ? 'models' : 'keepalive',
  };
  // Parameterized storage; do not persist response bodies, cookies or credentials in probe history.
  await env.DB.prepare(
    'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  )
    .bind('aistudio_probe', JSON.stringify({ ...result, models: undefined }))
    .run();
  return result;
}
