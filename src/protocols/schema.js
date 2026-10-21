import { HttpError } from '../core/common.js';
const supported = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);
const constraints = [
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'uniqueItems',
  'additionalProperties',
];
function hint(node, value) {
  if (!value) return;
  const description = typeof node.description === 'string' ? node.description : '';
  node.description = (description + (description ? ' ' : '') + '[' + value + ']').slice(0, 8000);
}
function summary(value) {
  return String(JSON.stringify(value)).slice(0, 800);
}
function resolve(root, ref) {
  if (ref === '#') return root;
  if (typeof ref !== 'string' || !ref.startsWith('#/'))
    throw new HttpError(400, '工具 Schema 仅支持本地 $ref，不能请求远程引用');
  let current = root;
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key))
      throw new HttpError(400, '工具 Schema 引用路径不存在');
    current = current[key];
  }
  return current;
}
export function cleanToolSchema(schema, budget = { nodes: 0 }) {
  function clean(input, depth, references) {
    if (++budget.nodes > 4000 || depth > 24)
      throw new HttpError(400, '工具 Schema 展开过大或嵌套过深，请简化工具定义');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new HttpError(400, '工具 Schema 必须为对象');
    let node = input;
    const reference = node.$ref ?? node.ref;
    if (reference !== undefined) {
      const target = resolve(schema, reference);
      if (!target || typeof target !== 'object' || Array.isArray(target))
        throw new HttpError(400, '工具 Schema 引用必须指向对象');
      if (references.has(target))
        return {
          type: 'object',
          description: 'Recursive reference simplified; use the documented object structure.',
        };
      references = new Set(references);
      references.add(target);
      const { $ref, ref, ...siblings } = node;
      return clean({ ...target, ...siblings }, depth + 1, references);
    }
    let result = {};
    if (node.allOf !== undefined) {
      if (!Array.isArray(node.allOf)) throw new HttpError(400, 'allOf 必须为数组');
      for (const branch of node.allOf) {
        const part = clean(branch, depth + 1, references);
        const properties = { ...result.properties, ...part.properties };
        const required = [...(result.required || []), ...(part.required || [])];
        result = { ...result, ...part };
        if (Object.keys(properties).length) result.properties = properties;
        if (required.length) result.required = required;
      }
    }
    const union = node.anyOf ?? node.oneOf;
    if (union !== undefined) {
      if (!Array.isArray(union) || !union.length)
        throw new HttpError(400, 'anyOf/oneOf 必须为非空数组');
      const alternatives = union.filter((part) => !(part && part.type === 'null'));
      if (
        alternatives.length &&
        alternatives.every(
          (part) =>
            part &&
            Object.hasOwn(part, 'const') &&
            ['string', 'number', 'boolean'].includes(typeof part.const),
        )
      ) {
        result = {
          ...result,
          type: 'string',
          enum: alternatives.map((part) => String(part.const)),
        };
      } else {
        const parts = alternatives.map((part) => clean(part, depth + 1, references));
        const preferred = parts.find((part) => ['object', 'array'].includes(part.type)) ||
          parts[0] || { type: 'string' };
        result = { ...result, ...preferred };
      }
      hint(result, 'Alternatives simplified: ' + summary(union));
    }
    if (typeof node.description === 'string')
      result.description = node.description + (result.description ? ' ' + result.description : '');
    if (node.type !== undefined) {
      const types = (Array.isArray(node.type) ? node.type : [node.type])
        .filter((type) => typeof type === 'string')
        .map((type) => type.toLowerCase());
      const type = types.find((type) => supported.has(type));
      if (type) result.type = type;
      else if (types.includes('null')) result.type = 'string';
      if (types.length > 1 || types.includes('null'))
        hint(result, 'Accepted original types: ' + types.join(', '));
    }
    if (node.nullable) hint(result, 'May be null');
    if (Object.hasOwn(node, 'const')) {
      const value = node.const;
      if (['string', 'number', 'boolean'].includes(typeof value)) {
        result.type = 'string';
        result.enum = [String(value)];
      }
      hint(result, 'Original constant: ' + summary(value));
    } else if (Array.isArray(node.enum)) {
      result.enum = node.enum
        .filter((value) => ['string', 'number', 'boolean'].includes(typeof value))
        .map(String);
      result.type = 'string';
    }
    if (node.properties !== undefined) {
      if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties))
        throw new HttpError(400, 'properties 必须为对象');
      const properties = {};
      for (const [name, part] of Object.entries(result.properties || {}))
        Object.defineProperty(properties, name, {
          value: part,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      for (const [name, part] of Object.entries(node.properties))
        Object.defineProperty(properties, name, {
          value: clean(part, depth + 1, references),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      result.properties = properties;
      result.type ||= 'object';
    }
    if (node.items !== undefined) {
      const items = node.items;
      if (Array.isArray(items)) {
        if (items.length) result.items = clean(items[0], depth + 1, references);
        hint(result, 'Tuple items simplified: ' + summary(items));
      } else result.items = clean(items, depth + 1, references);
      result.type ||= 'array';
    }
    const required = [
      ...(result.required || []),
      ...(Array.isArray(node.required) ? node.required : []),
    ];
    if (required.length && result.properties)
      result.required = [
        ...new Set(
          required.filter(
            (name) => typeof name === 'string' && Object.hasOwn(result.properties, name),
          ),
        ),
      ];
    if (!result.required?.length) delete result.required;
    if (Array.isArray(result.enum)) {
      // Google rejects empty enum members. Preserve the original choices in prose
      // rather than narrowing away meaningful empty values such as default sorting.
      if (!result.enum.length || result.enum.includes('')) {
        hint(result, 'Original enum values: ' + summary(node.enum ?? result.enum));
        if (result.enum.includes('')) hint(result, 'Empty string is an allowed value');
        delete result.enum;
      } else result.enum = [...new Set(result.enum)];
    }
    for (const key of constraints)
      if (Object.hasOwn(node, key)) hint(result, key + ': ' + summary(node[key]));
    return result;
  }
  return clean(schema, 0, new Set());
}
