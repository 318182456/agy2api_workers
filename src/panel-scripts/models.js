export const modelsScript = String.raw`el('modelsForm').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    el('modelsSource').textContent = '正在查询…';
    el('modelsResult').textContent = '';
    try {
      const value = await api('/admin/models?mode=' + el('modelsMode').value);
      const labels = {
        google: 'Google 实时返回',
        quota: 'Google GeminiCLI 配额中的模型 ID',
        cache: '上次动态查询结果（实时查询失败）',
      };
      el('modelsSource').textContent =
        '来源：' +
        labels[value.source] +
        '；共 ' +
        value.ids.length +
        ' 个模型。' +
        (value.warning || '') +
        (value.reference
          ? value.reference.error
            ? '；官网查询暂不可用，保留已有参考及上游名称。'
            : '；官网参考已缓存，精确匹配 ' + value.reference.matched + ' 项。'
          : '；发现新模型时查询官网参考（需绑定 KV）。');
      el('modelsResult').textContent = value.ids.length ? value.ids.join('\n') : '未返回模型';
      status('模型列表已更新。');
    } catch (error) {
      el('modelsSource').textContent = '查询失败：' + error.message;
      throw error;
    }
  });
};
`;
