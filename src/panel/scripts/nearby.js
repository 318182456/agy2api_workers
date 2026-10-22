export const nearbyScript = String.raw`let nearbyActive = null;
const nearbyMessages = new Map(),
  nearbyTargets = new Map();
function nearbyMessage(key, text, state = 'ready') {
  nearbyMessages.set(key, { text, state });
  const target = nearbyTargets.get(key);
  if (target) {
    target.textContent = text;
    target.className = 'nearby-feedback ' + state;
  }
}
function registerNearby(key, container) {
  const note = document.createElement('p');
  note.setAttribute('aria-live', 'polite');
  nearbyTargets.set(key, note);
  container.append(note);
  const saved = nearbyMessages.get(key);
  if (saved) nearbyMessage(key, saved.text, saved.state);
  else note.className = 'nearby-feedback';
}
function runNear(key, action) {
  return run(async () => {
    nearbyActive = key;
    nearbyMessage(key, '正在处理…', 'loading');
    try {
      const result = await action();
      if (result?.inputs) {
        nearbyMessage(key, '请在当前行下方填写并保存。');
        return;
      }
      const text = nearbyMessages.get(key)?.text || '';
      if (text === '正在处理…' || /^已加载 .* 个凭证|API 密钥列表已加载|节点列表已加载/.test(text))
        nearbyMessage(key, '操作已完成。');
    } catch (error) {
      nearbyMessage(key, error.message, 'error');
      throw error;
    } finally {
      nearbyActive = null;
    }
  });
}
function parkNearby(id) {
  const panel = el(id),
    home = el(id + 'Home');
  if (panel && home) home.append(panel);
}
function nearbyCell(row, key, columns, title, onClose) {
  const old = el('nearby-' + key);
  old?.remove?.();
  const detail = document.createElement('tr');
  detail.id = 'nearby-' + key;
  detail.className = 'nearby-detail';
  const cell = document.createElement('td');
  cell.colSpan = columns;
  const head = document.createElement('div');
  head.className = 'nearby-heading';
  const label = document.createElement('strong');
  label.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'secondary';
  close.textContent = '收起';
  close.onclick = () => {
    onClose?.();
    detail.remove();
  };
  head.append(label, close);
  cell.append(head);
  detail.append(cell);
  row.parentNode?.insertBefore(detail, row.nextSibling);
  return { cell, detail };
}
function mountNearby(row, id, columns, title) {
  parkNearby(id);
  const view = nearbyCell(row, id, columns, title, () => {
    parkNearby(id);
    el(id).hidden = true;
  });
  view.cell.append(el(id));
  el(id).hidden = false;
  return view;
}
function nearbyEditor(row, key, columns, title, fields, save, onClose) {
  const view = nearbyCell(row, 'edit-' + key, columns, title, onClose),
    form = document.createElement('form');
  form.className = 'nearby-form';
  const inputs = {};
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = document.createElement('input');
    input.type = field.type || 'text';
    input.value = field.value ?? '';
    input.name = field.name;
    for (const attribute of ['min', 'max', 'minLength', 'maxLength', 'required', 'placeholder'])
      if (field[attribute] != null) input[attribute] = field[attribute];
    if (input.type === 'password') {
      input.autocomplete = 'off';
      input.spellcheck = false;
    }
    label.append(input);
    form.append(label);
    inputs[field.name] = input;
  }
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = '保存';
  form.append(submit);
  view.cell.append(form);
  form.onsubmit = (event) => {
    event.preventDefault();
    return runNear(key, async () => {
      await save(inputs);
      onClose?.();
      view.detail.remove();
    });
  };
  Object.values(inputs)[0]?.focus?.();
  return { ...view, inputs };
}
function clearNearby() {
  nearbyActive = null;
  nearbyMessages.clear();
  nearbyTargets.clear();
}
`;
