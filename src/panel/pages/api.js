const protocols = [
  ['openai', 'OpenAI 兼容', 'Chat Completions'],
  ['gemini', 'Gemini 原生', 'generateContent / streamGenerateContent'],
  ['messages', 'Messages 兼容', 'Claude 客户端格式，模型仍由请求决定'],
];
const group = {
  mode: 'antigravity',
  title: 'Antigravity',
  ids: ['openaiUrl', 'geminiUrl', 'anthropicUrl'],
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
export const apiPage = String.raw`<section class="card"><div class="card-heading"><div><h2>连接你的客户端</h2><p>所有请求使用 Antigravity 凭证，按模型和账号额度调度。</p></div><button id="endpointsRefresh" class="secondary">刷新可用状态</button></div><p class="data-note">API Key 填写“API 密钥”页创建或导入的密钥，原总密钥也可继续使用。</p>${renderEndpointGroup(group)}<p class="data-note">也兼容 /antigravity 前缀。可重试故障在尝试次数内换账号；模型被列出不代表当前账号一定有权限或剩余额度。</p></section>`;
