import { equalSecret, HttpError, json, readJson } from './common.js';
import { usageStats } from './telemetry/stats.js';
import { effectiveEnv } from './settings.js';

export const MASTER_KEY_ID = '00000000-0000-0000-0000-000000000000';
const columns =
  'id,name,masked_key,enabled,expires_at,created_at,(key_value IS NOT NULL) AS can_reveal';
export async function keyHash(key) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
}
export async function authenticateApi(request, env, allowQuery = false) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const key =
    bearer ||
    request.headers.get('x-goog-api-key') ||
    request.headers.get('x-api-key') ||
    (allowQuery ? new URL(request.url).searchParams.get('key') : null);
  if (await equalSecret(key, env.API_PASSWORD))
    return { id: MASTER_KEY_ID, name: '总密钥（兼容）' };
  if (!env.DB) {
    if (!env.API_PASSWORD) throw new HttpError(503, '未绑定 D1 数据库，无法校验 API 密钥');
    throw new HttpError(401, 'API 密钥无效、已停用或已到期');
  }
  if (typeof key !== 'string' || !key || key.length > 512)
    throw new HttpError(401, 'API 密钥无效、已停用或已到期');
  // No positive authentication cache: disable/delete/expiry takes effect on the next request.
  const row = await env.DB.prepare(
    'SELECT id,name,enabled,expires_at FROM api_keys WHERE key_hash=?',
  )
    .bind(await keyHash(key))
    .first();
  if (!row || !row.enabled || (row.expires_at != null && row.expires_at <= Date.now()))
    throw new HttpError(401, 'API 密钥无效、已停用或已到期');
  return { id: row.id, name: row.name };
}
function nameValue(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 100 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new HttpError(400, '密钥名称须为 1–100 个字符');
  return value.trim();
}
function expiryValue(value) {
  if (value == null || value === '') return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
    throw new HttpError(400, '到期时间须为毫秒时间戳或 null');
  return value;
}
function validateKey(key) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(key) || /\*|\.\.\./.test(key))
    throw new HttpError(400, '请提供完整密钥（8–512 个非空白字符），不能使用脱敏值');
  return key;
}
function publicKey(row) {
  return {
    ...row,
    state: !row.enabled
      ? 'disabled'
      : row.expires_at != null && row.expires_at <= Date.now()
        ? 'expired'
        : 'enabled',
  };
}
export function parseKeyImport(data, format = 'plain') {
  if (!['plain', 'newapi'].includes(format)) throw new HttpError(400, '未知导入格式');
  if (typeof data === 'string') {
    const text = data.trim();
    if (!text) throw new HttpError(400, '导入内容不能为空');
    if (/^[\[{]/.test(text)) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new HttpError(400, '导入 JSON 格式无效');
      }
    } else
      data = text
        .split(/\r?\n/)
        .map((key) => key.trim())
        .filter(Boolean);
  }
  if (!Array.isArray(data) && data && typeof data === 'object')
    data = data.data?.items || data.data || data.items || data;
  if (data && typeof data === 'object' && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data) || !data.length || data.length > 200)
    throw new HttpError(400, '每次可导入 1–200 个密钥');
  return data.map((item, index) => {
    try {
      const entry = typeof item === 'string' ? { key: item } : item;
      if (!entry || typeof entry !== 'object') throw new HttpError(400, '密钥对象无效');
      let key = entry.key;
      if (format === 'newapi' && typeof key === 'string' && !key.startsWith('sk-'))
        key = 'sk-' + key;
      validateKey(key);
      let expires = entry.expires_at;
      if (format === 'newapi' && entry.expired_time != null) {
        if (!Number.isSafeInteger(entry.expired_time) || entry.expired_time < -1)
          throw new HttpError(400, 'New API 到期时间无效');
        expires = entry.expired_time === -1 ? null : entry.expired_time * 1000;
      }
      if (
        entry.enabled != null &&
        typeof entry.enabled !== 'boolean' &&
        ![0, 1].includes(entry.enabled)
      )
        throw new HttpError(400, '启用状态无效');
      return {
        key,
        name: nameValue(entry.name || '导入密钥 ' + (index + 1)),
        enabled:
          format === 'newapi' && entry.status != null
            ? Number(entry.status) === 1
            : entry.enabled == null || !!entry.enabled,
        expires_at: expiryValue(expires),
      };
    } catch (error) {
      throw new HttpError(
        400,
        '第 ' +
          (index + 1) +
          ' 项：' +
          (error instanceof HttpError ? error.message : '密钥格式无效'),
      );
    }
  });
}
async function prepareInsert(db, entry) {
  const hash = await keyHash(entry.key);
  return db
    .prepare(
      'INSERT OR IGNORE INTO api_keys(id,name,key_hash,masked_key,enabled,expires_at,created_at,key_value) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      crypto.randomUUID(),
      entry.name,
      hash,
      '••••' + entry.key.slice(-4),
      Number(entry.enabled),
      entry.expires_at,
      Date.now(),
      entry.key,
    );
}
export async function apiKeysRoute(request, env, url) {
  const path = url.pathname;
  if (path === '/admin/api-keys/usage') {
    if (request.method !== 'GET') throw new HttpError(405, '请求方法不支持');
    const id = url.searchParams.get('api_key_id');
    if (!id) throw new HttpError(400, '请选择 API 密钥');
    if (
      id !== MASTER_KEY_ID &&
      !(await env.DB.prepare('SELECT id FROM api_keys WHERE id=?').bind(id).first())
    )
      throw new HttpError(404, '密钥不存在');
    return json(await usageStats(env.DB, url.searchParams, await effectiveEnv(env)));
  }
  if (path === '/admin/api-keys/import') {
    if (request.method !== 'POST') throw new HttpError(405, '请求方法不支持');
    const body = await readJson(request),
      entries = parseKeyImport(body.data, body.format);
    for (const entry of entries)
      if (await equalSecret(entry.key, env.API_PASSWORD))
        throw new HttpError(400, '导入内容包含当前总密钥；请使用独立密钥');
    const statements = await Promise.all(entries.map((entry) => prepareInsert(env.DB, entry)));
    const results = await env.DB.batch(statements);
    const imported = results.reduce((sum, result) => sum + (result.meta?.changes || 0), 0);
    return json({ imported, duplicates: entries.length - imported });
  }
  if (path === '/admin/api-keys') {
    if (request.method === 'GET') {
      const page = Number(url.searchParams.get('page') || '0');
      if (!Number.isSafeInteger(page) || page < 0 || page > 100000)
        throw new HttpError(400, '页码无效');
      const search = (url.searchParams.get('search') || '').trim();
      if (search.length > 100) throw new HttpError(400, '名称筛选过长');
      const rows = (
        await env.DB.prepare(
          `SELECT ${columns} FROM api_keys WHERE instr(lower(name),lower(?))>0 ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?`,
        )
          .bind(search, page * 50)
          .all()
      ).results;
      return json({
        keys: rows.slice(0, 50).map(publicKey),
        has_next: rows.length > 50,
        page,
        master_enabled: !!env.API_PASSWORD,
      });
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      const key =
        'sk-gcli-' +
        Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
          n.toString(16).padStart(2, '0'),
        ).join('');
      const entry = {
        key,
        name: nameValue(body.name),
        enabled: true,
        expires_at: expiryValue(body.expires_at),
      };
      await (await prepareInsert(env.DB, entry)).run();
      const row = await env.DB.prepare(`SELECT ${columns} FROM api_keys WHERE key_hash=?`)
        .bind(await keyHash(key))
        .first();
      return json({ ...publicKey(row), key }, 201);
    }
    throw new HttpError(405, '请求方法不支持');
  }
  const revealMatch = path.match(/^\/admin\/api-keys\/([a-f0-9-]{36})\/reveal$/);
  if (revealMatch) {
    if (request.method !== 'POST') throw new HttpError(405, '请求方法不支持');
    const row = await env.DB.prepare('SELECT key_value FROM api_keys WHERE id=?')
      .bind(revealMatch[1])
      .first();
    if (!row) throw new HttpError(404, '密钥不存在');
    return json({ key: row.key_value });
  }
  const match = path.match(/^\/admin\/api-keys\/([a-f0-9-]{36})$/);
  if (!match) throw new HttpError(404, '密钥接口不存在');
  if (request.method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM api_keys WHERE id=?').bind(match[1]).run();
    if (!result.meta.changes) throw new HttpError(404, '密钥不存在');
    return json({ success: true });
  }
  if (request.method === 'PATCH') {
    const body = await readJson(request),
      sets = [],
      values = [];
    if ('name' in body) {
      sets.push('name=?');
      values.push(nameValue(body.name));
    }
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, '启用状态须为布尔值');
      sets.push('enabled=?');
      values.push(Number(body.enabled));
    }
    if ('expires_at' in body) {
      sets.push('expires_at=?');
      values.push(expiryValue(body.expires_at));
    }
    if (!sets.length) throw new HttpError(400, '没有可更新的字段');
    const result = await env.DB.prepare('UPDATE api_keys SET ' + sets.join(',') + ' WHERE id=?')
      .bind(...values, match[1])
      .run();
    if (!result.meta.changes) throw new HttpError(404, '密钥不存在');
    return json(
      publicKey(
        await env.DB.prepare(`SELECT ${columns} FROM api_keys WHERE id=?`).bind(match[1]).first(),
      ),
    );
  }
  throw new HttpError(405, '请求方法不支持');
}
