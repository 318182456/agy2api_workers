export const endpointsScript = String.raw`const endpointTargets = [
  ['openaiUrl', 'antigravity', '/v1'],
  ['geminiUrl', 'antigravity', ''],
  ['anthropicUrl', 'antigravity', ''],
];
function renderEndpoints() {
  for (const [id, mode, path] of endpointTargets) {
    const available = credentialsSnapshot.some(
      (row) => (mode === 'auto' || row.mode === mode) && !row.disabled,
    );
    el(id).textContent = location.origin + path;
    el('endpoint-' + id).className = 'endpoint' + (available ? '' : ' endpoint-disabled');
    el('copy-' + id).disabled = !available;
    el('endpoint-' + id).title = available
      ? '已有启用凭证，请使用账号可用的模型'
      : '暂无启用的 ' + 'Antigravity' + ' 凭证';
  }
  {
    const mode = 'antigravity';
    const count = credentialsSnapshot.filter(
      (row) => (mode === 'auto' || row.mode === mode) && !row.disabled,
    ).length;
    const state = el('endpoint-group-state-' + mode);
    state.textContent = !credentialsLoaded
      ? '正在检查凭证…'
      : count
        ? count + ' 个启用凭证'
        : '暂无启用凭证';
    state.className = 'pill ' + (count ? 'healthy' : 'unknown');
    el('endpoint-group-' + mode).className = 'endpoint-group' + (count ? '' : ' is-unavailable');
  }
}
el('endpointsRefresh').onclick = () =>
  run(async () => {
    await refresh();
    status('接口可用状态已刷新。');
  });
`;
