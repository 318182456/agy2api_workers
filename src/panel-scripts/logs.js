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
      record.status +
        '\n' +
        (record.status < 400 && record.retried ? '重试后成功' : record.stage) +
        (record.detail_code ? '\n' + record.detail_code : ''),
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
    value.records.length
      ? '已加载 ' +
          value.records.length +
          (el('callsScope').value === 'all' ? ' 条已保留事件。' : ' 条问题相关事件。')
      : '暂无匹配的问题记录；正常成功请求请查看用量统计。',
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
