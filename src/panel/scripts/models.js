export const modelsScript = String.raw`function renderModels(value) {
  const target = el('modelsResult');
  target.replaceChildren();
  if (!value.ids.length) {
    const row = document.createElement('tr'),
      cell = document.createElement('td');
    cell.colSpan = 3;
    cell.textContent = '未返回模型';
    row.append(cell);
    target.append(row);
    return;
  }
  for (const model of value.models ||
    value.ids.map((id) => ({
      id,
      description: '能力信息暂不可用',
      variants: [{ id, label: '原始调用' }],
    }))) {
    const tr = document.createElement('tr');
    const name = document.createElement('td'),
      code = document.createElement('code');
    code.textContent = model.id;
    name.append(code);
    if (model.upstream_id && model.upstream_id !== model.id) {
      const raw = document.createElement('p');
      raw.className = 'data-note';
      raw.textContent = '上游：' + model.upstream_id;
      name.append(raw);
    }
    const description = document.createElement('td');
    description.textContent = model.description;
    if (model.note) {
      const note = document.createElement('p');
      note.className = 'data-note';
      note.textContent = model.note;
      description.append(note);
    }
    const choices = document.createElement('td');
    const extra = document.createElement('details'),
      summary = document.createElement('summary');
    summary.textContent = '思考 / 图片参数';
    extra.append(summary);
    let extraCount = 0;
    for (const variant of model.variants) {
      const item = document.createElement('div');
      item.style.marginBottom = '8px';
      const label = document.createElement('div');
      label.className = 'data-note';
      label.textContent = variant.label + (variant.note ? ' · ' + variant.note : '');
      const id = document.createElement('code');
      id.textContent = variant.id;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'secondary';
      copy.textContent = '复制';
      copy.style.marginLeft = '8px';
      copy.setAttribute('aria-label', '复制 ' + variant.id);
      copy.onclick = async () => {
        try {
          if (!navigator.clipboard?.writeText) {
            copy.textContent = '请选中名称复制';
            return;
          }
          await navigator.clipboard.writeText(variant.id);
          copy.textContent = '已复制';
        } catch {
          copy.textContent = '复制失败，请手动复制';
        }
      };
      item.append(label, id, copy);
      if (variant.label === '原始调用' || variant.label === '联网搜索') choices.append(item);
      else {
        extra.append(item);
        extraCount++;
      }
    }
    if (extraCount) choices.append(extra);
    tr.append(name, description, choices);
    target.append(tr);
  }
}
el('modelsForm').onsubmit = (event) => {
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
      renderModels(value);
      status('模型列表已更新。');
    } catch (error) {
      el('modelsSource').textContent = '查询失败：' + error.message;
      throw error;
    }
  });
};
`;
