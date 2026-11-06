// Official groups and explicit windows define quota identity, never model families.
// Legacy cached model rows remain separate; equal percentages do not prove shared quotas.
export function groupQuotaModels(models, mode = 'antigravity') {
  const windowName = (value) => {
    const key = String(value || '').toLowerCase();
    if (key === 'weekly') return '周额度';
    if (['5h', 'five_hour', 'five_hours', 'five-hour', 'five-hours'].includes(key))
      return '5 小时额度';
    return value || '窗口未提供';
  };
  return (models || []).map((model) => ({
    ...model,
    id: model.quotaGroup ? model.quotaGroup + ' · ' + windowName(model.window) : model.id,
  }));
}
