export const logsScript = String.raw`let nextCall = null;
async function loadCalls(before = null) {
  const params = panelFilters('calls');
  if (before) params.set('before', before);
  if (el('callsCredential').value) params.set('credential_id', el('callsCredential').value);
  const value = await api('/admin/calls?' + params);
  el('callsBody').replaceChildren();
  nextCall = value.next;
  el('callsNext').hidden = !nextCall;
  for (const record of value.records) {
    const tr = document.createElement('tr');
    for (const text of [
      formatReset(record.created_at),
      (record.display_name || record.credential_name) +
        (record.credential_email && record.credential_name !== record.credential_email
          ? '\n' + record.credential_name
          : '') +
        '\n' +
        record.mode,
      record.model,
      record.status + '\n' + record.stage + (record.detail_code ? '\n' + record.detail_code : ''),
      record.duration_ms + ' ms',
      record.request_id,
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    el('callsBody').append(tr);
  }
  status(
    value.records.length ? '已加载 ' + value.records.length + ' 条调用记录。' : '暂无调用记录。',
  );
}
el('callsRefresh').onclick = () => run(() => loadCalls());
el('callsNext').onclick = () => run(() => loadCalls(nextCall));
el('callsCredential').onchange = () => {
  nextCall = null;
  el('callsNext').hidden = true;
  el('callsBody').replaceChildren();
};
`;
