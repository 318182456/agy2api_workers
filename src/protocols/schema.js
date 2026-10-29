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
  function clean(input, depth, references, path = '$') {
    const at = (message) => new HttpError(400, message + '（路径：' + path.slice(0, 1000) + '）');
    if (++budget.nodes > 4000 || depth > 24)
      throw new HttpError(400, '工具 Schema 展开过大或嵌套过深，请简化工具定义');
    // JSON Schema true is the unconstrained schema, equivalent to {}. Reflectors
    // emit it for Go any/interface{} fields and array items. Do not coerce their values.
    if (input === true) return {};
    if (input === false) throw at('工具 Schema false 不允许任何值');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw at('工具 Schema 必须为对象或布尔值');
    let node = input;
    const reference = node.$ref ?? node.ref;
    if (reference !== undefined) {
      let target;
      try {
        target = resolve(schema, reference);
      } catch (error) {
        if (error instanceof HttpError) throw at(error.message);
        throw error;
      }
      const { $ref, ref, ...siblings } = node;
      if (typeof target === 'boolean')
        return clean(target ? siblings : false, depth + 1, references, path + '/$ref');
      if (!target || typeof target !== 'object' || Array.isArray(target))
        throw at('工具 Schema 引用必须指向对象');
      if (references.has(target))
        return {
          type: 'object',
          description: 'Recursive reference simplified; use the documented object structure.',
        };
      references = new Set(references);
      references.add(target);
      return clean({ ...target, ...siblings }, depth + 1, references, path + '/$ref');
    }
    let result = {};
    if (node.allOf !== undefined) {
      if (!Array.isArray(node.allOf)) throw at('allOf 必须为数组');
      for (const [index, branch] of node.allOf.entries()) {
        const part = clean(branch, depth + 1, references, path + '/allOf/' + index);
        const properties = { ...result.properties, ...part.properties };
        const required = [...(result.required || []), ...(part.required || [])];
        result = { ...result, ...part };
        if (Object.keys(properties).length) result.properties = properties;
        if (required.length) result.required = required;
      }
    }
    const unionKey = node.anyOf != null ? 'anyOf' : 'oneOf';
    const union = node.anyOf ?? node.oneOf;
    if (union !== undefined) {
      if (!Array.isArray(union) || !union.length) throw at('anyOf/oneOf 必须为非空数组');
      const alternatives = union.filter(
        (part) => part !== false && !(part && part.type === 'null'),
      );
      if (!alternatives.length && union.every((part) => part === false))
        throw at('工具 Schema 联合分支不允许任何值');
      if (alternatives.includes(true)) {
        // An unconstrained branch makes the whole union unconstrained.
      } else if (
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
        const parts = alternatives.map((part, index) =>
          clean(part, depth + 1, references, path + '/' + unionKey + '/' + index),
        );
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
        throw at('properties 必须为对象');
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
          value: clean(
            part,
            depth + 1,
            references,
            path + '/properties/' + name.replaceAll('~', '~0').replaceAll('/', '~1'),
          ),
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
        if (items.length) result.items = clean(items[0], depth + 1, references, path + '/items/0');
        hint(result, 'Tuple items simplified: ' + summary(items));
      } else result.items = clean(items, depth + 1, references, path + '/items');
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
