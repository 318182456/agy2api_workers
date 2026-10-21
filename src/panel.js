import { storageScript } from './panel-scripts/storage.js';
import { panelStyle } from './panel-style.js';
import { panelFrame } from './panel-views.js';
export { isPanelPath } from './panel-views.js';
import { navigationScript } from './panel-scripts/navigation.js';
import { credentialsScript } from './panel-scripts/credentials.js';
import { sessionScript } from './panel-scripts/session.js';
import { logsScript } from './panel-scripts/logs.js';
import { batchScript } from './panel-scripts/batch.js';
import { settingsScript } from './panel-scripts/settings.js';
import { statisticsScript } from './panel-scripts/statistics.js';
import { quotaScript } from './panel-scripts/quota.js';
import { modelsScript } from './panel-scripts/models.js';
import { oauthScript } from './panel-scripts/oauth.js';
import { importScript } from './panel-scripts/import.js';
import { keysScript } from './panel-scripts/keys.js';
import { endpointsScript } from './panel-scripts/endpoints.js';
import { bootstrapScript } from './panel-scripts/bootstrap.js';

export const panel = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GCLI2API Workers</title><link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=1"><meta name="theme-color" content="#4263e9"><style>${panelStyle}</style></head><body>
${panelFrame}
<script>
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
