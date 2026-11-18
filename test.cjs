'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setup, createGatewayPlugin } = require('./index.cjs');

function registration(provider = { id: 'openai', name: 'openai', baseurl: 'http://example.test' }, settings) {
  let registered;
  setup({ config: { Providers: [provider] }, pluginConfig: settings, registerCoreGatewayPlugin(value) { registered = value; } });
  return registered;
}
function transform(type, body, name = 'provider-openai::openai_responses::cred:key-1', settings) {
  const registered = registration(undefined, settings);
  const hook = createGatewayPlugin({ plugin: registered }).providerHooks[0];
  const original = structuredClone(body);
  const request = { url: 'http://example.test/v1/responses', bodyEncoding: 'json', body, headers: { untouched: 'yes' } };
  const result = hook.transformRequest({ targetProviderConfig: { name, type }, upstreamRequest: request });
  assert.deepEqual(body, original);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.headers, request.headers);
  return result.value.body;
}

test('Chat renames the field, keeps its value and preserves an explicit new value', () => {
  for (const value of [1, 16, 8192]) {
    const result = transform('openai_chat_completions', { model: 'any-model', max_tokens: value, metadata: { user: 'a' } });
    assert.equal(result.max_completion_tokens, value);
    assert.equal(result.max_tokens, undefined);
    assert.deepEqual(result.metadata, { user: 'a' });
  }
  assert.equal(transform('openai_chat_completions', { max_tokens: 1, max_completion_tokens: 512 }).max_completion_tokens, 512);
});
test('Responses only raises positive integer limits below the configured minimum', () => {
  for (const value of [1, 15, 16, 8192, 0, -1, 1.5, '1', null]) {
    assert.equal(transform('openai_responses', { max_output_tokens: value }).max_output_tokens,
      Number.isSafeInteger(value) && value > 0 && value < 16 ? 16 : value);
  }
  assert.deepEqual(transform('openai_responses', { model: 'another-model' }), { model: 'another-model' });
});
test('other providers, protocols and disabled options remain unchanged', () => {
  const body = { max_tokens: 1, max_output_tokens: 1 };
  assert.deepEqual(transform('anthropic_messages', body), body);
  assert.deepEqual(transform('openai_responses', body, 'unrelated-provider'), body);
  const settings = { rules: [rule('openai_chat_completions', [{ type: 'rename', from: 'max_tokens', to: 'max_completion_tokens' }], { enabled: false })] };
  assert.deepEqual(transform('openai_chat_completions', body, 'provider-openai', settings), body);
});
test('validates settings and generates CCR aliases for providers with and without IDs', () => {
  assert.ok(registration({ name: 'openai', baseurl: 'http://example.test' }).config.rules[0].aliases[1].startsWith('provider-openai-'));
  assert.throws(() => registration(undefined, { rules: [rule('openai_responses', [{ type: 'minimum', field: 'max_output_tokens', value: 0 }])] }));
  assert.throws(() => registration(undefined, { rules: [rule('openai_responses', [{ type: 'minimum', field: 'max_output_tokens', value: 16 }], { match: { providers: ['missing'], protocol: 'openai_responses' } })] }));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin.json')));
  assert.equal(manifest.module, 'index.cjs');
  assert.ok(manifest.permissions.includes('core-gateway-plugins'));
});

const gatewayEntry = process.env.CCR_TEST_GATEWAY_ENTRY;
test('real ai-gateway: Anthropic requests reach mock providers through the installed module', { skip: !gatewayEntry, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-token-compat-test-'));
  const captured = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    captured.push({ url: request.url, body });
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/chat/completions')) {
      response.end(JSON.stringify({ id: 'chat-test', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } else {
      response.end(JSON.stringify({ id: 'resp-test', object: 'response', model: body.model, status: 'completed', output: [{ id: 'msg-test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
    }
  });
  let child;
  let output = '';
  try {
    await listen(upstream);
    const reservation = http.createServer();
    await listen(reservation);
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const registered = registration();
    const aliases = registered.config.rules[0].aliases;
    const providers = ['openai_chat_completions', 'openai_responses'].flatMap(type => [
      { name: `provider-openai::${type}::cred:key-1`, type, baseurl: `http://127.0.0.1:${upstream.address().port}/v1`, apikey: 'test-only', models: ['any-model'] },
      { name: `other::${type}`, type, baseurl: `http://127.0.0.1:${upstream.address().port}/v1`, apikey: 'test-only', models: ['any-model'] },
    ]);
    assert.ok(aliases.includes('provider-openai'));
    const configPath = path.join(root, 'gateway.json');
    fs.writeFileSync(configPath, JSON.stringify({ host: '127.0.0.1', port, logging: { enabled: false }, providers, plugins: [registered] }));
    child = spawn(process.execPath, [gatewayEntry], { cwd: root, env: { ...process.env, GATEWAY_CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output = (output + data).slice(-6000); });
    child.stderr.on('data', data => { output = (output + data).slice(-6000); });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { ready = (await fetch(origin + '/health', { signal: AbortSignal.timeout(300) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    for (const provider of providers) {
      for (const limit of [1, 8192]) {
        const response = await fetch(origin + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-target-provider': provider.name }, body: JSON.stringify({ model: 'any-model', max_tokens: limit, messages: [{ role: 'user', content: 'hello' }] }), signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200, await response.text());
        const actual = captured.at(-1).body;
        const matched = provider.name.startsWith('provider-openai::');
        if (provider.type === 'openai_chat_completions') {
          if (matched) { assert.equal(actual.max_tokens, undefined); assert.equal(actual.max_completion_tokens, limit); }
          else assert.equal(actual.max_tokens ?? actual.max_completion_tokens, limit);
        } else assert.equal(actual.max_output_tokens, matched ? Math.max(16, limit) : limit);
      }
    }
    assert.equal(captured.length, 8);
    const routeBase = origin + '/v1/plugins/provider-token-compat';
    const diagnosticHeaders = { 'x-diagnostics-key': registered.config.diagnostics.token, 'content-type': 'application/json' };
    const denied = await fetch(routeBase + '/records');
    assert.equal(denied.status, 401);
    const page = await fetch(routeBase);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('规则试跑'));
    const logsResponse = await fetch(routeBase + '/records', { headers: diagnosticHeaders });
    assert.equal(logsResponse.status, 200, await logsResponse.clone().text());
    const logs = await logsResponse.json();
    assert.equal(logs.entries.length, 8);
    assert.ok(logs.entries.some(entry => entry.changed));
    assert.ok(logs.entries.some(entry => entry.traces.some(trace => trace.reason === '供应商不匹配')));
    assert.ok(logs.entries.some(entry => entry.status === 200), JSON.stringify(logs.entries));
    assert.ok(!JSON.stringify(logs).includes('test-only'));
    const trial = await fetch(routeBase + '/trial', { method: 'POST', headers: diagnosticHeaders, body: JSON.stringify({ provider: 'openai', protocol: 'openai_responses', body: { max_output_tokens: 1, messages: [{ role: 'user', content: 'NEVER_STORE_PRIVATE' }] } }) });
    assert.equal(trial.status, 200, await trial.clone().text());
    const trialResult = await trial.json();
    assert.equal(trialResult.changed, true);
    assert.ok(!JSON.stringify(trialResult).includes('NEVER_STORE_PRIVATE'));
    assert.equal(captured.length, 8, 'trial must not call the supplier');
    const invalid = await fetch(routeBase + '/trial', { method: 'POST', headers: diagnosticHeaders, body: JSON.stringify({ provider: 'openai', protocol: 'openai_responses', body: {}, rules: [{ wrong: true }] }) });
    assert.equal(invalid.status, 400);
    const clear = await fetch(routeBase + '/records', { method: 'DELETE', headers: { 'x-diagnostics-key': registered.config.diagnostics.token } });
    assert.equal(clear.status, 200);
    assert.equal((await (await fetch(routeBase + '/records', { headers: diagnosticHeaders })).json()).entries.length, 0);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(timer);
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }

function rule(protocol, actions, extra = {}) {
  return { name: 'test', enabled: true, match: { providers: ['openai'], protocol }, actions, ...extra };
}
test('legacy settings are rejected and an empty rules array disables processing', () => {
  assert.throws(() => registration(undefined, { rules: [{ provider: 'openai', chatUseMaxCompletionTokens: true, responsesMinOutputTokens: 16 }] }), /不支持的字段/);
  assert.deepEqual(transform('openai_responses', { max_output_tokens: 1 }, undefined, { rules: [] }), { max_output_tokens: 1 });
});
test('matching rules and actions run in order; renamed fields feed later actions', () => {
  const settings = { rules: [
    rule('openai_chat_completions', [{ type: 'rename', from: 'max_tokens', to: 'max_completion_tokens' }]),
    rule('openai_chat_completions', [{ type: 'minimum', field: 'max_completion_tokens', value: 16 }]),
    rule('openai_responses', [{ type: 'rename', from: 'metadata', to: 'should_not_exist' }]),
  ] };
  assert.deepEqual(transform('openai_chat_completions', { max_tokens: 1, metadata: 'kept' }, undefined, settings), { max_completion_tokens: 16, metadata: 'kept' });
  assert.deepEqual(transform('openai_chat_completions', { max_tokens: 1, max_completion_tokens: 4096 }, undefined, settings), { max_completion_tokens: 4096 });
  assert.deepEqual(transform('openai_chat_completions', {}, undefined, settings), {});
});
test('multiple providers match their own runtime aliases; disabled missing providers do not block startup', () => {
  let registered;
  const settings = { rules: [rule('openai_responses', [{ type: 'minimum', field: 'max_output_tokens', value: 32 }], { match: { providers: [' OPENAI ', 'second'], protocol: 'openai_responses' } }),
    rule('openai_responses', [{ type: 'minimum', field: 'max_output_tokens', value: 100 }], { enabled: false, match: { providers: ['missing'], protocol: 'openai_responses' } })] };
  setup({ config: { Providers: [{ name: 'openai', id: 'openai' }, { name: 'second', id: 'second-id' }] }, pluginConfig: settings, registerCoreGatewayPlugin(value) { registered = value; } });
  const hook = createGatewayPlugin({ plugin: registered }).providerHooks[0];
  for (const name of ['provider-openai::openai_responses', 'second-id::openai_responses::cred:key']) {
    assert.equal(hook.transformRequest({ targetProviderConfig: { name, type: 'openai_responses' }, upstreamRequest: { body: { max_output_tokens: 1 } } }).value.body.max_output_tokens, 32);
  }
  assert.deepEqual(transform('openai_responses', { max_output_tokens: 1 }, undefined, { rules: [rule('openai_responses', [{ type: 'minimum', field: 'max_output_tokens', value: 32 }], { enabled: false })] }), { max_output_tokens: 1 });
});
test('rejects unsafe paths, typos, mixed formats, unsupported actions and invalid options', () => {
  const action = { type: 'minimum', field: 'max_output_tokens', value: 16 };
  const invalid = [
    rule('typo', [action]), rule('openai_responses', []),
    rule('openai_responses', [{ type: 'delete', field: 'metadata' }]),
    rule('openai_responses', [{ ...action, field: '__proto__' }]),
    rule('openai_responses', [{ ...action, field: 'metadata.user' }]),
    rule('openai_responses', [{ ...action, value: 0 }]),
    rule('openai_responses', [{ ...action, ifMissing: 'set' }]),
    rule('openai_responses', [{ type: 'rename', from: 'max_tokens', to: 'max_tokens' }]),
    rule('openai_responses', [{ type: 'rename', from: 'max_tokens', to: 'max_completion_tokens', ifTargetExists: 'overwrite' }]),
    rule('openai_responses', [action], { enabled: 'false' }),
    rule('openai_responses', [action], { provider: 'openai' }),
    rule('openai_responses', [action], { match: { providers: [], protocol: 'openai_responses' } }),
    rule('openai_responses', [action], { unexpected: true }),
  ];
  for (const item of invalid) assert.throws(() => registration(undefined, { rules: [item] }), JSON.stringify(item));
});
test('non-JSON bodies pass through unchanged', () => {
  const hook = createGatewayPlugin({ plugin: registration() }).providerHooks[0];
  for (const body of [null, [], 'text']) {
    const request = { body };
    assert.equal(hook.transformRequest({ targetProviderConfig: { name: 'provider-openai', type: 'openai_responses' }, upstreamRequest: request }).value, request);
  }
  const request = { body: { max_output_tokens: 1 }, bodyEncoding: 'text' };
  assert.equal(hook.transformRequest({ targetProviderConfig: { name: 'provider-openai', type: 'openai_responses' }, upstreamRequest: request }).value, request);
});

test('plugin metadata and runtime registration share one valid release version', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin.json'), 'utf8'));
  const { manifest } = require('./index.cjs');
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, metadata.version);
  assert.equal(registration().manifest.version, metadata.version);
  assert.ok(fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8').includes(`当前版本：**${metadata.version}**`));
  assert.ok(fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8').includes(`## ${metadata.version}`));
});

function diagnosticRuntime(settings) {
  const registered = registration(undefined, settings);
  return { runtime: createGatewayPlugin({ plugin: registered }), registered };
}
function routeCall(runtime, suffix, method, body, token) {
  const route = runtime.httpRoutes.find(item => item.path.endsWith(suffix) && item.method === method);
  const reply = { status: 200, header() { return this; }, code(value) { this.status = value; return this; }, send(value) { this.data = value; return this; } };
  const result = route.handler({ request: { headers: { 'x-diagnostics-key': token }, body }, reply });
  return { status: reply.status, data: reply.data ?? result };
}
test('diagnostic records are bounded, redact text, correlate outcomes and clear safely', () => {
  const rules = [{ match: { providers: ['openai'], protocol: 'openai_chat_completions' }, actions: [{ type: 'rename', from: 'secret', to: 'renamed' }] }];
  const { runtime, registered } = diagnosticRuntime({ rules, diagnostics: { maxEntries: 2, accessKey: 'diagnostic-test-key-with-32-characters' } });
  const hook = runtime.providerHooks[0];
  for (let i = 0; i < 3; i++) hook.transformRequest({ request: { id: `request-${i}`, headers: { authorization: 'DO_NOT_RECORD_AUTH' } }, targetProviderConfig: { name: 'provider-openai::openai_chat_completions', type: 'openai_chat_completions' }, upstreamRequest: { body: { secret: 'DO_NOT_RECORD_SECRET', messages: ['DO_NOT_RECORD_MESSAGE'] } } });
  const token = registered.config.diagnostics.token;
  let result = routeCall(runtime, '/records', 'GET', undefined, token);
  assert.equal(result.data.entries.length, 2);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_RECORD'));
  runtime.responseHooks[0].transformResponse({ request: { id: 'request-2' }, targetProviderConfig: { name: 'provider-openai::openai_chat_completions' }, statusCode: 403 });
  result = routeCall(runtime, '/records', 'GET', undefined, token);
  assert.equal(result.data.entries[0].status, 403);
  assert.equal(result.data.entries[0].outcome, '供应商拒绝了请求');
  assert.equal(routeCall(runtime, '/records', 'GET', undefined, 'wrong').status, 401);
  routeCall(runtime, '/records', 'DELETE', undefined, token);
  assert.equal(routeCall(runtime, '/records', 'GET', undefined, token).data.entries.length, 0);
});
test('trial explains disabled, mismatched and no-op actions without recording or persisting temporary rules', () => {
  const { runtime, registered } = diagnosticRuntime();
  const token = registered.config.diagnostics.token;
  const body = { provider: 'openai', protocol: 'openai_responses', body: { max_output_tokens: 1 }, rules: [{ enabled: false, match: { providers: ['openai'], protocol: 'openai_responses' }, actions: [{ type: 'minimum', field: 'max_output_tokens', value: 64 }] }] };
  const result = routeCall(runtime, '/trial', 'POST', body, token);
  assert.equal(result.data.traces[0].reason, '规则已关闭');
  assert.equal(result.data.changed, false);
  const real = routeCall(runtime, '/trial', 'POST', { ...body, rules: undefined }, token);
  assert.equal(real.data.changed, true);
  assert.equal(real.data.traces[1].actions[0].after, 16);
  assert.equal(routeCall(runtime, '/records', 'GET', undefined, token).data.entries.length, 0);
  assert.equal(routeCall(runtime, '/trial', 'POST', { ...body, protocol: 'bad' }, token).status, 400);
});
test('diagnostics can be disabled and invalid access settings are rejected', () => {
  const { runtime } = diagnosticRuntime({ rules: [], diagnostics: { enabled: false } });
  assert.deepEqual(runtime.httpRoutes, []);
  assert.deepEqual(runtime.responseHooks, []);
  for (const diagnostics of [{ maxEntries: 0 }, { maxEntries: 1001 }, { accessKey: 'short' }, { enabled: 'yes' }]) assert.throws(() => registration(undefined, { rules: [], diagnostics }));
});

test('stream observation preserves the response and records only the observed HTTP status', () => {
  const { runtime, registered } = diagnosticRuntime();
  const input = { request: { id: 'stream-request' }, targetProviderConfig: { name: 'provider-openai::openai_responses', type: 'openai_responses' }, upstreamRequest: { body: { max_output_tokens: 1 } } };
  runtime.providerHooks[0].transformRequest(input);
  const response = new Response('data: private-output\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  assert.equal(runtime.streamHooks[0].transformResponse({ ...input, upstreamResponse: response }), response);
  assert.equal(response.bodyUsed, false);
  const logs = routeCall(runtime, '/records', 'GET', undefined, registered.config.diagnostics.token).data;
  assert.equal(logs.entries[0].status, 200);
  assert.equal(logs.entries[0].outcome, '已收到响应');
  assert.ok(!JSON.stringify(logs).includes('private-output'));
});

test('desktop app registration uses diagnostics access and respects disabled app permissions', () => {
  const apps = [];
  setup({ config: { gateway: { host: '0.0.0.0', port: 3456 }, Providers: [{ id: 'openai', name: 'openai' }] }, registerCoreGatewayPlugin() {}, registerApp(app) { apps.push(app); }, permissions: ['apps'] });
  assert.equal(apps.length, 1);
  assert.ok(apps[0].url.startsWith('http://127.0.0.1:3456/v1/plugins/provider-token-compat#key='));
  setup({ config: { Providers: [{ id: 'openai', name: 'openai' }] }, registerCoreGatewayPlugin() {}, registerApp() { throw new Error('should not register'); }, permissions: ['core-gateway-plugins'] });
});
