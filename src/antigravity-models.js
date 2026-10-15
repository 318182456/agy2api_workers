import { HttpError } from './common.js';
const aliases = {
  'claude-opus-4-6': 'claude-opus-4-6-thinking',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
  'gemini-3.1-pro-high': 'gemini-pro-agent',
};
const ratios = [[1,1],[2,3],[3,2],[3,4],[4,3],[4,5],[5,4],[9,16],[16,9],[21,9]];
export function antigravityModel(request, model) {
  const result = structuredClone(request);
  const mapped = Object.hasOwn(aliases, model) ? aliases[model] : model;
  const config = result.generationConfig || {};
  const image = model.match(/^(gemini-3\.1-flash-image|gemini-3-pro-image-preview|gemini-3-pro-image)((?:-(?:1k|2k|4k|\d+x\d+))*)$/i);
  if (image) {
    if (config.imageConfig != null && (typeof config.imageConfig !== 'object' || Array.isArray(config.imageConfig))) throw new HttpError(400, 'imageConfig 必须为对象');
    let suffixConfig = {};
    for (const size of ['1k', '2k', '4k']) if (image[2].toLowerCase().includes('-' + size)) suffixConfig.imageSize = size.toUpperCase();
    const aspect = image[2].match(/-(\d+)x(\d+)/);
    if (aspect) {
      if (!ratios.some(([w,h]) => w === Number(aspect[1]) && h === Number(aspect[2]))) throw new HttpError(400, '图片模型宽高比后缀不受支持');
      suffixConfig.aspectRatio = aspect[1] + ':' + aspect[2];
    }
    let explicit = {};
    if (result.size !== undefined) {
      const dimensions = typeof result.size === 'string' && result.size.trim().match(/^(\d+)\s*[xX*×]\s*(\d+)$/);
      if (!dimensions || !Number.isSafeInteger(Number(dimensions[1])) || !Number.isSafeInteger(Number(dimensions[2])) || Number(dimensions[1]) <= 0 || Number(dimensions[2]) <= 0) throw new HttpError(400, '图片 size 格式应为 1024x1536 等正整数尺寸');
      const width = Number(dimensions[1]), height = Number(dimensions[2]);
      const [w,h] = [...ratios].sort((a,b) => Math.abs(a[0]/a[1]-width/height)-Math.abs(b[0]/b[1]-width/height))[0];
      explicit = { aspectRatio: w + ':' + h, imageSize: Math.max(width, height) <= 1280 ? '1K' : Math.max(width, height) <= 2560 ? '2K' : '4K' };
    }
    delete result.size;
    result.generationConfig = { ...config, candidateCount: 1, imageConfig: { ...suffixConfig, ...config.imageConfig, ...explicit } };
    delete result.generationConfig.thinkingConfig;
    delete result.systemInstruction; delete result.tools; delete result.toolConfig;
    return { model: 'gemini-3.1-flash-image', request: result, routed: true };
  }
  if (mapped.endsWith('-agent')) {
    if (config.thinkingConfig) { const thinking = { ...config.thinkingConfig }; delete thinking.thinkingBudget; delete thinking.thinkingLevel; config.thinkingConfig = thinking; }
  } else if (model === 'claude-sonnet-4-6-thinking' && !config.thinkingConfig) {
    const limit = config.maxOutputTokens;
    if (limit != null && (!Number.isInteger(limit) || limit < 2)) throw new HttpError(400, '思考模型的 max_tokens 至少为 2');
    config.thinkingConfig = { thinkingBudget: Math.min(1024, limit == null ? 1024 : limit - 1), includeThoughts: true };
  }
  if (Object.keys(config).length) result.generationConfig = config;
  return { model: mapped, request: result, routed: mapped.endsWith('-agent') };
}
export function claudeToolIds(contents) {
  const queues = new Map();
  const seen = new Set();
  return contents.map(content => ({ ...content, parts: content.parts.map(part => {
    if (part.functionCall) {
      const call = { ...part.functionCall };
      call.id ||= 'toolu_' + crypto.randomUUID().replaceAll('-', '');
      if (seen.has(call.id)) throw new HttpError(400, '工具调用 ID 重复');
      seen.add(call.id);
      if (!queues.has(call.name)) queues.set(call.name, []);
      queues.get(call.name).push(call.id);
      return { ...part, functionCall: call };
    }
    if (part.functionResponse) {
      const response = { ...part.functionResponse };
      const queue = queues.get(response.name) || [];
      if (response.id) { const index = queue.indexOf(response.id); if (index < 0) throw new HttpError(400, '工具结果没有匹配的调用 ID'); queue.splice(index, 1); }
      else { response.id = queue.shift(); if (!response.id) throw new HttpError(400, '工具结果没有匹配的函数调用'); }
      return { ...part, functionResponse: response };
    }
    return part;
  }) }));
}
