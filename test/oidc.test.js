import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { handleRequest } from '../src/index.js';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
const env = {
  OIDC_ISSUER: 'https://auth.example.test',
  OIDC_CLIENT_ID: 'panel-client',
  OIDC_CLIENT_SECRET: 'fixture-client-secret',
  OIDC_REDIRECT_URI: 'https://app.example.test/auth/oidc/callback',
  OIDC_ALLOWED_USERS: 'admin',
  PANEL_PASSWORD: 'fixture-panel-secret',
  API_PASSWORD: 'fixture-api-secret',
};
const metadata = {
  issuer: env.OIDC_ISSUER,
  authorization_endpoint: env.OIDC_ISSUER + '/authorize',
  token_endpoint: env.OIDC_ISSUER + '/token',
  jwks_uri: env.OIDC_ISSUER + '/jwks',
  userinfo_endpoint: env.OIDC_ISSUER + '/userinfo',
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_post'],
};
const req = (path, headers = {}) => new Request('https://app.example.test' + path, { headers });
async function flow(overrides = {}) {
  let authorization,
    exchanges = 0;
  const fetcher = async (url, options) => {
    if (String(url).endsWith('/.well-known/openid-configuration'))
      return Response.json({ ...metadata, ...overrides.metadata });
    if (url === metadata.jwks_uri) return Response.json({ keys: [jwk] });
    if (url === metadata.token_endpoint) {
      exchanges++;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('client_secret'), env.OIDC_CLIENT_SECRET);
      assert.equal(form.get('redirect_uri'), env.OIDC_REDIRECT_URI);
      const challenge = Buffer.from(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier'))),
      ).toString('base64url');
      assert.equal(challenge, authorization.searchParams.get('code_challenge'));
      let jwt = new SignJWT({
        sub: 'subject-1',
        nonce: authorization.searchParams.get('nonce'),
        ...overrides.claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer(overrides.issuer || env.OIDC_ISSUER)
        .setAudience(overrides.audience || env.OIDC_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime(overrides.expired ? Math.floor(Date.now() / 1000) - 60 : '5m');
      return Response.json({
        id_token: overrides.badSignature ? 'invalid.token.value' : await jwt.sign(privateKey),
        access_token: 'fixture-access',
        token_type: 'Bearer',
      });
    }
    if (url === metadata.userinfo_endpoint)
      return Response.json({ sub: 'subject-1', preferred_username: 'admin', ...overrides.user });
    throw Error('Unexpected provider request');
  };
  const start = await handleRequest(
    req('/auth/oidc/start?returnTo=' + encodeURIComponent(overrides.returnTo || '/panel/settings')),
    env,
    fetcher,
  );
  authorization = new URL(start.headers.get('location'));
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const path =
    '/auth/oidc/callback?code=fixture-code&state=' + authorization.searchParams.get('state');
  return { start, authorization, cookie, path, fetcher, exchanges: () => exchanges };
}

test('OIDC code and PKCE establish an existing panel session without exposing provider tokens', async () => {
  const f = await flow();
  assert.equal(f.start.status, 303);
  assert.equal(f.authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.match(f.start.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.ok(!f.cookie.includes('fixture-client-secret'));
  const callback = await handleRequest(req(f.path, { cookie: f.cookie }), env, f.fetcher);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/panel/settings');
  const cookies = callback.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith('__Host-gcli_session=')).split(';')[0];
  assert.ok(cookies.some((c) => c.includes('__Host-gcli_oidc=;') && c.includes('Max-Age=0')));
  const state = await handleRequest(req('/auth/session', { cookie: session }), env);
  assert.equal((await state.json()).authenticated, true);
  assert.equal((await handleRequest(req('/panel/settings', { cookie: session }), env)).status, 200);
  assert.equal(
    (
      await handleRequest(
        req('/admin/settings', { cookie: session, authorization: 'Bearer wrong' }),
        env,
      )
    ).status,
    401,
  );
  assert.equal((await handleRequest(req('/v1/models', { cookie: session }), env)).status, 401);
});

test('OIDC rejects missing, forged and duplicate state before exchanging credentials', async () => {
  const f = await flow();
  for (const [path, cookie] of [
    [f.path, ''],
    [f.path.replace(/state=.*/, 'state=forged'), f.cookie],
    [f.path + '&state=duplicate', f.cookie],
    [f.path, f.cookie.replace(/\.([A-Za-z0-9_-])/, (_, c) => '.' + (c === 'A' ? 'B' : 'A'))],
  ]) {
    assert.equal((await handleRequest(req(path, { cookie }), env, f.fetcher)).status, 401);
  }
  assert.equal(f.exchanges(), 0);
});

test('OIDC validates signature, issuer, audience, nonce, expiry and authorized party', async () => {
  for (const overrides of [
    { badSignature: true },
    { issuer: 'https://wrong.test' },
    { audience: 'other-client' },
    { claims: { nonce: 'wrong' } },
    { expired: true },
    { claims: { azp: 'other-client' } },
  ]) {
    const f = await flow(overrides);
    assert.equal(
      (await handleRequest(req(f.path, { cookie: f.cookie }), env, f.fetcher)).status,
      401,
    );
  }
});

test('OIDC checks userinfo identity and restricts administrators to the configured allowlist', async () => {
  for (const user of [{ sub: 'other-user' }, { preferred_username: 'untrusted' }]) {
    const f = await flow({ user });
    assert.equal(
      (await handleRequest(req(f.path, { cookie: f.cookie }), env, f.fetcher)).status,
      403,
    );
  }
});

test('OIDC rejects untrusted metadata and prevents redirecting users off site', async () => {
  const response = await handleRequest(req('/auth/oidc/start'), env, async () =>
    Response.json({ ...metadata, token_endpoint: 'https://evil.test/token' }),
  );
  assert.equal(response.status, 401);
  const f = await flow({ returnTo: '//evil.test' });
  const callback = await handleRequest(req(f.path, { cookie: f.cookie }), env, f.fetcher);
  assert.equal(callback.headers.get('location'), '/panel/overview');
});

test('OIDC auto login, password recovery and disabled-provider behavior remain separate from APIs', async () => {
  assert.equal((await handleRequest(req('/panel/overview'), env)).status, 303);
  assert.equal((await handleRequest(req('/panel/overview?login=local'), env)).status, 200);
  assert.equal(
    (await handleRequest(req('/auth/oidc/start'), { ...env, OIDC_ALLOWED_USERS: '' })).status,
    503,
  );
  assert.equal(
    (await handleRequest(req('/auth/oidc/start'), { ...env, OIDC_ISSUER: '' })).status,
    404,
  );
  assert.equal(
    (await handleRequest(new Request('https://other.test/auth/oidc/start'), env)).status,
    503,
  );
  assert.equal((await handleRequest(req('/v1/models'), env)).status, 401);
});
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

test('real Workers runtime performs discovery, PKCE and signed-token login without redirect-mode incompatibility', async () => {
  const bundle = await build({
    entryPoints: ['src/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  let authorization;
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-09-01',
    compatibilityFlags: ['enable_request_signal', 'global_fetch_strictly_public'],
    bindings: env,
    log: new Log(LogLevel.NONE),
    outboundService: async (request) => {
      if (request.url.endsWith('/.well-known/openid-configuration')) return Response.json(metadata);
      if (request.url === metadata.jwks_uri) return Response.json({ keys: [jwk] });
      if (request.url === metadata.userinfo_endpoint)
        return Response.json({ sub: 'runtime-subject', preferred_username: 'admin' });
      if (request.url === metadata.token_endpoint) {
        const form = new URLSearchParams(await request.text());
        const digest = Buffer.from(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(form.get('code_verifier')),
          ),
        ).toString('base64url');
        assert.equal(digest, authorization.searchParams.get('code_challenge'));
        const id_token = await new SignJWT({ nonce: authorization.searchParams.get('nonce') })
          .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
          .setSubject('runtime-subject')
          .setIssuer(env.OIDC_ISSUER)
          .setAudience(env.OIDC_CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return Response.json({ id_token, access_token: 'runtime-fixture', token_type: 'Bearer' });
      }
      throw Error('Unexpected runtime provider request');
    },
  });
  try {
    const start = await mf.dispatchFetch('https://app.example.test/auth/oidc/start', {
      redirect: 'manual',
    });
    assert.equal(start.status, 303);
    authorization = new URL(start.headers.get('location'));
    const pending = start.headers.get('set-cookie').split(';')[0];
    const callback = await mf.dispatchFetch(
      'https://app.example.test/auth/oidc/callback?code=fixture&state=' +
        authorization.searchParams.get('state'),
      { headers: { cookie: pending }, redirect: 'manual' },
    );
    assert.equal(callback.status, 303);
    const session = callback.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-gcli_session='))
      .split(';')[0];
    const status = await mf.dispatchFetch('https://app.example.test/auth/session', {
      headers: { cookie: session },
    });
    assert.equal((await status.json()).authenticated, true);
  } finally {
    await mf.dispose();
  }
});
