'use strict';
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { createComparison } = require('./comparison.cjs');
const BASE = '/v1/plugins/provider-token-compat';
const safeNumbers = new Set(['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'top_k']);
function visible(field, value, exists) {
  if (!exists) return '（不存在）';
  if (safeNumbers.has(field) && typeof value === 'number' && Number.isFinite(value)) return value;
  return '（内容已隐藏）';
}
function evaluateRequest(request, provider, rules) {
  const name = String(provider?.name || '').toLowerCase().split('::')[0];
  const body = request.body;
  const valid = provider && (request.bodyEncoding || 'json') === 'json' && body && typeof body === 'object' && !Array.isArray(body);
  let next = body;
  const traces = [];
  for (const [index, rule] of rules.entries()) {
    const trace = { name: rule.name || `规则 ${index + 1}`, matched: false, reason: '', actions: [] };
    if (!rule.enabled) trace.reason = '规则已关闭';
    else if (!valid) trace.reason = '不是可处理的 JSON 请求';
    else if (!rule.aliases.includes(name)) trace.reason = '供应商不匹配';
    else if (rule.match.protocol && rule.match.protocol !== provider.type) trace.reason = '协议不匹配';
    else if (rule.match.models && !rule.match.models.includes(body.model)) trace.reason = '模型不匹配';
    else {
      trace.matched = true;
      trace.reason = '条件匹配';
      for (const action of rule.actions) {
        const item = { type: action.type, field: action.field || action.from, to: action.to, changed: false, reason: '' };
        if (action.type === 'rename') {
          if (!Object.hasOwn(next, action.from)) item.reason = '原字段不存在，跳过';
          else {
            const targetExists = Object.hasOwn(next, action.to);
            item.before = visible(action.from, next[action.from], true);
            item.targetBefore = visible(action.to, next[action.to], targetExists);
            const copy = { ...next };
            if (!targetExists) copy[action.to] = copy[action.from];
            delete copy[action.from];
            next = copy;
            item.after = visible(action.to, next[action.to], true);
            item.changed = true;
            item.reason = targetExists ? '保留已有目标值，删除旧字段' : '已改名，保留原值';
          }
        } else if (action.type === 'delete') {
          if (!Object.hasOwn(next, action.field)) item.reason = '字段不存在，跳过';
          else {
            item.before = visible(action.field, next[action.field], true);
            next = { ...next };
            delete next[action.field];
            item.after = '（不存在）';
            item.changed = true;
            item.reason = '已移除字段';
          }
        } else {
          const value = next[action.field];
          if (!Object.hasOwn(next, action.field)) item.reason = '字段不存在，跳过';
          else if (!Number.isSafeInteger(value) || value <= 0) item.reason = '不是正整数，保持原样';
          else if (value >= action.value) item.reason = '已达到最低值，无需调整';
          else {
            item.before = visible(action.field, value, true);
            next = { ...next, [action.field]: action.value };
            item.after = visible(action.field, action.value, true);
            item.changed = true;
            item.reason = '已提高到最低值';
          }
        }
        trace.actions.push(item);
      }
    }
    traces.push(trace);
  }
  return { request: next === body ? request : { ...request, body: next }, traces, changed: next !== body };
}
function diagnosticHooks(config, api) {
  const options = config.diagnostics || { enabled: false };
  const entries = [];
  const pending = new Map();
  const incoming = new Map();
  const comparison = createComparison();
  function key(input) { return `${input.request?.id || ''}\n${input.targetProviderConfig?.name || ''}`; }
  function observe(input, status) {
    if (!options.enabled || !input.request?.id) return;
    const entry = pending.get(key(input));
    if (!entry) return;
    entry.status = status;
    entry.outcome = status >= 400 ? '供应商拒绝了请求' : '已收到响应';
    entry.elapsedMs = Date.now() - entry.startedMs;
    pending.delete(key(input));
  }
  function authorized(request) {
    const webToken = request.headers['x-ccr-web-auth'];
    if (options.webTokenHash && typeof webToken === 'string') {
      const digest = createHash('sha256').update(webToken).digest();
      if (timingSafeEqual(digest, Buffer.from(options.webTokenHash, 'hex'))) return true;
    }
    const supplied = request.headers['x-diagnostics-key'];
    if (typeof supplied !== 'string' || !options.token) return false;
    const left = Buffer.from(supplied), right = Buffer.from(options.token);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  const route = (method, suffix, handler) => ({
    key: `token-diagnostics-${method}-${suffix || 'page'}`, method, path: BASE + suffix, auth: 'none',
    handler(input) {
      const { request, reply } = input;
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff');
      if (suffix && !authorized(request)) return reply.code(401).send({ error: '诊断访问凭证无效，请从扩展页重新打开，或填写当前访问凭证。' });
      try { return handler(input); } catch (error) { return reply.code(400).send({ error: error.message }); }
    },
  });
  return {
    requestHooks: options.enabled ? [{ key: 'token-comparison-ingress', beforeAuth(input) {
      if (!input.request?.id) return;
      const now = Date.now();
      for (const [id, value] of incoming) if (now - value.time > 300000) incoming.delete(id);
      if (!incoming.has(input.request.id)) incoming.set(input.request.id, { time: now, snapshot: comparison.snapshot(input.requestBody ?? input.request.body) });
      while (incoming.size > options.maxEntries) incoming.delete(incoming.keys().next().value);
    } }] : [],
    providerHooks: [{
      key: 'provider-token-compat-outbound',
      transformRequest(input) {
        const evaluated = api.evaluateRequest(input.upstreamRequest, input.targetProviderConfig, config.rules);
        if (options.enabled) {
          const providerName = String(input.targetProviderConfig?.name || '').split('::')[0];
          const publicProvider = config.providers?.find(item => item.aliases.includes(providerName.toLowerCase()));
          const entry = { id: randomUUID(), requestId: String(input.request?.id || '').slice(0, 120), startedMs: Date.now(), time: new Date().toISOString(), provider: publicProvider?.name || providerName, protocol: input.targetProviderConfig?.type || '未知', changed: evaluated.changed, traces: evaluated.traces, outcome: '尚未观察到响应', status: null, comparison: comparison.compare(incoming.get(input.request?.id)?.snapshot ?? null, comparison.snapshot(input.upstreamRequest.body), comparison.snapshot(evaluated.request.body)) };
          entries.unshift(entry);
          if (input.request?.id) pending.set(key(input), entry);
          while (entries.length > options.maxEntries) {
            const removed = entries.pop();
            for (const [key, value] of pending) if (value === removed) pending.delete(key);
          }
        }
        return { ok: true, value: evaluated.request };
      },
    }],
    responseHooks: options.enabled ? [{ key: 'token-diagnostics-response', transformResponse(input) { observe(input, input.upstreamResponse?.status ?? input.statusCode); } }] : [],
    streamHooks: options.enabled ? [{ key: 'token-diagnostics-stream', transformResponse(input) { observe(input, input.upstreamResponse.status); return input.upstreamResponse; } }] : [],
    httpRoutes: !options.enabled ? [] : [
      route('GET', '', ({ reply }) => reply.header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'").type('text/html; charset=utf-8').send(api.page())),
      route('GET', '/records', () => ({ version: api.version, entries, providers: config.providers.map(provider => provider.name), rules: config.rules.map(({ aliases, ...rule }) => rule), maxEntries: options.maxEntries })),
      route('DELETE', '/records', () => { entries.length = 0; pending.clear(); incoming.clear(); return { ok: true }; }),
      route('POST', '/trial', ({ request }) => {
        const value = request.body;
        if (!value || typeof value !== 'object' || Array.isArray(value) || !value.body || typeof value.body !== 'object' || Array.isArray(value.body)) throw new Error('body 必须为 JSON 对象');
        if (JSON.stringify(value).length > 262144) throw new Error('试跑内容不能超过 256 KB');
        if (!['openai_chat_completions', 'openai_responses', 'anthropic_messages', 'gemini_generate_content', 'gemini_interactions', 'openai_image_generations'].includes(value.protocol)) throw new Error('请选择有效的实际供应商协议');
        const provider = config.providers.find(item => item.name === value.provider);
        if (!provider) throw new Error('请选择已配置的供应商');
        const rules = value.rules === undefined ? config.rules : api.compileRules({ rules: value.rules }, config.providers);
        const evaluated = api.evaluateRequest({ body: value.body, bodyEncoding: 'json' }, { name: provider.aliases[0], type: value.protocol }, rules);
        return { changed: evaluated.changed, traces: evaluated.traces, comparison: comparison.compare(null, comparison.snapshot(value.body), comparison.snapshot(evaluated.request.body)), note: '仅试跑规则，未调用供应商；结果不写入处理记录。' };
      }),
    ],
  };
}
module.exports = { evaluateRequest, diagnosticHooks };
