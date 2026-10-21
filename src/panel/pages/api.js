const protocols = [
  ['openai', 'OpenAI 兼容', 'Chat Completions'],
  ['gemini', 'Gemini 原生', 'generateContent / streamGenerateContent'],
  ['messages', 'Messages 兼容', 'Claude 客户端格式，模型仍由请求决定'],
];
const groups = [
  {
    mode: 'antigravity',
    title: 'Antigravity',
    ids: ['antiUrl', 'antiGeminiUrl', 'antiAnthropicUrl'],
  },
  { mode: 'geminicli', title: 'GeminiCLI', ids: ['openaiUrl', 'geminiUrl', 'anthropicUrl'] },
];
const unifiedGroup = {
  mode: 'auto',
  title: '统一接口 · 自动调度',
  ids: ['unifiedOpenaiUrl', 'unifiedGeminiUrl', 'unifiedMessagesUrl'],
};
function renderEndpointGroup(group) {
  return (
    '<section class="endpoint-group" id="endpoint-group-' +
    group.mode +
    '"><div class="endpoint-group-heading"><h3>' +
    group.title +
    '</h3><span class="pill unknown" id="endpoint-group-state-' +
    group.mode +
    '">正在检查凭证…</span></div>' +
    protocols
      .map(([, label, description], index) => {
        const id = group.ids[index];
        return (
          '<div class="endpoint endpoint-disabled" id="endpoint-' +
          id +
          '"><div><span>' +
          label +
          '</span><small>' +
          description +
          '</small><code id="' +
          id +
          '"></code></div><button class="secondary copy-endpoint" id="copy-' +
          id +
          '" data-copy="' +
          id +
          '" aria-describedby="endpoint-group-state-' +
          group.mode +
          '" type="button" disabled>复制</button></div>'
        );
      })
      .join('') +
    '</section>'
  );
}
export const apiPage = String.raw`<section class="card"><div class="card-heading"><div><h2>连接你的客户端</h2><p>默认使用统一地址。程序按模型支持和调度策略选择 GeminiCLI 或 Antigravity 凭证；无需客户端区分渠道。</p></div><button id="endpointsRefresh" class="secondary">刷新可用状态</button></div><p class="data-note">API Key 填写“API 密钥”页创建或导入的密钥，原总密钥也可继续使用。</p>${renderEndpointGroup(unifiedGroup)}<details class="help endpoint-expert"><summary>指定凭证渠道（高级，旧地址仍可使用）</summary><p>仅在希望固定使用某一类凭证时选择下方地址。</p><div class="endpoint-groups">${groups.map(renderEndpointGroup).join('')}</div></details><p class="data-note">两边都支持的模型可参与统一调度，额度分别记录；可重试故障可在全局尝试次数内换账号。模型列表不代表所有账号一定有权限或剩余额度。</p></section>`;
