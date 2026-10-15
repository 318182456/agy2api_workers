export const modelsScript = String.raw`el('modelsForm').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    el('modelsSource').textContent = '正在查询…';
    el('modelsResult').textContent = '';
    try {
      const value = await api('/admin/models?mode=' + el('modelsMode').value);
      const labels = {
        google: 'Google 实时返回',
        vars: 'vars 配置',
        fallback: '备用 vars 配置（动态查询失败）',
      };
      el('modelsSource').textContent =
        '来源：' +
        labels[value.source] +
        '；共 ' +
        value.ids.length +
        ' 个模型。' +
        (value.warning || '');
      el('modelsResult').textContent = value.ids.length ? value.ids.join('\n') : '未返回模型';
      status('模型列表已更新。');
    } catch (error) {
      el('modelsSource').textContent = '查询失败：' + error.message;
      throw error;
    }
  });
};
`;
