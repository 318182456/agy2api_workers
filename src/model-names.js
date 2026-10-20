import { dbCache } from './db-cache.js';
import { readShared } from './shared-cache.js';

export const validModelId = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id);
const cacheKey = (mode) => (mode === 'antigravity' ? 'models' : 'cliModels');

// Derive names from metadata, never from a list of model versions or guessed equivalents.
export function modelCatalog(entries) {
  const source = entries.filter(([id]) => validModelId(id));
  const rawIds = new Set(source.map(([id]) => id));
  const candidates = source.map(([raw, info]) => {
    if (!raw.startsWith('gemini-') || /^gemini-\d/.test(raw)) return raw;
    const label = typeof info?.displayName === 'string' ? info.displayName.trim() : '';
    // Only explicit English family/version names are reversible. Unknown labels keep their ID.
    if (!/^Gemini\s+\d+(?:\.\d+)*\s+[A-Za-z][A-Za-z0-9 .()-]*$/i.test(label)) return raw;
    const name = label.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, '-');
    return validModelId(name) ? name : raw;
  });
  const counts = new Map();
  for (const id of candidates) counts.set(id, (counts.get(id) || 0) + 1);
  const routes = Object.fromEntries(
    source.map(([raw], index) => {
      const name = candidates[index];
      // Distinct upstream variants must never disappear behind an ambiguous alias.
      return [counts.get(name) > 1 || (name !== raw && rawIds.has(name)) ? raw : name, raw];
    }),
  );
  return { ids: Object.keys(routes).sort(), routes };
}
export function validRoutes(ids, routes) {
  return (
    routes &&
    typeof routes === 'object' &&
    !Array.isArray(routes) &&
    ids.every((id) => Object.hasOwn(routes, id) && validModelId(routes[id])) &&
    Object.keys(routes).length === ids.length
  );
}
export async function loadModelNames(env, mode) {
  if (!env.DB) return;
  const scope = dbCache(env.DB),
    key = cacheKey(mode);
  if (scope[key]?.until > Date.now() || scope[key + 'ReadUntil'] > Date.now()) return;
  scope[key + 'ReadUntil'] = Date.now() + 60000;
  const shared = await readShared(env, 'model-names:' + mode),
    value = shared?.value;
  if (
    !Array.isArray(value?.ids) ||
    value.ids.length > 2000 ||
    !value.ids.every(validModelId) ||
    !validRoutes(value.ids, value.routes)
  )
    return;
  scope[key] = {
    until: Math.min(shared.created + 900000, Date.now() + 60000),
    value: { ...value, queriedAt: new Date(shared.created).toISOString() },
  };
}
export function knownModelId(env, mode, model) {
  if (!env.DB) return null;
  const value = dbCache(env.DB)[cacheKey(mode)]?.value;
  if (!value || Date.parse(value.queriedAt) < Date.now() - 86400000) return null;
  if (value.routes && Object.hasOwn(value.routes, model)) return value.routes[model];
  return Object.values(value.routes || {}).includes(model) ? model : null;
}

export function publicModelId(env, mode, raw) {
  const routes = env.DB ? dbCache(env.DB)[cacheKey(mode)]?.value?.routes : null;
  return Object.entries(routes || {}).find(([, id]) => id === raw)?.[0] || raw;
}
