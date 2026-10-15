import { handleRequest } from '../src/index.js';

export default {
  async fetch(request, env) {
    const scenario = request.headers.get('x-test-scenario');
    const fetcher = async (url) => {
      if (scenario === 'oauth-network-failure' && url.endsWith('/token'))
        throw new TypeError('fetch failed: secret-do-not-log');
      if (scenario === 'generation-network-failure')
        throw new TypeError('fetch failed: secret-do-not-log');
      if (url.endsWith('/token'))
        return Response.json({ access_token: 'refreshed-test-token', expires_in: 3600 });
      if (url.includes('fetchAvailableModels'))
        return Response.json({
          models: { 'test-model': { quotaInfo: { remainingFraction: 0.8 } } },
        });
      return Response.json({
        response: {
          candidates: [{ content: { parts: [{ text: 'runtime works' }] }, finishReason: 'STOP' }],
        },
      });
    };
    return handleRequest(
      request,
      { ...env, API_PASSWORD: 'local-api', PANEL_PASSWORD: 'local-panel' },
      fetcher,
    );
  },
};
