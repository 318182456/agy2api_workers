export const sessionScript = String.raw`el('loginForm').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    const password = el('password').value;
    await api('/auth/login', 'POST', { password });
    el('password').value = '';
    await openWorkspace();
  });
};
el('logout').onclick = () =>
  run(async () => {
    await api('/auth/logout', 'POST');
    el('workspace').hidden = true;
    el('loginCard').hidden = false;
    el('credentials').replaceChildren();
    el('credential').value = '';
    el('file').value = '';
    resetKeys();
    runtimeProbe = null;
    updateRuntimeRegion({});
    selectedCredentials.clear();
    credentialsSnapshot = [];
    credentialsLoaded = false;
    renderEndpoints();
    loadedPages.clear();
    credentialPage = 0;
    duplicateSnapshot = [];
    settingsLoaded = false;
    quotaOverviewResults = [];
    el('quotaSummary').replaceChildren();
    el('quotaOverviewBody').replaceChildren();
    el('quotaOverviewState').textContent = '';
    for (const id of [
      'quotaKpis',
      'statsTrend',
      'statsModelRank',
      'statsAccountRank',
      'statsKeyRank',
      'statsCoverage',
    ])
      el(id).replaceChildren();
    statsSnapshot = { days: [], models: [], credentials: [], api_keys: [] };
    statsKeyNames.clear();
    el('statsApiKey').value = '';
    oauthClientModes = {};
    el('healthDetails').textContent = '';
    el('statsSummary').replaceChildren();
    for (const id of ['statsDays', 'statsModels', 'statsCredentials', 'statsApiKeys'])
      el(id).replaceChildren();
    el('batchFiles').value = '';
    el('batchResults').textContent = '';
    el('duplicateResults').textContent = '';
    el('callsBody').replaceChildren();
    el('callbackUrl').value = '';
    el('oauthLink').removeAttribute('href');
    el('oauthLinkArea').hidden = true;
    status('已退出。');
  });
el('refresh').onclick = () => run(refresh);
`;
