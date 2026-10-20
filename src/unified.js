import { retryableStatus } from './timeouts.js';
import { HttpError, operation } from './common.js';
import { selectCredential } from './credentials.js';
import { normalizeRequest } from './normalize.js';
import { callUpstream } from './upstream.js';
import { discoverModels } from './model-list.js';
import { loadModelNames, knownModelId } from './model-names.js';
import { dbCache } from './db-cache.js';

export function unifiedRouting(env, model) {
  const models = Object.fromEntries(
    ['geminicli', 'antigravity'].map((mode) => [
      mode,
      knownModelId(env, mode, model) || normalizeRequest({}, model, mode).model,
    ]),
  );
  const scope = env.DB ? dbCache(env.DB) : {};
  const known = { geminicli: scope.cliModels?.value?.ids, antigravity: scope.models?.value?.ids };
  const matched = ['geminicli', 'antigravity'].filter(
    (mode) =>
      (mode === 'geminicli' && /^gemini-/i.test(models[mode])) ||
      !known[mode]?.length ||
      known[mode].includes(model) ||
      known[mode].includes(models[mode]),
  );
  const exclusive =
    /^(?:claude-|gpt-|tab_|chat_)/i.test(model) || /-agent$|-image(?:-|$)/i.test(model);
  return {
    models,
    modes: exclusive ? ['antigravity'] : matched.length ? matched : ['geminicli', 'antigravity'],
  };
}
// One global attempt budget across both channels, one final usage record per client request.
export async function callUnifiedUpstream(env, model, request, stream, signal, fetcher, meta) {
  await Promise.all(['geminicli', 'antigravity'].map((mode) => loadModelNames(env, mode)));
  const routing = unifiedRouting(env, model);
  const configured = Number(env.MAX_CREDENTIAL_ATTEMPTS ?? 3);
  const limit = Number.isFinite(configured) ? Math.max(1, Math.min(5, Math.floor(configured))) : 3;
  const used = [];
  const select = () =>
    operation('credential_select', () =>
      selectCredential(env.DB, 'auto', model, used, env.CREDENTIAL_SELECTION, routing),
    );
  let row = await select();
  for (let attempt = 0; attempt < limit; attempt++) {
    used.push(row.id);
    meta.mode = row.mode;
    meta.initialRow = row;
    const collect = row.mode === 'antigravity' && !stream && env.ANTIGRAVITY_STREAM2NOSTREAM;
    let response, failure;
    try {
      response = await callUpstream(
        { ...env, MAX_CREDENTIAL_ATTEMPTS: 1 },
        row.mode,
        model,
        request,
        stream || collect,
        signal,
        fetcher,
        meta,
      );
    } catch (error) {
      delete meta.initialRow;
      const retryable =
        error instanceof HttpError &&
        (error.operation === 'generation_fetch' || error.operation === 'oauth_refresh') &&
        [400, 401, 429, 500, 502, 503, 504].includes(error.status);
      if (!retryable || signal?.aborted) throw error;
      failure = error;
    }
    if (response && !retryableStatus(response.status)) return { response, mode: row.mode, collect };
    if (attempt + 1 >= limit || signal?.aborted) {
      if (failure) throw failure;
      return { response, mode: row.mode, collect };
    }
    let next;
    try {
      next = await select();
    } catch (error) {
      if (!(error instanceof HttpError) || ![429, 503].includes(error.status)) throw error;
      if (failure) throw failure;
      return { response, mode: row.mode, collect };
    }
    // A failed response is discarded only after a different eligible account is ready.
    await response?.body?.cancel();
    row = next;
  }
}
export async function discoverUnifiedModels(env, fetcher) {
  if (!env.DB) throw new HttpError(503, '未绑定 D1 数据库，无法动态获取模型');
  const modes = (
    await env.DB.prepare('SELECT DISTINCT mode FROM credentials WHERE disabled=0').all()
  ).results
    .map((row) => row.mode)
    .filter((mode) => ['geminicli', 'antigravity'].includes(mode));
  const settled = await Promise.allSettled(modes.map((mode) => discoverModels(env, mode, fetcher)));
  const ids = [
    ...new Set(
      settled.flatMap((result) => (result.status === 'fulfilled' ? result.value.ids : [])),
    ),
  ].sort();
  if (!ids.length && settled.length && settled.every((result) => result.status === 'rejected'))
    throw settled[0].reason;
  return {
    ids,
    source: 'unified',
    queriedAt: new Date().toISOString(),
    warning: settled.some((result) => result.status === 'rejected')
      ? '部分渠道模型列表暂不可用'
      : null,
  };
}
