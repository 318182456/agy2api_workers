import { HttpError } from './common.js';
import { accountRequest, googleJson, saveData } from './account.js';
export async function configurePreview(env, row, fetcher) {
  if (row.mode !== 'geminicli') throw new HttpError(400, 'Preview 通道仅支持 GeminiCLI');
  const project = row.data.project_id;
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project))
    throw new HttpError(400, '请先校验有效的 Cloud 项目 ID');
  const parent = 'projects/' + project + '/locations/global';
  const root = 'https://cloudaicompanion.googleapis.com/v1/' + parent + '/releaseChannelSettings';
  const expected = parent + '/releaseChannelSettings/';
  const list = await googleJson(
    await accountRequest(env, row, root, undefined, 'preview_configure', fetcher),
    '查询 Preview 通道',
  );
  let setting = (list.releaseChannelSettings || []).find(
    (value) => value.releaseChannel === 'EXPERIMENTAL' || value.release_channel === 'EXPERIMENTAL',
  );
  if (!setting) {
    const created = await accountRequest(
      env,
      row,
      root + '?releaseChannelSettingId=gcli2api-preview',
      { releaseChannel: 'EXPERIMENTAL' },
      'preview_configure',
      fetcher,
    );
    if (created.status === 409) {
      await created.body?.cancel();
      const found = await googleJson(
        await accountRequest(env, row, root, undefined, 'preview_configure', fetcher),
        '查询已有 Preview 通道',
      );
      setting = (found.releaseChannelSettings || []).find(
        (value) => value.releaseChannel === 'EXPERIMENTAL',
      );
    } else setting = await googleJson(created, '创建 Preview 通道');
  }
  if (
    typeof setting?.name !== 'string' ||
    !setting.name.startsWith(expected) ||
    !/^[A-Za-z0-9_-]+$/.test(setting.name.slice(expected.length))
  )
    throw new HttpError(502, 'Google 未返回有效 Preview 设置，不能继续创建绑定');
  const bindings =
    'https://cloudaicompanion.googleapis.com/v1/' + setting.name + '/settingBindings';
  const existing = await googleJson(
    await accountRequest(env, row, bindings, undefined, 'preview_configure', fetcher),
    '查询 Preview 绑定',
  );
  const target = 'projects/' + project;
  if (
    !(existing.settingBindings || []).some(
      (binding) => binding.target === target && binding.product === 'GEMINI_CODE_ASSIST',
    )
  ) {
    const response = await accountRequest(
      env,
      row,
      bindings + '?settingBindingId=gcli2api-code-assist',
      { target, product: 'GEMINI_CODE_ASSIST' },
      'preview_configure',
      fetcher,
    );
    if (response.status === 409) {
      await response.body?.cancel();
      const found = await googleJson(
        await accountRequest(env, row, bindings, undefined, 'preview_configure', fetcher),
        '确认已有 Preview 绑定',
      );
      if (
        !(found.settingBindings || []).some(
          (binding) => binding.target === target && binding.product === 'GEMINI_CODE_ASSIST',
        )
      )
        throw new HttpError(409, '绑定名称已被其他设置占用，请在 Google Cloud 检查');
    } else await googleJson(response, '创建 Preview 绑定');
  }
  if (row.data.preview_channel !== 'EXPERIMENTAL')
    await saveData(env.DB, row, { preview_channel: 'EXPERIMENTAL' });
  return { success: true, project_id: project, release_channel: 'EXPERIMENTAL' };
}
