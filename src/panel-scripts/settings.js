export const settingsScript = String.raw`function fillSettings(value) {
  el('settingsStorage').value = value.effective.USAGE_STORAGE_MODE || 'aggregate';
  el('settingsStrategy').value = value.effective.CREDENTIAL_SELECTION;
  el('settingsAttempts').value = value.effective.MAX_CREDENTIAL_ATTEMPTS;
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
      }),
    );
    status('已恢复使用 vars 中的配置。');
  });
`;
