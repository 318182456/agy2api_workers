import { HttpError, json } from './common.js';
import { importCredential, detectedMode } from './credentials.js';
import { readBytes, readZip, writeZip } from './zip.js';
export async function importArchive(request, env, mode) {
  if (!['geminicli', 'antigravity'].includes(mode)) throw new HttpError(400, '请选择默认渠道');
  const files = await readZip(await readBytes(request.body));
  const entries = files.map((file) => {
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.data));
    } catch {
      throw new HttpError(400, 'ZIP 内存在无效 JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new HttpError(400, 'ZIP JSON 必须为凭证对象');
    if (
      value.format === 'gcli2api-workers-credential-v1' &&
      (!value.entry || typeof value.entry !== 'object' || Array.isArray(value.entry))
    )
      throw new HttpError(400, 'ZIP 备份条目无效');
    return value?.format === 'gcli2api-workers-credential-v1'
      ? value.entry
      : {
          name: file.name.split('/').at(-1),
          mode: detectedMode(value, env) || mode,
          credential: value,
        };
  });
  const results = [];
  for (const entry of entries)
    try {
      await importCredential(env.DB, entry, env);
      results.push({ name: entry.name, success: true });
    } catch (error) {
      results.push({ name: entry?.name || '未知', success: false, status: error.status || 500 });
    }
  return json({
    results,
    imported: results.filter((row) => row.success).length,
    total: results.length,
  });
}
export async function exportArchive(env, ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
  )
    throw new HttpError(400, '请选择 1–100 个凭证');
  const rows = (
    await env.DB.prepare('SELECT * FROM credentials WHERE id IN(SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .all()
  ).results;
  if (rows.length !== new Set(ids).size) throw new HttpError(404, '部分凭证不存在，请刷新列表');
  const zip = writeZip(
    rows.map((row) => ({
      name: row.mode + '/' + row.id + '.json',
      data: JSON.stringify({
        format: 'gcli2api-workers-credential-v1',
        entry: {
          name: row.name,
          mode: row.mode,
          disabled: !!row.disabled,
          priority: row.priority ?? 0,
          weight: row.weight ?? 1,
          credential: JSON.parse(row.data),
        },
      }),
    })),
  );
  return new Response(zip, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="gcli2api-credentials.zip"',
      'cache-control': 'no-store',
    },
  });
}
