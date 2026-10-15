import { authenticate, equalSecret, HttpError, json, readJson, publicFailure } from './common.js';
import { oauthClients, importCredential, listCredentials, updateCredential } from './credentials.js';
import { convertedStream, geminiToOpenai, openaiToGemini, unwrap } from './convert.js';
import { collectGoogleStream } from './stream-collect.js';
import { callUpstream } from './upstream.js';
import { panel, isPanelPath } from './panel.js';
import { startOAuth, completeOAuth } from './oauth.js';
import { credentialById, fetchEmail, verifyProject, testCredential } from './account.js';
import { credentialQuota } from './quota.js';
import { discoverModels } from './model-list.js';
import { queryCallLogs, recordAttempt, clearCallLogs } from './reliability.js';
import { recordUsage, usageStats, credentialHealth } from './metrics.js';
import { effectiveEnv, readSettings, saveSettings } from './settings.js';
import { duplicateCredentials } from './duplicates.js';
import { anthropicToGemini, geminiToAnthropic, anthropicStream, estimateTokens, anthropicErrorType } from './anthropic.js';
import { authenticatePanel, checkOrigin, createSession, clearSession, hasSession } from './session.js';

function validateModel(model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model)) {
    throw new HttpError(400, 'model 只能包含字母、数字、点、下划线和短横线；Workers 版不支持功能前缀');
  }
}

async function route(request, env, fetcher, context) {
  const url = new URL(request.url);
  if (isPanelPath(url.pathname) && request.method === 'GET') {
    return new Response(panel, { headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    } });
  }
  if (url.pathname === '/health' && ['GET', 'HEAD'].includes(request.method)) return json({ status: 'ok', runtime: 'cloudflare-workers', version: '0.12.0' });
  if (url.pathname === '/keepalive' && request.method === 'HEAD') return new Response(null, { status: 200 });

  if (url.pathname === '/auth/login' && request.method === 'POST') {
    if (!env.PANEL_PASSWORD) throw new HttpError(503, '请先配置 PANEL_PASSWORD Secret');
    checkOrigin(request);
    const body = await readJson(request);
    if (!await equalSecret(body.password, env.PANEL_PASSWORD)) throw new HttpError(401, '密码错误');
    const response = json({ success: true });
    response.headers.set('set-cookie', await createSession(request, env.PANEL_PASSWORD));
    return response;
  }
  if (url.pathname === '/auth/session' && request.method === 'GET') {
    return json({ authenticated: await hasSession(request, env.PANEL_PASSWORD) });
  }
  if (url.pathname === '/auth/logout' && request.method === 'POST') {
    checkOrigin(request);
    const response = json({ success: true });
    response.headers.set('set-cookie', clearSession(request));
    return response;
  }
  if (url.pathname.startsWith('/admin/')) {
    await authenticatePanel(request, env.PANEL_PASSWORD);
    if (url.pathname === '/admin/models' && request.method === 'GET') return json(await discoverModels(await effectiveEnv(env), url.searchParams.get('mode') || 'antigravity', fetcher));
    if (!env.DB) throw new HttpError(503, '未绑定 D1 数据库');
    if (url.pathname === '/admin/settings') {
      if (request.method === 'GET') return json(await readSettings(env));
      if (request.method === 'PATCH') return json(await saveSettings(env, await readJson(request)));
      throw new HttpError(405, '请求方法不支持');
    }
    if (url.pathname === '/admin/duplicates' && request.method === 'GET') return json(await duplicateCredentials(env.DB, env));
    if (url.pathname === '/admin/stats' && request.method === 'GET') return json(await usageStats(env.DB, url.searchParams));
    if (url.pathname === '/admin/calls') {
      if (request.method === 'GET') return json(await queryCallLogs(env.DB, url.searchParams));
      if (request.method === 'DELETE') return json(await clearCallLogs(env.DB, url.searchParams, await readJson(request)));
    }
    if (url.pathname === '/admin/calls/export' && request.method === 'GET') {
      const response = json(await queryCallLogs(env.DB, url.searchParams, true));
      response.headers.set('content-disposition', 'attachment; filename="call-logs.json"'); return response;
    }
    const healthMatch = url.pathname.match(/^\/admin\/credentials\/([a-f0-9-]{36})\/health$/);
    if (healthMatch && request.method === 'GET') {
      await credentialById(env.DB, healthMatch[1]);
      return json(await credentialHealth(env.DB, healthMatch[1]));
    }
    const clearMatch = url.pathname.match(/^\/admin\/credentials\/([a-f0-9-]{36})\/cooldowns$/);
    if (clearMatch && request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM credential_cooldowns WHERE credential_id=?').bind(clearMatch[1]).run();
      return json({ success: true });
    }
    if (['/admin/oauth/start', '/admin/oauth/complete'].includes(url.pathname)) {
      if (request.method !== 'POST') throw new HttpError(405, '请求方法不支持');
      const body = await readJson(request);
      return json(url.pathname.endsWith('/start') ? await startOAuth(request, env, body) : await completeOAuth(request, env, body, fetcher));
    }
    const accountMatch = url.pathname.match(/^\/admin\/credentials\/([a-f0-9-]{36})\/(email|verify|test|download)$/);
    if (accountMatch) {
      const action = accountMatch[2];
      if (request.method !== (action === 'download' ? 'GET' : 'POST')) throw new HttpError(405, '请求方法不支持');
      const row = await credentialById(env.DB, accountMatch[1]);
      if (action === 'email') return json(await fetchEmail(env, row, fetcher));
      if (action === 'verify') return json(await verifyProject(env, row, fetcher));
      if (action === 'test') return json(await testCredential(await effectiveEnv(env), row, (await readJson(request)).model, fetcher));
      const response = json(row.data);
      response.headers.set('content-disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(row.name.endsWith('.json') ? row.name : row.name + '.json'));
      return response;
    }
    if (url.pathname === '/admin/credentials') {
      if (request.method === 'GET') return json({ credentials: await listCredentials(env.DB, env), oauth_clients: Object.fromEntries(Object.entries(oauthClients(env)).filter(([, client]) => client.client_id).map(([mode, client]) => [client.client_id, mode])) });
      if (request.method === 'POST') return json(await importCredential(env.DB, await readJson(request), env), 201);
    }
    const quotaMatch = url.pathname.match(/^\/admin\/credentials\/([a-f0-9-]{36})\/quota$/);
    if (quotaMatch) {
      if (request.method !== 'GET') throw new HttpError(405, '请求方法不支持');
      return json(await credentialQuota(env, quotaMatch[1], fetcher));
    }
    const match = url.pathname.match(/^\/admin\/credentials\/([a-f0-9-]{36})$/);
    if (match) {
      if (request.method === 'DELETE') {
        const result = await env.DB.prepare('DELETE FROM credentials WHERE id=?').bind(match[1]).run();
        if (!result.meta.changes) throw new HttpError(404, '凭证不存在');
        return json({ success: true });
      }
      if (request.method === 'PATCH') {
        const body = await readJson(request);
        return json(await updateCredential(env.DB, match[1], body, env));
      }
    }
    throw new HttpError(404, '管理接口不存在');
  }

  const mode = url.pathname.startsWith('/antigravity/') ? 'antigravity' : 'geminicli';
  const path = mode === 'antigravity' ? url.pathname.slice('/antigravity'.length) : url.pathname;
  const nativeMatch = path.match(/^\/v1(?:beta)?\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/);
  const isOpenai = path === '/v1/chat/completions';
  const isAnthropic = path === '/v1/messages';
  const isCount = path === '/v1/messages/count_tokens' || nativeMatch?.[2] === 'countTokens';
  const isModelList = ['/v1/models', '/v1beta/models'].includes(path);
  if (!nativeMatch && !isOpenai && !isAnthropic && !isCount && !isModelList) throw new HttpError(404, '接口不存在；支持 OpenAI Chat Completions、Anthropic Messages 和 Gemini generateContent');
  if (request.method !== (isModelList ? 'GET' : 'POST')) throw new HttpError(405, '请求方法不支持');
  await authenticate(request, env.API_PASSWORD, !!nativeMatch || path === '/v1beta/models');
  env = await effectiveEnv(env);
  if (isModelList) {
    const result = await discoverModels(env, mode, fetcher);
    const response = path === '/v1beta/models'
      ? json({ models: result.ids.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] })) })
      : json({ object: 'list', data: result.ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'google' })) });
    response.headers.set('x-model-list-source', result.source);
    if (result.source === 'fallback') response.headers.set('x-model-list-warning', 'dynamic-discovery-failed');
    return response;
  }
  const body = await readJson(request);
  const model = isOpenai || isAnthropic || path === '/v1/messages/count_tokens' ? body.model : nativeMatch[1];
  validateModel(model);
  if ((isOpenai || isAnthropic) && body.stream != null && typeof body.stream !== 'boolean') throw new HttpError(400, 'stream 必须为布尔值');
  const geminiRequest = isOpenai ? openaiToGemini(body) : isAnthropic || path === '/v1/messages/count_tokens' ? anthropicToGemini(body, isCount) : body;
  if (!Array.isArray(geminiRequest.contents) || !geminiRequest.contents.length) throw new HttpError(400, 'contents 不能为空');
  if (isCount) {
    const count = estimateTokens(geminiRequest);
    const result = json(path === '/v1/messages/count_tokens' ? { input_tokens: count } : { totalTokens: count });
    result.headers.set('x-token-count-estimated', 'true');
    return result;
  }
  if (!env.DB) throw new HttpError(503, '未绑定 D1 数据库');
  const stream = isOpenai || isAnthropic ? body.stream === true : nativeMatch[2] === 'streamGenerateContent';
  const collect = mode === 'antigravity' && !stream && env.ANTIGRAVITY_STREAM2NOSTREAM;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const incomingSignal = request.signal;
  if (incomingSignal?.aborted) cancel();
  incomingSignal?.addEventListener('abort', cancel, { once: true });
  let handedOff = false;
  const requestId = crypto.randomUUID();
  const attemptMeta = { requestId };
  const started = Date.now();
  let usageSaved = false;
  let latestUsage;
  const persist = task => { context?.waitUntil?.(task); return task; };
  const finishUsage = async (status, outcome, usage) => {
    if (usageSaved) return; usageSaved = true;
    await persist(recordUsage(env.DB, { requestId, row: attemptMeta.row, mode, model: attemptMeta.model || model,
      status, outcome, usage, started }));
  };
  const completed = usage => persist((async () => {
    if (usageSaved) return;
    await finishUsage(200, 'success', usage);
    if (attemptMeta.row) await recordAttempt(env.DB, { requestId, row: attemptMeta.row, mode, model: attemptMeta.model || model,
      status: 200, stage: 'completed', started });
  })());
  try {
    const response = await callUpstream(env, mode, model, geminiRequest, stream || collect, abort.signal, fetcher, attemptMeta);
    if (!response.ok) {
      await finishUsage(response.status, 'failed');
      if (isAnthropic) {
        let message = `Google 返回 HTTP ${response.status}`;
        try { const value = await response.json(); if (typeof value.error?.message === 'string') message = value.error.message.slice(0, 2000); } catch {}
        const result = json({ type: 'error', error: { type: anthropicErrorType(response.status), message }, request_id: requestId }, response.status);
        result.headers.set('x-request-id', requestId);
        if (response.headers.has('retry-after')) result.headers.set('retry-after', response.headers.get('retry-after'));
        return result;
      }
      // Keep Google's error and status so location/eligibility issues remain diagnosable.
      const result = new Response(response.body, { status: response.status, headers: {
        'content-type': response.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store', 'x-request-id': requestId,
        ...(response.headers.has('retry-after') ? { 'retry-after': response.headers.get('retry-after') } : {}),
      } });
      return result;
    }
    if (stream) {
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new HttpError(502, '上游未返回 SSE 流');
      }
      const finish = () => incomingSignal?.removeEventListener('abort', cancel);
      const streamFailure = (usage, cancelled = false) => persist((async () => {
        if (usageSaved) return;
        const status = cancelled || abort.signal.aborted ? 499 : 502;
        await finishUsage(status, status === 499 ? 'cancelled' : 'failed', usage);
        if (attemptMeta.row) await recordAttempt(env.DB, { requestId, row: attemptMeta.row, mode, model: attemptMeta.model || model,
          status, stage: status === 499 ? 'client_cancelled' : 'stream_error', code: status === 499 ? 'CLIENT_CANCELLED' : 'STREAM_INTERRUPTED', started });
      })());
      const converted = isAnthropic
        ? anthropicStream(response.body, model, cancel, finish, streamFailure, completed, usage => streamFailure(usage, true))
        : convertedStream(response.body, model, isOpenai, body.stream_options?.include_usage === true, cancel, finish, streamFailure, completed, usage => streamFailure(usage, true));
      handedOff = true;
      return new Response(converted, { headers: {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-request-id': requestId,
      } });
    }
    let value;
    if (collect) {
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel(); throw new HttpError(502, '上游未返回 SSE 流');
      }
      value = await collectGoogleStream(response.body);
    } else {
      try { value = await response.json(); } catch { throw new HttpError(502, '上游返回了无效 JSON'); }
    }
    const unwrapped = unwrap(value);
    latestUsage = unwrapped.usageMetadata;
    if (unwrapped.error || (!unwrapped.candidates?.length && !unwrapped.promptFeedback?.blockReason)) throw new HttpError(502, '上游未返回有效的生成结果');
    const result = json(isOpenai ? geminiToOpenai(value, model) : isAnthropic ? geminiToAnthropic(value, model) : unwrap(value));
    result.headers.set('x-request-id', requestId);
    if (collect) result.headers.set('x-upstream-mode', 'stream-collected');
    await completed(latestUsage);
    return result;
  } catch (error) {
    if (attemptMeta.row && attemptMeta.headersReceived && !handedOff) {
      error.operation ||= collect ? 'stream_collection' : 'response_processing';
      await recordAttempt(env.DB, { requestId, row: attemptMeta.row, mode, model: attemptMeta.model || model, status: error.status || 500, stage: error.operation, code: 'UPSTREAM_RESPONSE_INVALID', started });
    }
    await finishUsage(abort.signal.aborted ? 499 : error.status || 500, abort.signal.aborted ? 'cancelled' : 'failed', latestUsage);
    error.requestId = requestId; throw error;
  } finally {
    if (!handedOff) incomingSignal?.removeEventListener('abort', cancel);
  }
}

export async function handleRequest(request, env, fetcher = fetch, context) {
  // API clients may be browsers. Admin routes deliberately have no cross-origin access.
  const anthropicPath = /^\/(?:antigravity\/)?v1\/messages(?:\/count_tokens)?$/.test(new URL(request.url).pathname);
  const api = /^\/(?:antigravity\/)?v1(?:beta)?\//.test(new URL(request.url).pathname);
  if (api && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, x-goog-api-key, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access',
    'access-control-max-age': '86400',
  } });
  let response;
  try { response = await route(request, env, fetcher, context); }
  catch (error) {
    const failure = publicFailure(error);
    const status = failure.status;
    const requestId = error.requestId || crypto.randomUUID();
    const stage = failure.operation || error.operation || 'request';
    if (status >= 500) console.error(JSON.stringify({ event: 'request_failed', requestId, stage,
      code: failure.errorCode || 'API_ERROR', errorType: error?.name || 'Error',
      // Stack frames identify code locations; omit exception messages and cause bodies.
      frames: typeof error?.stack === 'string' ? error.stack.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 5) : [] }));
    response = json({ ...(anthropicPath ? { type: 'error', request_id: requestId } : {}), error: { message: failure.message,
      type: anthropicPath ? anthropicErrorType(status) : status === 401 ? 'authentication_error' : 'api_error', code: status,
      ...(failure.errorCode ? { reason: failure.errorCode } : {}), stage, request_id: requestId } }, status);
    response.headers.set('x-request-id', requestId);
    if (failure.retryAfter) response.headers.set('retry-after', String(failure.retryAfter));
  }
  if (api) {
    response = new Response(response.body, response);
    response.headers.set('access-control-allow-origin', '*');
    response.headers.set('access-control-expose-headers', 'retry-after, x-model-list-source, x-model-list-warning, x-request-id, x-token-count-estimated, x-upstream-mode');
  }
  return response;
}

// Cloudflare passes ExecutionContext as argument 3. Never pass it as the test fetcher.
export default {
  fetch(request, env, context) { return handleRequest(request, env, (url, options) => globalThis.fetch(url, options), context); },
};
