import { listCredentials } from './index.js';
export async function duplicateCredentials(db, env = {}) {
  const rows = await listCredentials(db, env);
  const groups = new Map();
  let unknown = 0;
  for (const row of rows) {
    const email = typeof row.user_email === 'string' ? row.user_email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) {
      unknown++;
      continue;
    }
    const key = row.mode + '\0' + email;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const duplicates = [];
  for (const items of groups.values()) {
    if (items.length < 2) continue;
    items.sort(
      (a, b) =>
        Number(a.disabled) - Number(b.disabled) ||
        Number(!!b.last_test?.success) - Number(!!a.last_test?.success) ||
        b.last_used - a.last_used ||
        b.created_at - a.created_at ||
        a.id.localeCompare(b.id),
    );
    duplicates.push({
      email: items[0].user_email,
      mode: items[0].mode,
      keep: items[0],
      duplicates: items.slice(1),
    });
  }
  return { groups: duplicates, unknown_email_count: unknown };
}
