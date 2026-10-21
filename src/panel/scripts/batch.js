export const batchScript = String.raw`function updateSelection() {
  el('selectionCount').textContent = '已选 ' + selectedCredentials.size + ' 个（可跨页）';
  const visible = visibleCredentials();
  const count = visible.filter((c) => selectedCredentials.has(c.id)).length;
  el('selectAll').checked = !!visible.length && count === visible.length;
  el('selectAll').indeterminate = count > 0 && count < visible.length;
  document.querySelectorAll('.credential-select').forEach((input) => {
    input.checked = selectedCredentials.has(input.dataset.id);
  });
}
el('selectAll').onchange = () => {
  for (const row of visibleCredentials()) {
    if (el('selectAll').checked) selectedCredentials.add(row.id);
    else selectedCredentials.delete(row.id);
  }
  el('batchPanel').open = selectedCredentials.size > 0;
  updateSelection();
};
el('batchStop').onclick = () => {
  stopBatch = true;
  status('将停止后续操作，正在进行的这一项会完成。');
};
function startBatch() {
  stopBatch = false;
  el('batchResults').textContent = '';
  el('batchStop').hidden = false;
  el('batchStop').disabled = false;
}
function batchLine(text) {
  el('batchResults').textContent += text + '\n';
}
function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  if (value.format === 'gcli2api-workers-credentials-v1' && blob.size > 4 * 1024 * 1024)
    throw new Error('备份超过 4 MiB，请减少选中项后分批导出。');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
el('batchRun').onclick = () => {
  const rows = credentialsSnapshot.filter((row) => selectedCredentials.has(row.id));
  if (!rows.length) {
    status('请先勾选凭证。');
    return;
  }
  const action = el('batchAction').value;
  if (action === 'exportZip')
    return run(async () => {
      if (rows.length > 100) throw new Error('ZIP 每次最多导出 100 个凭证');
      const blob = await api(
        '/admin/credentials/export.zip',
        'POST',
        { ids: rows.map((row) => row.id) },
        'blob',
      );
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = 'gcli2api-credentials.zip';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('ZIP 已导出。');
    });
  if (action === 'export' && rows.length > 1000) {
    status('单份备份最多 1000 个凭证，请分批导出。');
    return;
  }
  if (action === 'delete' && !confirm('确认删除选中的 ' + rows.length + ' 个凭证？')) return;
  if (action === 'test' && !confirm('将逐个发起最小聊天请求，会消耗额度，继续？')) return;
  return run(async () => {
    startBatch();
    const exported = [];
    let success = 0;
    try {
      for (const row of rows) {
        if (stopBatch) break;
        const label = row.user_email || row.name;
        status('正在处理 ' + label);
        try {
          const root = '/admin/credentials/' + row.id;
          if (action === 'export')
            exported.push({
              name: row.name,
              mode: row.mode,
              disabled: !!row.disabled,
              priority: row.priority ?? 0,
              weight: row.weight ?? 1,
              credential: await api(root + '/download'),
            });
          else if (action === 'enable' || action === 'disable')
            await api(root, 'PATCH', { disabled: action === 'disable' });
          else if (action === 'delete') await api(root, 'DELETE');
          else if (action === 'cooldowns') await api(root + '/cooldowns', 'DELETE');
          else {
            const value = await api(root + '/' + action, 'POST', {});
            if (value.limited) {
              batchLine(label + '：当前限流');
              continue;
            }
          }
          success++;
          batchLine(label + '：完成');
        } catch (error) {
          batchLine(label + '：失败 — ' + error.message);
        }
      }
      if (action === 'export' && exported.length && !stopBatch)
        downloadJson(
          { format: 'gcli2api-workers-credentials-v1', credentials: exported },
          'gcli2api-credentials-' + Date.now() + '.json',
        );
      await refresh();
      status(
        (stopBatch ? '已停止后续操作。' : '批量操作完成。') +
          '成功 ' +
          success +
          '/' +
          rows.length +
          '，详情见批量结果。',
      );
    } finally {
      el('batchStop').hidden = true;
    }
  });
};
function inferMode(data) {
  return oauthClientModes[data?.client_id];
}
el('batchImportForm').onsubmit = (event) => {
  event.preventDefault();
  const files = Array.from(el('batchFiles').files);
  if (!files.length) return;
  return run(async () => {
    startBatch();
    let success = 0;
    let total = 0;
    try {
      for (const file of files) {
        if (stopBatch) break;
        let entries;
        try {
          if (file.size > 4 * 1024 * 1024) throw new Error('单个文件不能超过 4 MiB');
          if (file.name.toLowerCase().endsWith('.zip')) {
            const value = await api(
              '/admin/credentials/import.zip?mode=' + encodeURIComponent(el('batchMode').value),
              'POST',
              file,
            );
            total += value.total;
            success += value.imported;
            for (const row of value.results)
              batchLine(
                row.name + '：' + (row.success ? '导入完成' : '导入失败 (HTTP ' + row.status + ')'),
              );
            continue;
          }

          const value = JSON.parse(await file.text());
          entries =
            value.format === 'gcli2api-workers-credentials-v1' && Array.isArray(value.credentials)
              ? value.credentials
              : [{ name: file.name, credential: value }];
          if (entries.length > 1000) throw new Error('单份备份最多 1000 个凭证');
        } catch (error) {
          batchLine(file.name + '：读取失败 — ' + error.message);
          continue;
        }
        for (const entry of entries) {
          if (stopBatch) break;
          total++;
          try {
            if (!entry || typeof entry !== 'object') throw new Error('备份条目格式无效');
            const credential = entry.credential;
            const mode = entry.mode || inferMode(credential) || el('batchMode').value;
            await api('/admin/credentials', 'POST', {
              name: entry.name || file.name,
              mode,
              credential,
              ...(typeof entry.disabled === 'boolean' ? { disabled: entry.disabled } : {}),
              ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
              ...(entry.weight !== undefined ? { weight: entry.weight } : {}),
            });
            success++;
            batchLine((entry.name || file.name) + '：导入完成');
          } catch (error) {
            batchLine((entry?.name || file.name) + '：失败 — ' + error.message);
          }
        }
      }
      el('batchFiles').value = '';
      await refresh();
      showPage('credentials');
      loadedPages.add('credentials');
      status('导入成功 ' + success + '/' + total + '。详情见批量结果。');
    } finally {
      el('batchStop').hidden = true;
    }
  });
};
el('findDuplicates').onclick = () =>
  run(async () => {
    const value = await api('/admin/duplicates');
    duplicateSnapshot = value.groups;
    const lines = [
      '发现 ' +
        value.groups.length +
        ' 组重复，' +
        value.unknown_email_count +
        ' 个凭证没有邮箱，未参与查重。',
    ];
    for (const group of value.groups)
      lines.push(
        group.email +
          ' · ' +
          group.mode +
          '\n  建议保留：' +
          group.keep.name +
          '\n  重复项：' +
          group.duplicates.map((row) => row.name).join('、'),
      );
    el('duplicateResults').textContent = lines.join('\n');
    el('selectDuplicates').hidden = !value.groups.length;
    status('查重完成，未删除任何凭证。');
  });
el('selectDuplicates').onclick = () => {
  selectedCredentials.clear();
  for (const group of duplicateSnapshot)
    for (const row of group.duplicates)
      if (credentialsSnapshot.some((c) => c.id === row.id)) selectedCredentials.add(row.id);
  showPage('credentials');
  el('batchPanel').open = true;
  updateSelection();
  status('已选中建议清理的重复项，可在批量操作中停用或删除。');
};
`;
