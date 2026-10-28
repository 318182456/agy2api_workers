import { receiveNodeTelemetry } from './storage/telemetry.js';
import { iconResponse } from './panel/icon.js';
import { VERSION } from './core/version.js';
import { json, publicFailure } from './core/common.js';
import { panel, isPanelPath } from './panel/index.js';
import { anthropicErrorType } from './protocols/anthropic.js';
import { adminRoute } from './routes/admin.js';
import { sessionRoute } from './routes/session.js';
import { generationRoute } from './routes/generation.js';
import { pruneTelemetry } from './telemetry/maintenance.js';
import { warmSharedSettings } from './config/settings.js';
import { flushTelemetry } from './telemetry/client.js';
export { TelemetryBuffer } from './telemetry/buffer.js';

async function route(request, env, fetcher, context) {
  const url = new URL(request.url);
  if (url.pathname === '/internal/storage-telemetry') return receiveNodeTelemetry(request, env);
  if (['GET', 'HEAD'].includes(request.method)) {
    if (url.pathname === '/favicon.svg') return iconResponse(request);
    if (url.pathname === '/favicon.ico')
      return new Response(null, {
        status: 302,
        headers: { location: '/favicon.svg?v=1', 'cache-control': 'public, max-age=86400' },
      });
  }
  if (isPanelPath(url.pathname) && request.method === 'GET') {
    return new Response(panel, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      },
    });
  }
  if (url.pathname === '/health' && ['GET', 'HEAD'].includes(request.method))
    return json({
      status: 'ok',
      runtime: 'cloudflare-workers',
      version: VERSION,
      kv_cache: !!env.CACHE,
      telemetry_buffer: !!env.TELEMETRY,
    });
  if (url.pathname === '/keepalive' && request.method === 'HEAD')
    return new Response(null, { status: 200 });

  if (url.pathname.startsWith('/auth/')) return sessionRoute(request, env);
  if (url.pathname.startsWith('/admin/')) return adminRoute(request, env, fetcher);
  return generationRoute(request, env, fetcher, context);
}

export async function handleRequest(request, env, fetcher = fetch, context) {
  // API clients may be browsers. Admin routes deliberately have no cross-origin access.
  const anthropicPath = /^\/(?:antigravity\/)?v1\/messages(?:\/count_tokens)?$/.test(
    new URL(request.url).pathname,
  );
  const api = /^\/(?:antigravity\/)?v1(?:beta)?\//.test(new URL(request.url).pathname);
  if (api && request.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers':
          'Authorization, Content-Type, x-goog-api-key, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access',
        'access-control-max-age': '86400',
      },
    });
  let response;
  try {
    response = await route(request, env, fetcher, context);
  } catch (error) {
    const failure = publicFailure(error);
    const status = failure.status;
    const requestId = error.requestId || crypto.randomUUID();
    const stage = failure.operation || error.operation || 'request';
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: 'request_failed',
          requestId,
          stage,
          code: failure.errorCode || 'API_ERROR',
          errorType: error?.name || 'Error',
          // Stack frames identify code locations; omit exception messages and cause bodies.
          frames:
            typeof error?.stack === 'string'
              ? error.stack
                  .split('\n')
                  .filter((line) => /^\s+at /.test(line))
                  .slice(0, 5)
              : [],
        }),
      );
    response = json(
      {
        ...(anthropicPath ? { type: 'error', request_id: requestId } : {}),
        error: {
          message: failure.message,
          type: anthropicPath
            ? anthropicErrorType(status)
            : status === 401
              ? 'authentication_error'
              : 'api_error',
          code: status,
          ...(failure.errorCode ? { reason: failure.errorCode } : {}),
          stage,
          request_id: requestId,
        },
      },
      status,
    );
    response.headers.set('x-request-id', requestId);
    if (failure.retryAfter) response.headers.set('retry-after', String(failure.retryAfter));
  }
  if (api) {
    response = new Response(response.body, response);
    response.headers.set('access-control-allow-origin', '*');
    response.headers.set(
      'access-control-expose-headers',
      'retry-after, x-model-list-source, x-model-list-warning, x-request-id, x-token-count-estimated, x-upstream-mode',
    );
  }
  return response;
}

// Cloudflare passes ExecutionContext as argument 3. Never pass it as the test fetcher.
export default {
  scheduled(controller, env, context) {
    if (env.DB)
      context.waitUntil(
        Promise.all([pruneTelemetry(env.DB), warmSharedSettings(env), flushTelemetry(env)]),
      );
  },
  fetch(request, env, context) {
    return handleRequest(request, env, (url, options) => globalThis.fetch(url, options), context);
  },
};
