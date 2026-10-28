// Fold model aliases once per account. Shared model aliases remain in their family.
// A reset timestamp alone cannot identify a five-hour or weekly quota window.
export function groupQuotaModels(models, mode = 'antigravity') {
  const groups = new Map();
  for (const model of models || []) {
    const family = /^gemini(?:-|$)/i.test(model.id)
      ? 'Gemini'
      : /^claude(?:-|$)/i.test(model.id)
        ? 'Claude'
        : null;
    if (!family) {
      groups.set(JSON.stringify(['raw', model.id, model.bucketIndex]), { ...model });
      continue;
    }
    const key = JSON.stringify([family]);
    if (!groups.has(key))
      groups.set(key, {
        id: family,
        family,
        remaining: null,
        resetTime: null,
        tokenType: model.tokenType || null,
        members: [],
        inconsistent: false,
      });
    const group = groups.get(key);
    group.members.push(model);
  }
  return [...groups.values()].map((group) => {
    if (!group.members) return group;
    const known = group.members.filter((model) => model.remaining != null);
    group.remaining = known.length ? Math.min(...known.map((model) => model.remaining)) : null;
    const resets = group.members.map((model) => model.resetTime).filter(Boolean);
    group.resetTime = resets.length
      ? resets.sort((a, b) => Date.parse(b) - Date.parse(a))[0]
      : null;
    group.inconsistent =
      new Set(known.map((model) => model.remaining)).size > 1 || new Set(resets).size > 1;
    // Preserve explicit quantities only for a single reported bucket.
    if (group.members.length === 1) group.remainingAmount = group.members[0].remainingAmount;
    return group;
  });
}
