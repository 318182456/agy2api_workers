export const quotaScript = String.raw`let quotaOverviewResults = [];
let stopQuotaOverview = false;
el('quotaOverviewStop').onclick = () => {
  stopQuotaOverview = true;
  status('将停止后续额度查询，当前账号查询完成后停止。');
};
el('quotaOverviewRefresh').onclick = () =>
  run(async () => {
    await refresh();
    const rows = credentialsSnapshot.filter(
      (c) =>
        ['antigravity', 'geminicli'].includes(c.mode) &&
        (!c.disabled || el('quotaIncludeDisabled').checked),
    );
    quotaOverviewResults = [];
    quotaModelPage = 0;
    quotaAccountPage = 0;
    stopQuotaOverview = false;
    renderQuotaOverview();
    el('quotaOverviewStop').hidden = false;
    el('quotaOverviewStop').disabled = false;
    try {
      for (const credential of rows) {
        if (stopQuotaOverview) break;
        el('quotaOverviewState').textContent =
          '查询中 ' +
          (quotaOverviewResults.length + 1) +
          ' / ' +
          rows.length +
          ' · ' +
          (credential.user_email || credential.name);
        try {
          quotaOverviewResults.push({
            credential,
            value: await api('/admin/credentials/' + credential.id + '/quota'),
          });
        } catch (error) {
          quotaOverviewResults.push({ credential, error: error.message });
        }
        renderQuotaOverview();
      }
      const failed = quotaOverviewResults.filter((r) => r.error).length;
      el('quotaOverviewState').textContent =
        (stopQuotaOverview ? '已停止。' : '查询完成。') +
        '已查 ' +
        quotaOverviewResults.length +
        ' / ' +
        rows.length +
        '，失败 ' +
        failed +
        '。失败账号、未查询账号和未返回该模型的账号不参与该模型平均值。';
      status('额度总览已更新。');
    } finally {
      el('quotaOverviewStop').hidden = true;
    }
  });
`;
