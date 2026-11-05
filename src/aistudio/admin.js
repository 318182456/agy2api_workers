import { publicAistudio, saveAistudio, probeAistudio } from './config.js';
import { protectedAdmin, panelCsrf } from '../routes/protected.js';
import { json, readJson } from '../core/common.js';
export const aistudioAdminEntries = [
  {
    path: '/admin/aistudio',
    method: 'GET',
    access: 'protected-read',
    handle: async (request, env) =>
      json({
        ...(await publicAistudio(env)),
        csrf_token: await panelCsrf(request, env.PANEL_PASSWORD),
      }),
  },
  {
    path: '/admin/aistudio',
    method: 'PATCH',
    access: 'protected-browser-mutation',
    handle: async (request, env) => json(await saveAistudio(env, await readJson(request))),
  },
  {
    path: '/admin/aistudio/test',
    method: 'POST',
    access: 'protected-browser-mutation',
    handle: async (request, env, fetcher) => {
      await readJson(request);
      return json(await probeAistudio(env, fetcher, true));
    },
  },
];
export const aistudioAdminRoute = protectedAdmin(aistudioAdminEntries);
