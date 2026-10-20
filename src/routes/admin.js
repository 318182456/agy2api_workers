import { importArchive, exportArchive } from '../credential-archive.js';
import { configurePreview } from '../preview.js';
import { HttpError, json, readJson, operation } from '../common.js';
import {
  oauthClients,
  importCredential,
  listCredentials,
  updateCredential,
} from '../credentials.js';
import { startOAuth, completeOAuth } from '../oauth.js';
import { credentialById, fetchEmail, verifyProject, testCredential, saveData } from '../account.js';
import { credentialQuota } from '../quota.js';
import { discoverModels } from '../model-list.js';
import { queryCallLogs, clearCallLogs } from '../reliability.js';
import { usageStats, credentialHealth } from '../metrics.js';
import { effectiveEnv, readSettings, saveSettings } from '../settings.js';
import { duplicateCredentials } from '../duplicates.js';
import { authenticatePanel } from '../session.js';
import { flushTelemetry } from '../telemetry/client.js';
import { apiKeysRoute } from '../api-keys.js';

export async function adminRoute(request, env, fetcher) {
  const url = new URL(request.url);
  await authenticatePanel(request, env.PANEL_PASSWORD);
  if (url.pathname === '/admin/models' && request.method === 'GET')
    return json(
      await discoverModels(
        await effectiveEnv(env),
        url.searchParams.get('mode') || 'antigravity',
        fetcher,
        { fresh: true, publish: true },
      ),
    );
  if (!env.DB) throw new HttpError(503, '未绑定 D1 数据库');
  if (url.pathname === '/admin/api-keys' || url.pathname.startsWith('/admin/api-keys/'))
    return apiKeysRoute(request, env, url);
  if (url.pathname === '/admin/telemetry/flush' && request.method === 'POST')
    return json(await flushTelemetry(env));
  if (url.pathname === '/admin/settings') {
    if (request.method === 'GET') return json(await readSettings(env));
    if (request.method === 'PATCH') return json(await saveSettings(env, await readJson(request)));
    throw new HttpError(405, '请求方法不支持');
  }
  if (url.pathname === '/admin/duplicates' && request.method === 'GET')
    return json(await duplicateCredentials(env.DB, env));
  if (url.pathname === '/admin/stats' && request.method === 'GET')
    return json(await usageStats(env.DB, url.searchParams, await effectiveEnv(env)));
  if (url.pathname === '/admin/calls') {
    if (request.method === 'GET') return json(await queryCallLogs(env.DB, url.searchParams));
    if (request.method === 'DELETE')
      return json(await clearCallLogs(env.DB, url.searchParams, await readJson(request)));
  }
  if (url.pathname === '/admin/calls/export' && request.method === 'GET') {
    const response = json(await queryCallLogs(env.DB, url.searchParams, true));
    response.headers.set('content-disposition', 'attachment; filename="call-logs.json"');
    return response;
  }
  if (url.pathname === '/admin/credentials/import.zip' && request.method === 'POST')
    return importArchive(request, env, url.searchParams.get('mode'));
  if (url.pathname === '/admin/credentials/export.zip' && request.method === 'POST')
    return exportArchive(env, (await readJson(request)).ids);
  const healthMatch = url.pathname.match(/^\/admin\/credentials\/([a-f0-9-]{36})\/health$/);
  if (healthMatch && request.method === 'GET') {
    await credentialById(env.DB, healthMatch[1]);
    return json(await credentialHealth(env.DB, healthMatch[1], env));
  }
  const clearMatch = url.pathname.match(/^\/admin\/credentials\/([a-f0-9-]{36})\/cooldowns$/);
  if (clearMatch && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM credential_cooldowns WHERE credential_id=?')
      .bind(clearMatch[1])
      .run();
    return json({ success: true });
  }
  if (['/admin/oauth/start', '/admin/oauth/complete'].includes(url.pathname)) {
    if (request.method !== 'POST') throw new HttpError(405, '请求方法不支持');
    const body = await readJson(request);
    return json(
      url.pathname.endsWith('/start')
        ? await startOAuth(request, env, body)
        : await completeOAuth(request, env, body, fetcher),
    );
  }
  const accountMatch = url.pathname.match(
    /^\/admin\/credentials\/([a-f0-9-]{36})\/(email|verify|test|download|preview|credits)$/,
  );
  if (accountMatch) {
    const action = accountMatch[2];
    if (request.method !== (action === 'download' ? 'GET' : 'POST'))
      throw new HttpError(405, '请求方法不支持');
    const row = await credentialById(env.DB, accountMatch[1]);
    const accountEnv = action === 'download' ? env : await effectiveEnv(env);
    if (action === 'credits') {
      const { enabled } = await readJson(request);
      if (row.mode !== 'antigravity' || typeof enabled !== 'boolean')
        throw new HttpError(400, 'Credits 仅支持 Antigravity，enabled 须为布尔值');
      await saveData(env.DB, row, { enable_credit: enabled });
      return json({ success: true, enabled });
    }
    if (action === 'preview')
      return json(
        await operation('preview_configure', () => configurePreview(accountEnv, row, fetcher)),
      );
    if (action === 'email') return json(await fetchEmail(accountEnv, row, fetcher));
    if (action === 'verify')
      return json(
        await verifyProject(accountEnv, row, fetcher, request.body ? await readJson(request) : {}),
      );
    if (action === 'test')
      return json(
        await testCredential(
          await effectiveEnv(env),
          row,
          (await readJson(request)).model,
          fetcher,
        ),
      );
    const response = json(row.data);
    response.headers.set(
      'content-disposition',
      "attachment; filename*=UTF-8''" +
        encodeURIComponent(row.name.endsWith('.json') ? row.name : row.name + '.json'),
    );
    return response;
  }
  if (url.pathname === '/admin/credentials') {
    if (request.method === 'GET')
      return json({
        credentials: await listCredentials(env.DB, env),
        oauth_clients: Object.fromEntries(
          Object.entries(oauthClients(env))
            .filter(([, client]) => client.client_id)
            .map(([mode, client]) => [client.client_id, mode]),
        ),
      });
    if (request.method === 'POST')
      return json(await importCredential(env.DB, await readJson(request), env), 201);
  }
  const quotaMatch = url.pathname.match(/^\/admin\/credentials\/([a-f0-9-]{36})\/quota$/);
  if (quotaMatch) {
    if (request.method !== 'GET') throw new HttpError(405, '请求方法不支持');
    return json(await credentialQuota(env, quotaMatch[1], fetcher));
  }
  const match = url.pathname.match(/^\/admin\/credentials\/([a-f0-9-]{36})$/);
  if (match) {
    if (request.method === 'DELETE') {
      const result = await env.DB.prepare('DELETE FROM credentials WHERE id=?')
        .bind(match[1])
        .run();
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
