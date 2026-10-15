import { HttpError } from './common.js';
import { cleanToolSchema } from './schema.js';
import { antigravityModel, claudeToolIds } from './antigravity-models.js';

const budgets = { off: 0, minimal: 0, low: 1024, medium: 8192, high: 16000, max: 24576 };
const lowLevels = { off: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', max: 'high' };
const profiles = {
  'gemini-2.5-flash': { kind: 'budget', min: 0, max: 24576, efforts: budgets, noPrefill: true },
  'gemini-2.5-pro': { kind: 'budget', min: 128, max: 32768, efforts: { ...budgets, off: 128, minimal: 128, max: 32768 } },
  'gemini-3-flash-preview': { kind: 'level', efforts: lowLevels, noPrefill: true },
  'gemini-3-pro-preview': { kind: 'level', efforts: { ...lowLevels, medium: 'high' } },
  'gemini-3.1-pro-preview': { kind: 'level', efforts: lowLevels },
  'gemini-3.1-flash-lite-preview': { kind: 'level', efforts: { ...lowLevels, off: 'minimal', minimal: 'minimal' } },
  'gemini-3.1-flash-lite': { kind: 'level', efforts: { ...lowLevels, off: 'minimal', minimal: 'minimal' } },
  'gemini-3.5-flash': { kind: 'level', efforts: { ...lowLevels, off: 'minimal', minimal: 'minimal' }, noPrefill: true },
  'gemini-3.8-flash': { kind: 'level', efforts: lowLevels, noPrefill: true },
};
const suffixes = { '-nothinking': 'off', '-maxthinking': 'max', '-minimal': 'minimal', '-medium': 'medium', '-high': 'high', '-max': 'max', '-low': 'low', '-search': 'search', '-think': 'think' };
export function parseModel(model) {
  let base = model;
  let effort;
  let search = false;
  while (true) {
    const suffix = Object.keys(suffixes).find(suffix => base.endsWith(suffix));
    if (!suffix) break;
    base = base.slice(0, -suffix.length);
    const value = suffixes[suffix];
    if (value === 'search') search = true;
    else if (value !== 'think' && !effort) effort = value;
  }
  // Unknown upstream IDs may legitimately end in -high etc.; preserve them verbatim.
  return Object.hasOwn(profiles, base) ? { model: base, profile: profiles[base], effort, search } : { model, profile: null };
}
export function normalizeRequest(request, model, mode) {
  if (request.generationConfig != null && (typeof request.generationConfig !== 'object' || Array.isArray(request.generationConfig))) throw new HttpError(400, 'generationConfig 必须为对象');
  const mapped = mode === 'antigravity' ? antigravityModel(request, model) : { request: structuredClone(request), model };
  const result = mapped.request;
  const parsed = mapped.routed ? { model: mapped.model, profile: null } : parseModel(mapped.model);
  const config = result.generationConfig || {};
  if (typeof config !== 'object' || Array.isArray(config)) throw new HttpError(400, 'generationConfig 必须为对象');
  const explicit = result._reasoningEffort;
  delete result._reasoningEffort;
  if (parsed.profile) {
    const p = parsed.profile;
    const thinking = config.thinkingConfig || {};
    if (typeof thinking !== 'object' || Array.isArray(thinking)) throw new HttpError(400, 'thinkingConfig 必须为对象');
    const budget = thinking.thinkingBudget;
    const level = typeof thinking.thinkingLevel === 'string' ? thinking.thinkingLevel.toLowerCase() : null;
    const effort = parsed.effort || explicit;
    let resolved;
    if (effort) resolved = p.efforts[effort];
    else if (p.kind === 'budget') {
      if (Number.isInteger(budget)) resolved = budget < 0 ? -1 : Math.min(p.max, Math.max(p.min, budget));
      else if (level && p.efforts[level] !== undefined) resolved = p.efforts[level];
    } else if (level && p.efforts[level] !== undefined) resolved = p.efforts[level];
    else if (Number.isInteger(budget) && budget >= 0) resolved = p.efforts[budget === 0 ? 'off' : budget <= 1024 ? 'low' : budget <= 8192 ? 'medium' : budget <= 16000 ? 'high' : 'max'];
    const normalized = { ...thinking };
    delete normalized.thinkingBudget; delete normalized.thinkingLevel;
    if (resolved !== undefined) normalized[p.kind === 'budget' ? 'thinkingBudget' : 'thinkingLevel'] = resolved;
    if (resolved === 0) normalized.includeThoughts = false;
    if (Object.keys(normalized).length) config.thinkingConfig = normalized;
    else delete config.thinkingConfig;
  } else if (explicit) throw new HttpError(400, '该模型暂不支持 reasoning_effort 自动映射，请使用原生 thinking_config');
  if (parsed.search) {
    const tools = result.tools || [];
    if (!Array.isArray(tools)) throw new HttpError(400, 'tools 必须为数组');
    if (!tools.some(tool => tool?.googleSearch !== undefined)) result.tools = [...tools, { googleSearch: {} }];
  }
  if (result.contents) {
    if (!Array.isArray(result.contents)) throw new HttpError(400, 'contents 必须为数组');
    result.contents = result.contents.map(content => {
      if (!content || !['user', 'model'].includes(content.role || 'user') || !Array.isArray(content.parts)) throw new HttpError(400, 'contents 中的消息必须包含 user/model 角色和 parts 数组');
      const parts = content.parts.filter(part => part && typeof part === 'object' && Object.entries(part).some(([key, value]) => key !== 'thought' && value != null && value !== '' && !(Array.isArray(value) && !value.length)));
      return { ...content, role: content.role || 'user', parts };
    }).filter(content => content.parts.length);
    // Follow the original model-specific prefill handling; tool history and signatures remain intact.
    if (parsed.profile?.noPrefill || mode === 'antigravity') while (result.contents.at(-1)?.role === 'model') result.contents.pop();
    if (!result.contents.length) throw new HttpError(400, '整理预填充消息后没有可用内容，请以用户或工具回复结束对话');
  }
  if (mode === 'antigravity' && parsed.model.startsWith('claude-') && result.contents) result.contents = claudeToolIds(result.contents);
  const schemaBudget = { nodes: 0 };
  if (result.tools) {
    if (!Array.isArray(result.tools)) throw new HttpError(400, 'tools 必须为数组');
    result.tools = result.tools.map(tool => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new HttpError(400, '工具格式无效');
      const copy = { ...tool };
      const declarations = copy.functionDeclarations || copy.function_declarations;
      if (declarations !== undefined) {
        if (!Array.isArray(declarations)) throw new HttpError(400, 'functionDeclarations 必须为数组');
        copy.functionDeclarations = declarations.map(declaration => {
          if (!declaration || typeof declaration !== 'object' || !declaration.name) throw new HttpError(400, '工具声明缺少名称');
          const value = { ...declaration };
          const schema = value.parameters ?? value.parametersJsonSchema ?? value.parameters_json_schema ?? { type: 'object', properties: {} };
          const cleaned = cleanToolSchema(schema, schemaBudget);
          delete value.parameters; delete value.parametersJsonSchema; delete value.parameters_json_schema;
          value[mode === 'antigravity' ? 'parameters' : 'parametersJsonSchema'] = cleaned;
          return value;
        });
        delete copy.function_declarations;
      }
      return copy;
    });
  }
  if (Object.keys(config).length) result.generationConfig = config;
  return { model: parsed.model, request: result };
}
