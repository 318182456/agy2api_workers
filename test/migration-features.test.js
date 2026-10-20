import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Response as UpstreamResponse, Log, LogLevel } from 'miniflare';
import { prepareClientTools, normalizeToolHistory } from '../src/tool-compat.js';
import { readZip, writeZip, crc32 } from '../src/zip.js';
import { fakeStream } from '../src/fake-stream.js';
import { readSettings, validateSetting } from '../src/settings.js';
globalThis.crypto ||= webcrypto;
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222',
  c = '33333333-3333-4333-8333-333333333333';

test('tool compatibility: reversible collision-free names, narrow type repair, preserved signed history and ordered parallel results', () => {
  const input = {
    tools: [
      {
        type: 'function',
        function: {
          name: '工具:search',
          parameters: {
            type: 'object',
            properties: {
              count: { type: 'integer' },
              flag: { type: 'boolean' },
              label: { type: 'string' },
              ratio: { type: 'number' },
            },
          },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: '工具:search' } },
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'one',
            function: {
              name: '工具:search',
              arguments: '{"count":"2","flag":"false","label":12,"ratio":"0.25"}',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'one', content: '{}' },
    ],
  };
  const prepared = prepareClientTools(input),
    name = prepared.body.tools[0].function.name;
  assert.match(name, /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
  assert.equal(prepared.names.get(name), '工具:search');
  assert.equal(prepared.body.tool_choice.function.name, name);
  assert.deepEqual(JSON.parse(prepared.body.messages[1].tool_calls[0].function.arguments), {
    count: 2,
    flag: false,
    label: '12',
    ratio: 0.25,
  });
  assert.equal(input.messages[1].tool_calls[0].function.name, '工具:search');
  input.messages[1].tool_calls[0].extra_content = { google: { thought_signature: 'signed' } };
  assert.equal(
    prepareClientTools(input).body.messages[1].tool_calls[0].function.arguments,
    input.messages[1].tool_calls[0].function.arguments,
  );
  const collision = prepareClientTools({
    ...input,
    tools: [...input.tools, { type: 'function', function: { name } }],
  });
  assert.notEqual(collision.body.tools[0].function.name, collision.body.tools[1].function.name);
  const ordered = normalizeToolHistory([
    {
      role: 'model',
      parts: [
        { functionCall: { id: 'a', name: 'f' }, thoughtSignature: 'keep' },
        { functionCall: { id: 'b', name: 'f' } },
      ],
    },
    {
      role: 'user',
      parts: [
        { text: 'after results' },
        { functionResponse: { id: 'b', name: 'f', response: {} } },
      ],
    },
    { role: 'user', parts: [{ functionResponse: { id: 'a', name: 'f', response: {} } }] },
  ]);
  assert.deepEqual(
    ordered[1].parts.slice(0, 2).map((part) => part.functionResponse.id),
    ['a', 'b'],
  );
  assert.equal(ordered[0].parts[0].thoughtSignature, 'keep');
  const reused = normalizeToolHistory([
    { role: 'model', parts: [{ functionCall: { id: 'step-local', name: 'f' } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'step-local', name: 'f', response: {} } }] },
    { role: 'model', parts: [{ functionCall: { id: 'step-local', name: 'f' } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'step-local', name: 'f', response: {} } }] },
  ]);
  assert.equal(reused.length, 4);
  assert.throws(
    () =>
      normalizeToolHistory([
        { role: 'user', parts: [{ functionResponse: { id: 'orphan', name: 'f' } }] },
      ]),
    { status: 400 },
  );
});

test('ZIP imports real Python deflate archives, verifies CRC/size/path limits and round trips backups', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const fixture = Uint8Array.from(
    Buffer.from(
      'UEsDBBQAAAAIAPlsVF1lhXE3KwAAADAAAAAJAAAAdGVzdC5qc29uq1YqKMrPSk0uic9MUbJSyslPTszRhQop6SiV5Gen5gHF0zIrSkqLUpVqAVBLAQIUABQAAAAIAPlsVF1lhXE3KwAAADAAAAAJAAAAAAAAAAAAAACAAQAAAAB0ZXN0Lmpzb25QSwUGAAAAAAEAAQA3AAAAUgAAAAAA',
      'base64',
    ),
  );
  const decoded = await readZip(fixture);
  assert.equal(decoded[0].name, 'test.json');
  assert.equal(JSON.parse(new TextDecoder().decode(decoded[0].data)).project_id, 'local-project');
  const own = writeZip([{ name: 'geminicli/credential.json', data: '{"local":true}' }]);
  assert.equal((await readZip(own)).length, 1);
  const damaged = own.slice();
  damaged[30 + 'geminicli/credential.json'.length] ^= 1;
  await assert.rejects(readZip(damaged), { status: 400 });
  for (const name of ['../secret.json', '/absolute.json', 'C:/root.json', 'a\\b.json'])
    assert.throws(() => writeZip([{ name, data: '{}' }]), { status: 400 });
  await assert.rejects(readZip(writeZip([{ name: 'readme.txt', data: 'x' }])), { status: 400 });
  assert.throws(
    () => writeZip(Array.from({ length: 101 }, (_, i) => ({ name: i + '.json', data: '{}' }))),
    { status: 400 },
  );
});

test('migration switches default to no paid credits, no continuation and no fake stream; reset validation remains strict', async () => {
  const defaults = (await readSettings({})).effective;
  assert.equal(defaults.ENABLE_AI_CREDITS, false);
  assert.equal(defaults.FAKE_STREAMING, false);
  assert.equal(defaults.CONTINUATION_ATTEMPTS, 0);
  assert.equal(defaults.AUTO_DISABLE_INVALID_CREDENTIALS, true);
  for (const value of [-1, 3, '1'])
    assert.throws(() => validateSetting('CONTINUATION_ATTEMPTS', value), { status: 400 });
  assert.throws(() => validateSetting('ENABLE_AI_CREDITS', 'true'), { status: 400 });
});

test('fake transport emits a heartbeat immediately and cancels its sole in-flight request', async () => {
  let cancelled = false,
    started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const response = fakeStream(
    (signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(new Error('cancelled'));
          },
          { once: true },
        );
      }),
    'openai',
    'm',
  );
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /heartbeat/);
  await ready;
  await reader.cancel();
  assert.equal(cancelled, true);
});

test('production migration: names, sessions, hidden thoughts, optional credits, heartbeats, bounded continuation and one final usage record', async () => {
  const bundle = (
    await build({
      entryPoints: ['src/index.js'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    })
  ).outputFiles[0].text;
  const generationAuth = [];
  let scenario = 'text',
    generation = [],
    part = 0,
    setting = false,
    binding = false,
    previewPosts = 0;
  const mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate: '2025-09-01',
    compatibilityFlags: ['enable_request_signal'],
    bindings: {
      API_PASSWORD: 'fixture-api',
      PANEL_PASSWORD: 'fixture-panel',
      ANTIGRAVITY_STREAM2NOSTREAM: false,
    },
    d1Databases: { DB: 'migration-features' },
    log: new Log(LogLevel.NONE),
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === 'oauth2.googleapis.com')
        return new UpstreamResponse(
          JSON.stringify({
            error: scenario === 'invalid-client' ? 'invalid_client' : 'invalid_grant',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      if (url.hostname === 'cloudaicompanion.googleapis.com') {
        const base =
          'projects/local-project/locations/global/releaseChannelSettings/gcli2api-preview';
        if (scenario === 'preview-denied')
          return new UpstreamResponse('{}', {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        if (request.method === 'GET')
          return new UpstreamResponse(
            JSON.stringify(
              url.pathname.endsWith('/settingBindings')
                ? {
                    settingBindings: binding
                      ? [{ target: 'projects/local-project', product: 'GEMINI_CODE_ASSIST' }]
                      : [],
                  }
                : {
                    releaseChannelSettings: setting
                      ? [{ name: base, releaseChannel: 'EXPERIMENTAL' }]
                      : [],
                  },
            ),
            { headers: { 'content-type': 'application/json' } },
          );
        previewPosts++;
        const body = await request.json();
        if (url.pathname.endsWith('/settingBindings')) {
          binding = true;
          assert.equal(body.product, 'GEMINI_CODE_ASSIST');
          return new UpstreamResponse(
            JSON.stringify({ name: base + '/settingBindings/gcli2api-code-assist' }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        setting = true;
        assert.equal(body.releaseChannel, 'EXPERIMENTAL');
        return new UpstreamResponse(
          JSON.stringify({ name: base, releaseChannel: 'EXPERIMENTAL' }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      const body = await request.json();
      generation.push(body);
      generationAuth.push(request.headers.get('authorization'));
      let parts = [{ text: 'answer' }],
        finishReason = 'STOP';
      if (scenario === 'tool')
        parts = [
          {
            functionCall: {
              id: 'tool-call',
              name: body.request.tools[0].functionDeclarations[0].name,
              args: { count: 2 },
            },
            thoughtSignature: 'server-signature',
          },
        ];
      if (scenario === 'thinking')
        parts = [{ text: 'hidden thought', thought: true }, { text: 'visible answer' }];
      if (scenario === 'continue') {
        part++;
        parts = [{ text: part === 1 ? 'first ' : 'second' }];
        finishReason = part === 1 ? 'MAX_TOKENS' : 'STOP';
      }
      if (scenario === 'always-max') finishReason = 'MAX_TOKENS';
      if (scenario === 'tool-max') {
        parts = [{ functionCall: { id: 'stop-tool', name: 'f', args: {} } }];
        finishReason = 'MAX_TOKENS';
      }
      const value = {
        candidates: [
          {
            content: { role: 'model', parts },
            ...(scenario === 'incomplete' ? {} : { finishReason }),
          },
        ],
        usageMetadata: {
          promptTokenCount: 2,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 2,
          totalTokenCount: 7,
        },
      };
      return new UpstreamResponse(
        request.url.includes('streamGenerateContent')
          ? 'data: ' + JSON.stringify(value) + '\n\n'
          : JSON.stringify(value),
        {
          headers: {
            'content-type': request.url.includes('streamGenerateContent')
              ? 'text/event-stream'
              : 'application/json',
          },
        },
      );
    },
  });
  try {
    const DB = await mf.getD1Database('DB');
    for (const file of (await readdir('migrations')).filter((file) => file.endsWith('.sql')).sort())
      await DB.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
    const admin = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
      const response = await mf.dispatchFetch('https://test/admin/' + path, {
        method,
        headers: { authorization: 'Bearer fixture-panel', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const set = (patch) => admin('settings', patch, 'PATCH');
    await set({ CREDENTIAL_SELECTION: 'priority', MAX_CREDENTIAL_ATTEMPTS: 2 });
    for (const [id, mode, priority] of [
      [a, 'antigravity', 10],
      [b, 'geminicli', 10],
    ])
      await DB.prepare(
        'INSERT INTO credentials(id,mode,name,data,created_at,priority)VALUES(?,?,?,?,?,?)',
      )
        .bind(
          id,
          mode,
          mode,
          JSON.stringify({
            token: 'local-token',
            project_id: 'local-project',
            expiry: '2099-01-01T00:00:00Z',
          }),
          Date.now(),
          priority,
        )
        .run();
    await DB.prepare(
      'INSERT INTO credentials(id,mode,name,data,created_at,priority)VALUES(?,?,?,?,?,?)',
    )
      .bind(
        '44444444-4444-4444-8444-444444444444',
        'antigravity',
        'spare',
        JSON.stringify({
          token: 'spare-token',
          project_id: 'local-project',
          expiry: '2099-01-01T00:00:00Z',
        }),
        Date.now(),
        0,
      )
      .run();
    const chat = async (body = {}, mode = 'antigravity', path = '/v1/chat/completions') =>
      mf.dispatchFetch('https://test/' + mode + path, {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-api', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-3.1-flash-lite',
          messages: [{ role: 'user', content: 'same conversation' }],
          ...body,
        }),
      });
    scenario = 'tool';
    for (const stream of [false, true]) {
      const response = await chat({
        stream,
        tools: [
          {
            type: 'function',
            function: {
              name: '工具:search',
              parameters: { type: 'object', properties: { count: { type: 'integer' } } },
            },
          },
        ],
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.includes('工具:search'));
      assert.ok(text.includes('server-signature'));
      assert.match(generation.at(-1).request.tools[0].functionDeclarations[0].name, /^tool_/);
    }
    for (const stream of [false, true]) {
      const response = await chat(
        {
          max_tokens: 64,
          stream,
          tools: [
            {
              name: '工具:search',
              input_schema: { type: 'object', properties: { count: { type: 'integer' } } },
            },
          ],
          messages: [
            { role: 'user', content: 'search' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'history-call',
                  name: '工具:search',
                  input: { count: '2' },
                },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'history-call', content: '[]' }],
            },
          ],
        },
        'geminicli',
        '/v1/messages',
      );
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.includes('工具:search'));
      assert.ok(text.includes('server-signature'));
      const historyCall = generation
        .at(-1)
        .request.contents[1].parts.find((part) => part.functionCall);
      assert.equal(historyCall.thoughtSignature, 'skip_thought_signature_validator');
      assert.equal(historyCall.functionCall.args.count, 2);
    }
    scenario = 'text';
    generation = [];
    await (await chat()).text();
    await (await chat()).text();
    assert.equal(generation[0].request.sessionId, generation[1].request.sessionId);
    assert.equal(generation[0].request.labels.trajectory_id, generation[0].request.sessionId);
    assert.equal(generation[0].enabledCreditTypes, undefined);
    await admin('credentials/' + a + '/credits', { enabled: true });
    await (await chat()).text();
    assert.equal(generation.at(-1).enabledCreditTypes, undefined);
    await set({ ENABLE_AI_CREDITS: true });
    await (await chat()).text();
    assert.deepEqual(generation.at(-1).enabledCreditTypes, ['GOOGLE_ONE_AI']);
    await set({ ENABLE_AI_CREDITS: false });
    scenario = 'thinking';
    await set({ RETURN_THOUGHTS: false });
    for (const stream of [false, true]) {
      const text = await (await chat({ stream })).text();
      assert.ok(!text.includes('hidden thought'));
      assert.ok(text.includes('visible answer'));
      assert.equal(
        generation.at(-1).request.generationConfig.thinkingConfig.includeThoughts,
        false,
      );
    }
    scenario = 'text';
    const beforeFake = await DB.prepare('SELECT COUNT(*) AS n FROM request_usage').first('n');
    const beforeCalls = generation.length;
    const fake = await chat({
      stream: true,
      fake_stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(fake.headers.get('x-stream-mode'), 'buffered-heartbeat');
    const fakeText = await fake.text();
    assert.ok(fakeText.includes(': heartbeat'));
    assert.ok(fakeText.includes('[DONE]'));
    assert.equal(generation.length, beforeCalls + 1);
    const fakeId = fake.headers.get('x-request-id');
    assert.match(fakeId, /^[a-f0-9-]{36}$/);
    assert.equal(
      await DB.prepare('SELECT COUNT(*) AS n FROM request_usage WHERE request_id=?')
        .bind(fakeId)
        .first('n'),
      1,
    );
    assert.equal(
      await DB.prepare('SELECT COUNT(*) AS n FROM request_usage').first('n'),
      beforeFake + 1,
    );
    const native = await chat(
      { contents: [{ role: 'user', parts: [{ text: 'native' }] }], fake_stream: true },
      'geminicli',
      '/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent',
    );
    assert.equal(native.status, 200);
    assert.ok((await native.text()).includes('answer'));
    assert.equal(generation.at(-1).request.fake_stream, undefined);
    const anthropic = await chat(
      { max_tokens: 32, stream: true, fake_stream: true },
      'geminicli',
      '/v1/messages',
    );
    assert.equal(anthropic.status, 200);
    const anthroText = await anthropic.text();
    assert.ok(anthroText.includes('text_delta'));
    assert.ok(anthroText.includes('message_stop'));
    await set({ CONTINUATION_ATTEMPTS: 1, CREDENTIAL_SELECTION: 'round_robin' });
    scenario = 'continue';
    part = 0;
    generation = [];
    const beforeContinue = await DB.prepare('SELECT COUNT(*) AS n FROM request_usage').first('n');
    const continued = await chat();
    assert.equal(continued.status, 200);
    assert.equal((await continued.json()).choices[0].message.content, 'first second');
    assert.equal(generation.length, 2);
    assert.equal(generationAuth.at(-1), generationAuth.at(-2));
    assert.equal(generation[1].request.contents.at(-1).role, 'user');
    assert.equal(
      await DB.prepare('SELECT COUNT(*) AS n FROM request_usage').first('n'),
      beforeContinue + 1,
    );
    const usage = await DB.prepare(
      'SELECT total_tokens FROM request_usage ORDER BY id DESC LIMIT 1',
    ).first();
    assert.equal(usage.total_tokens, 14);
    scenario = 'always-max';
    generation = [];
    const limited = await chat({ stream: true });
    assert.ok((await limited.text()).includes('length'));
    assert.equal(generation.length, 2);
    scenario = 'tool-max';
    generation = [];
    await (await chat()).text();
    assert.equal(generation.length, 1);
    await set({ ANTIGRAVITY_STREAM2NOSTREAM: true });
    scenario = 'incomplete';
    generation = [];
    const unconfirmed = await chat();
    assert.equal(unconfirmed.status, 200);
    assert.equal(unconfirmed.headers.get('x-completion-status'), 'unconfirmed');
    assert.equal((await unconfirmed.json()).completion_status, 'unconfirmed');
    assert.equal(generation.length, 1); // Missing finishReason must never trigger continuation.
    generation = [];
    const bufferedUnconfirmed = await chat({ stream: true });
    assert.match(await bufferedUnconfirmed.text(), /"completion_status":"unconfirmed"/);
    assert.equal(generation.length, 1);
    await set({ CONTINUATION_ATTEMPTS: 0, ANTIGRAVITY_STREAM2NOSTREAM: false });
    scenario = 'preview';
    await admin('credentials/' + b + '/preview', {});
    await admin('credentials/' + b + '/preview', {});
    assert.equal(previewPosts, 2);
    scenario = 'preview-denied';
    const denied = await mf.dispatchFetch('https://test/admin/credentials/' + b + '/preview', {
      method: 'POST',
      headers: { authorization: 'Bearer fixture-panel', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    const exported = await mf.dispatchFetch('https://test/admin/credentials/export.zip', {
      method: 'POST',
      headers: { authorization: 'Bearer fixture-panel', 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [a, b] }),
    });
    assert.equal(exported.status, 200);
    const archive = new Uint8Array(await exported.arrayBuffer());
    assert.equal((await readZip(archive)).length, 2);
    const imported = await mf.dispatchFetch(
      'https://test/admin/credentials/import.zip?mode=geminicli',
      {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-panel', 'content-type': 'application/zip' },
        body: archive,
      },
    );
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).imported, 2);
    await DB.prepare(
      'INSERT INTO credentials(id,mode,name,data,created_at,priority)VALUES(?,?,?,?,?,?)',
    )
      .bind(
        c,
        'geminicli',
        'expired',
        JSON.stringify({
          refresh_token: 'local-refresh',
          project_id: 'local-project',
          expiry: '2000-01-01T00:00:00Z',
        }),
        Date.now(),
        100,
      )
      .run();
    scenario = 'invalid-grant';
    await set({ AUTO_DISABLE_INVALID_CREDENTIALS: true });
    const fallback = await chat({}, 'geminicli');
    assert.equal(fallback.status, 200, await fallback.clone().text());
    await fallback.text();
    assert.equal(
      await DB.prepare('SELECT disabled FROM credentials WHERE id=?').bind(c).first('disabled'),
      1,
    );
    await DB.prepare('UPDATE credentials SET disabled=0 WHERE id=?').bind(c).run();
    scenario = 'invalid-client';
    await set({ MAX_CREDENTIAL_ATTEMPTS: 1 });
    assert.equal((await chat({}, 'geminicli')).status, 502);
    assert.equal(
      await DB.prepare('SELECT disabled FROM credentials WHERE id=?').bind(c).first('disabled'),
      0,
    );
  } finally {
    await mf.dispose();
  }
});

test('buffered SSE preserves the unconfirmed completion marker in every public protocol', async () => {
  for (const kind of ['openai', 'anthropic', 'gemini']) {
    let calls = 0;
    const value = {
      completion_status: 'unconfirmed',
      warnings: [{ code: 'UPSTREAM_FINISH_UNCONFIRMED', message: '结束未确认' }],
      choices: [
        { message: { role: 'assistant', content: 'existing text' }, finish_reason: 'stop' },
      ],
      content: [{ type: 'text', text: 'existing text' }],
      stop_reason: 'end_turn',
      candidates: [{ content: { parts: [{ text: 'existing text' }] } }],
    };
    const response = fakeStream(
      async () => {
        calls++;
        return Response.json(value);
      },
      kind,
      'gemini-test',
    );
    const text = await response.text();
    assert.match(text, /existing text/);
    assert.match(text, /"completion_status":"unconfirmed"/);
    assert.match(text, /UPSTREAM_FINISH_UNCONFIRMED/);
    assert.equal(calls, 1);
  }
});
