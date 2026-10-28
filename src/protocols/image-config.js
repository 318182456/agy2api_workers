import { HttpError } from '../core/common.js';

function object(value, name) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value)))
    throw new HttpError(400, name + ' 必须为对象');
  return value || {};
}
function imageProperties(value, name) {
  const result = { ...object(value, name) };
  for (const [snake, camel] of [
    ['image_size', 'imageSize'],
    ['aspect_ratio', 'aspectRatio'],
  ]) {
    if (result[camel] == null && result[snake] != null) result[camel] = result[snake];
    delete result[snake];
  }
  if (typeof result.imageSize === 'string' && /^(?:1k|2k|4k)$/i.test(result.imageSize))
    result.imageSize = result.imageSize.toUpperCase();
  return result;
}

// Public SDKs can use responseFormat.image; the internal generation endpoint expects imageConfig.
// Move only equivalent size/aspect settings. Preserve all unrelated fields and caller-owned data.
export function normalizeImageSettings(request) {
  if (request.generationConfig == null && request.generation_config == null) return request;
  const config = {
    ...object(request.generation_config, 'generation_config'),
    ...object(request.generationConfig, 'generationConfig'),
  };
  const format = {
    ...object(config.response_format, 'response_format'),
    ...object(config.responseFormat, 'responseFormat'),
  };
  const legacyImage = imageProperties(format.image, 'responseFormat.image');
  const moved = {};
  for (const key of ['imageSize', 'aspectRatio'])
    if (legacyImage[key] != null) {
      moved[key] = legacyImage[key];
      delete legacyImage[key];
    }
  if (Object.keys(legacyImage).length) format.image = legacyImage;
  else delete format.image;
  delete config.response_format;
  delete config.responseFormat;
  if (Object.keys(format).length) config.responseFormat = format;
  const image = {
    ...moved,
    ...imageProperties(config.image_config, 'image_config'),
    ...imageProperties(config.imageConfig, 'imageConfig'),
  };
  delete config.image_config;
  delete config.imageConfig;
  if (Object.keys(image).length) config.imageConfig = image;
  if (config.responseModalities == null && config.response_modalities != null)
    config.responseModalities = config.response_modalities;
  delete config.response_modalities;
  const result = { ...request, generationConfig: config };
  delete result.generation_config;
  return result;
}
