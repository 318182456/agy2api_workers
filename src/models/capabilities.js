import { antigravityAliases, routedThinking } from './antigravity.js';
import { parseModel } from '../protocols/gemini.js';
import { modelRequest, searchModel } from './request.js';

// Describe the actual request adapter and discovered routes, not a second model-version list.
export function describeModels(catalog, mode) {
  const routes = catalog.routes || Object.fromEntries(catalog.ids.map((id) => [id, id]));
  const resolve = (id) => (Object.hasOwn(routes, id) ? routes[id] : null);
  const available = new Set(Object.values(routes));
  return catalog.ids.map((id) => {
    const parsed = parseModel(id);
    const image = /image/i.test(id),
      gemini = /^gemini-/i.test(id),
      claude = /^claude-/i.test(id);
    const specialized = /audio|tts|live|robotic|embedding/i.test(id);
    const description = image
      ? '图片生成、图片编辑；需使用支持图片的客户端'
      : specialized
        ? '音频、实时或其他专用模型；当前兼容接口未确认支持其专用能力'
        : gemini
          ? /flash-lite/i.test(id)
            ? '轻量对话、分类、信息提取、批量摘要'
            : /pro/i.test(id)
              ? '复杂问题、推理、编程与长文分析'
              : '通用对话、编程、摘要与信息提取'
          : claude
            ? '文本对话、编程、工具调用；可使用 OpenAI 或 Messages 格式'
            : '上游发现的模型；具体输入输出能力以该渠道返回为准';
    const variants = [{ id, label: '原始调用', note: '保持当前模型及上游档位' }];
    const add = (name, label, note) => {
      try {
        const value = modelRequest({}, name, mode, resolve);
        if (available.has(value.model)) variants.push({ id: name, label, note });
      } catch {
        /* An adapter rejection is not a supported shortcut. */
      }
    };
    if (searchModel(id) && !id.endsWith('-search'))
      add(
        id + '-search',
        '联网搜索',
        '添加 Google 搜索工具；模型按需搜索，渠道可用性以实际响应为准',
      );
    if (parsed.profile && parsed.model === id && !routedThinking(routes[id] || id)) {
      for (const [suffix, label] of [
        ['low', '低思考'],
        ['medium', '中思考'],
        ['high', '高思考'],
        ['maxthinking', '最高思考'],
      ])
        add(id + '-' + suffix, label, '设置本项目支持的思考预算或等级');
      add(
        id + '-nothinking',
        '降低 / 关闭思考',
        parsed.profile.efforts.off === 0
          ? '关闭思考预算'
          : '此模型不能完全关闭思考，映射为最低预算或等级',
      );
    }
    if (mode === 'antigravity')
      for (const [alias, target] of Object.entries(antigravityAliases))
        if (target === (routes[id] || id) && !catalog.ids.includes(alias))
          add(
            alias,
            alias.endsWith('-thinking') ? '思考模式' : '兼容调用名',
            '使用程序已有的映射，保留上游真实 ID',
          );
    if (image && mode === 'antigravity')
      for (const size of ['1k', '2k', '4k'])
        add(id + '-' + size, size.toUpperCase() + ' 图片', '请求对应图片尺寸；以渠道实际支持为准');
    return {
      id,
      upstream_id: routes[id] || id,
      description,
      variants,
      search: variants.some((v) => v.label === '联网搜索'),
      note: routedThinking(routes[id] || id)
        ? '思考档位由上游模型 ID 决定；reasoning_effort 不改写该档位，请选择目录中的对应型号'
        : variants.length === 1
          ? '未提供已确认的快捷后缀，请使用原始名称；不代表模型本身没有其他能力'
          : /-(?:high|low|medium|tiered)$/.test(id)
            ? '名称已包含上游档位，搜索调用会保留该档位'
            : '',
    };
  });
}
