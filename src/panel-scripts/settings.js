export const settingsScript = String.raw`function fillSettings(value) {
  el('settingsStorage').value = value.effective.USAGE_STORAGE_MODE || 'aggregate';
  el('settingsStrategy').value = value.effective.CREDENTIAL_SELECTION;
  el('settingsAttempts').value = value.effective.MAX_CREDENTIAL_ATTEMPTS;
  el('settingsHeaderTimeout').value = value.effective.UPSTREAM_TIMEOUT_SECONDS ?? 45;
  el('settingsRequestTimeout').value = value.effective.REQUEST_TIMEOUT_SECONDS ?? 100;
  el('settingsCollect').checked = value.effective.ANTIGRAVITY_STREAM2NOSTREAM;
  settingsLoaded = true;
}
el('settingsLoad').onclick = () =>
  run(async () => {
    fillSettings(await api('/admin/settings'));
    status('已加载当前生效配置。');
  });
el('settingsForm').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    if (!settingsLoaded) throw new Error('请先加载当前配置。');
    fillSettings(
      await api('/admin/settings', 'PATCH', {
        USAGE_STORAGE_MODE: el('settingsStorage').value,
        CREDENTIAL_SELECTION: el('settingsStrategy').value,
        ANTIGRAVITY_STREAM2NOSTREAM: el('settingsCollect').checked,
        MAX_CREDENTIAL_ATTEMPTS: Number(el('settingsAttempts').value),
        UPSTREAM_TIMEOUT_SECONDS: Number(el('settingsHeaderTimeout').value),
        REQUEST_TIMEOUT_SECONDS: Number(el('settingsRequestTimeout').value),
      }),
    );
    status('配置已保存，新的调用立即生效。');
  });
};
el('settingsReset').onclick = () =>
  run(async () => {
    fillSettings(
      await api('/admin/settings', 'PATCH', {
        USAGE_STORAGE_MODE: null,
        CREDENTIAL_SELECTION: null,
        ANTIGRAVITY_STREAM2NOSTREAM: null,
        MAX_CREDENTIAL_ATTEMPTS: null,
        UPSTREAM_TIMEOUT_SECONDS: null,
        REQUEST_TIMEOUT_SECONDS: null,
      }),
    );
    status('已恢复使用 vars 中的配置。');
  });
`;
