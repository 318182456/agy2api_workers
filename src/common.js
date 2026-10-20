export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function readJson(request) {
  if (Number(request.headers.get('content-length')) > 4 * 1024 * 1024) {
    throw new HttpError(413, '请求体不能超过 4 MiB');
  }
  // Read incrementally so chunked requests are subject to the same limit.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求体必须为 JSON');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new HttpError(413, '请求体不能超过 4 MiB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new HttpError(400, '请求体必须为 JSON 对象');
  }
}

export async function equalSecret(actual, expected) {
  if (typeof expected !== 'string' || !expected || typeof actual !== 'string') return false;
  const digest = async (s) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(actual), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function authenticate(request, secret, allowQuery = false) {
  if (!secret) throw new HttpError(503, '请先配置访问密码 Secret');
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const key =
    bearer ||
    request.headers.get('x-goog-api-key') ||
    request.headers.get('x-api-key') ||
    (allowQuery ? new URL(request.url).searchParams.get('key') : null);
  if (!(await equalSecret(key, secret))) throw new HttpError(401, '访问密码错误');
}

export function modeValue(value) {
  if (!['geminicli', 'antigravity'].includes(value)) throw new HttpError(400, '未知凭证模式');
  return value;
}

// Attach only a fixed operation label; never expose upstream exception messages.
export async function operation(stage, action) {
  try {
    return await action();
  } catch (error) {
    if (!error.operation) error.operation = stage;
    throw error;
  }
}

export async function googleFetch(fetcher, url, options, stage) {
  try {
    // Workers supports manual/follow, not redirect:error. Never forward bearer tokens to a redirect target.
    const response = await fetcher(url, { ...options, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const failure = new HttpError(502, 'Google 端点返回重定向，已停止跟随；请检查上游端点配置');
      failure.operation = stage;
      failure.errorCode = 'UPSTREAM_REDIRECT';
      throw failure;
    }
    return response;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const timedOut =
      error?.name === 'TimeoutError' ||
      (options.signal?.aborted && options.signal.reason?.name === 'TimeoutError');
    const failure = new HttpError(
      timedOut ? 504 : 502,
      `${{ preview_configure: 'Google Preview 配置', oauth_refresh: 'Google OAuth 刷新', oauth_exchange: 'Google 授权码交换', quota_fetch: 'Google 额度查询', email_fetch: 'Google 邮箱查询', project_verify: 'Google 项目校验', credential_test: 'Google 凭证测试', model_discovery: 'Google 模型列表查询' }[stage] || 'Google 聊天请求'}${timedOut ? '超时' : '连接失败'}，请检查 Cloudflare 到 Google 的网络连接；这不是数据库迁移错误`,
    );
    failure.operation = stage;
    failure.errorCode = timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_CONNECTION_FAILED';
    throw failure;
  }
}

export function publicFailure(error) {
  if (error instanceof HttpError) return error;
  const messages = [error?.message, error?.cause?.message]
    .filter((s) => typeof s === 'string')
    .join(' ');
  let failure;
  if (/no such table|no such column|has no column named/i.test(messages)) {
    failure = new HttpError(500, 'D1 表结构不完整，请在项目目录执行 npm run db:remote');
    failure.errorCode = 'DB_SCHEMA_ERROR';
  } else if (/D1.*(?:limit|quota)|exceeded.*(?:read|write)/i.test(messages)) {
    failure = new HttpError(503, 'D1 配额或资源限制，请检查 Cloudflare D1 用量');
    failure.errorCode = 'DB_RESOURCE_LIMIT';
  } else {
    failure = new HttpError(500, '服务发生未处理异常，请根据 request_id 查看 Worker 日志');
    failure.errorCode = 'INTERNAL_ERROR';
  }
  failure.operation = error?.operation || 'request';
  return failure;
}
