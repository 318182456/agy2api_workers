import { nearbyScript } from './scripts/nearby.js';
import { storageScript } from './scripts/storage.js';
import { panelStyle } from './style.js';
import { panelFrame } from './views.js';
export { isPanelPath } from './views.js';
import { navigationScript } from './scripts/navigation.js';
import { credentialsScript } from './scripts/credentials.js';
import { sessionScript } from './scripts/session.js';
import { logsScript } from './scripts/logs.js';
import { batchScript } from './scripts/batch.js';
import { settingsScript } from './scripts/settings.js';
import { statisticsScript } from './scripts/statistics.js';
import { quotaScript } from './scripts/quota.js';
import { modelsScript } from './scripts/models.js';
import { oauthScript } from './scripts/oauth.js';
import { importScript } from './scripts/import.js';
import { keysScript } from './scripts/keys.js';
import { endpointsScript } from './scripts/endpoints.js';
import { bootstrapScript } from './scripts/bootstrap.js';

export const panel = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AGY2API Workers</title><link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=1"><meta name="theme-color" content="#4263e9"><style>${panelStyle}</style></head><body>
${panelFrame}
<script>
${nearbyScript}
${navigationScript}
${credentialsScript}
${sessionScript}
${logsScript}
${batchScript}
${settingsScript}
${statisticsScript}
${quotaScript}
${modelsScript}
${oauthScript}
${importScript}
${keysScript}
${endpointsScript}
${storageScript}
${bootstrapScript}
</script></body></html>`;
