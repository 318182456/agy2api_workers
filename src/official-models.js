import { readShared, publishShared } from './shared-cache.js';

export const OFFICIAL_MODELS_URL = 'https://ai.google.dev/gemini-api/docs/models?hl=en';
export const OFFICIAL_RELEASES_URL = 'https://ai.google.dev/gemini-api/docs/changelog?hl=en';

// The public catalog is reference information, never an account entitlement or routing table.
export function officialModelIds(html) {
  const ids = new Set();
  for (const match of html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) {
    const text = match[1].replace(/<[^>]*>/g, '').trim();
    if (/^(?:models\/)?gemini-\d[A-Za-z0-9._-]{0,190}$/.test(text))
      ids.add(text.replace(/^models\//, ''));
  }
  for (const match of html.matchAll(
    /href=["'](?:https:\/\/ai\.google\.dev)?\/gemini-api\/docs\/models\/(gemini-\d[A-Za-z0-9._-]{0,190})(?:[?#][^"']*)?["']/gi,
  ))
    ids.add(match[1]);
  return [...ids].sort();
}
export async function refreshOfficialModels(env, discoveredIds, fetcher = fetch) {
  if (!env.CACHE?.put) return null;
  const old = await readShared(env, 'official-models');
  const seen = new Set(old?.value?.seen || []);
  const incoming = [...new Set(discoveredIds)].filter(
    (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id),
  );
  if (!incoming.some((id) => !seen.has(id))) return old?.value || null;
  const observed = [...new Set([...seen, ...incoming])].slice(-2000);
  const remember = async (value) => {
    await publishShared(env, 'official-models', value, 365 * 86400);
    return value;
  };
  try {
    const response = await fetcher(OFFICIAL_MODELS_URL, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'text/html' },
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
      await response.body?.cancel();
      throw new Error('official_catalog_response');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0,
      html = '';
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2000000) throw new Error('official_catalog_size');
        html += decoder.decode(part.value, { stream: true });
      }
      html += decoder.decode();
    } finally {
      await reader.cancel();
    }
    const ids = officialModelIds(html);
    if (!ids.length || ids.length > 2000) throw new Error('official_catalog_format');
    const value = {
      ids,
      source: OFFICIAL_MODELS_URL,
      releases: OFFICIAL_RELEASES_URL,
      queriedAt: new Date().toISOString(),
      seen: observed,
      error: false,
    };
    return await remember(value);
  } catch {
    console.warn(JSON.stringify({ event: 'official_model_catalog_refresh_failed' }));
    return await remember({
      ids: old?.value?.ids || [],
      source: OFFICIAL_MODELS_URL,
      releases: OFFICIAL_RELEASES_URL,
      queriedAt: old?.value?.queriedAt || null,
      seen: observed,
      error: true,
    });
  }
}
