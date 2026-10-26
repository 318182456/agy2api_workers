import { normalizeRequest } from '../protocols/gemini.js';

export const searchModel = (id) =>
  /^gemini-/i.test(id) && !/(?:image|audio|tts|live|robotic|embedding|agent)/i.test(id);

// A catalog ID can itself end in -high/-low/-tiered. Never erase that native route.
export function modelRequest(request, model, mode, resolve = () => null) {
  const exact = resolve(model);
  const base = model.endsWith('-search') ? model.slice(0, -7) : null;
  const searchRoute = !exact && base && searchModel(base) ? resolve(base) : null;
  const normalized = normalizeRequest(request, searchRoute ? base : model, mode);
  if (searchRoute) {
    const tools = normalized.request.tools || [];
    if (!tools.some((tool) => tool?.googleSearch !== undefined))
      normalized.request.tools = [...tools, { googleSearch: {} }];
  }
  return {
    model: exact || searchRoute || resolve(normalized.model) || normalized.model,
    request: normalized.request,
  };
}
