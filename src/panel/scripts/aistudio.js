export const aistudioScript = String.raw`let aistudioSnapshot = null;
let aistudioRevision = '';
let aistudioCsrf = '';
function fillAistudio(value) {
  aistudioSnapshot = value;
  if (credentialsLoaded) {
    renderCredentials();
    renderCredentialSummary();
  }
  aistudioRevision = value.revision || '';
  if (value.csrf_token != null) aistudioCsrf = value.csrf_token;
  el('aistudioEnabled').checked = value.enabled === true;
  el('aistudioUrl').value = value.url || '';
  el('aistudioKey').value = '';
  el('aistudioKeyNote').textContent = value.has_key
    ? '已保存上游密钥，留空保留原值。'
    : '填写 AIStudio2API 的 PROXY_API_KEY；保存后不回显。';
  el('aistudioRouting').value = value.routing || 'explicit';
  el('aistudioKeepalive').checked = value.keepalive !== false;
  el('aistudioEndpoint').textContent =
    location.origin + (value.routing === 'default' ? '/v1' : '/aistudio/v1');
  renderEndpoints();
  const probe = value.probe;
  el('aistudioProbe').textContent = probe
    ? (probe.ok ? '连接正常' : '连接异常') +
      ' · ' +
      formatReset(probe.checked_at) +
      ' · HTTP ' +
      (probe.http_status || '未知') +
      ' · ' +
      probe.duration_ms +
      ' ms'
    : '尚无探测记录';
  if (!value.enabled) el('aistudioProbe').textContent += ' · 接入未启用';
  else if (value.keepalive !== false)
    el('aistudioProbe').textContent += ' · 每 10 分钟探测，平台可能延迟';
}
async function loadAistudio() {
  fillAistudio(await api('/admin/aistudio'));
}
async function aistudioAction(action) {
  el('aistudioFeedback').textContent = '正在处理…';
  try {
    await action();
  } catch (error) {
    el('aistudioFeedback').textContent = error.message;
    throw error;
  }
}
el('aistudioForm').onsubmit = (event) => {
  event.preventDefault();
  run(() =>
    aistudioAction(async () => {
      const result = await api(
        '/admin/aistudio',
        'PATCH',
        {
          revision: aistudioRevision,
          url: el('aistudioUrl').value.trim(),
          api_key: el('aistudioKey').value,
          enabled: el('aistudioEnabled').checked,
          routing: el('aistudioRouting').value,
          keepalive: el('aistudioKeepalive').checked,
        },
        undefined,
        { 'x-csrf-token': aistudioCsrf },
      );
      fillAistudio(result);
      el('aistudioFeedback').textContent = '已保存。启用定期探测后将在下一个 10 分钟整点执行。';
    }),
  );
};
el('aistudioReload').onclick = () =>
  run(() =>
    aistudioAction(async () => {
      await loadAistudio();
      el('aistudioFeedback').textContent = '已加载保存的配置。';
    }),
  );
el('aistudioTest').onclick = () =>
  run(() =>
    aistudioAction(async () => {
      const result = await api('/admin/aistudio/test', 'POST', {}, undefined, {
        'x-csrf-token': aistudioCsrf,
      });
      if (result.skipped) throw new Error('请先保存并启用上游配置');
      el('aistudioModels').textContent = (result.models || []).join('\n');
      await loadAistudio();
      el('aistudioFeedback').textContent = result.ok
        ? '模型目录可用，共 ' + result.model_count + ' 个模型；未发起生成。'
        : result.message;
    }),
  );
el('aistudioCopy').onclick = () =>
  run(() =>
    aistudioAction(async () => {
      await navigator.clipboard.writeText(el('aistudioEndpoint').textContent);
      el('aistudioFeedback').textContent = '已复制客户端地址，请使用本项目 API 密钥。';
    }),
  );
`;
