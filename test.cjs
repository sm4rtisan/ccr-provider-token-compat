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
  const settings = { rules: [{ provider: 'openai', chatUseMaxCompletionTokens: false }] };
  assert.deepEqual(transform('openai_chat_completions', body, 'provider-openai', settings), body);
});
test('validates settings and generates CCR aliases for providers with and without IDs', () => {
  assert.ok(registration({ name: 'openai', baseurl: 'http://example.test' }).config.rules[0].aliases[1].startsWith('provider-openai-'));
  assert.throws(() => registration(undefined, { rules: [{ provider: 'openai', responsesMinOutputTokens: 0 }] }));
  assert.throws(() => registration(undefined, { rules: [{ provider: 'missing' }] }));
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
