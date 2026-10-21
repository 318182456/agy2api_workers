export const importScript = String.raw`function detectImportMode(credential) {
  const mode = inferMode(credential);
  if (mode) {
    el('mode').value = mode;
    status('已根据 client_id 识别渠道为 ' + mode + '。');
  }
}
el('credential').addEventListener('input', () => {
  try {
    detectImportMode(JSON.parse(el('credential').value));
  } catch {}
});
el('file').onchange = () =>
  run(async () => {
    const file = el('file').files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) throw new Error('文件不能超过 4 MiB');
    el('credential').value = await file.text();
    el('name').value = file.name;
    try {
      detectImportMode(JSON.parse(el('credential').value));
    } catch {
      throw new Error('JSON 格式错误');
    }
  });
el('importForm').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    let credential;
    try {
      credential = JSON.parse(el('credential').value);
    } catch {
      throw new Error('JSON 格式错误');
    }
    await api('/admin/credentials', 'POST', {
      name: el('name').value,
      mode: el('mode').value,
      credential,
    });
    el('credential').value = '';
    el('file').value = '';
    await refresh();
    showPage('credentials');
    loadedPages.add('credentials');
    status('导入成功。');
  });
};
`;
