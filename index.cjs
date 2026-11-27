'use strict';
const { createHash, randomBytes } = require('node:crypto');
const { evaluateRequest, diagnosticHooks } = require('./diagnostics.cjs');
const fs = require('node:fs');
const path = require('node:path');
const metadata = require('./plugin.json');
const manifest = { name: metadata.id, version: metadata.version };

function cleanId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

// Matches CCR 3.1.5 runtime IDs, including IDs generated for providers without an explicit ID.
function runtimeId(provider) {
  const explicit = cleanId(provider.id);
  if (explicit) return ['openai', 'anthropic', 'claude', 'gemini', 'google'].includes(explicit) ? `provider-${explicit}` : explicit;
  const name = String(provider.name);
  const slug = cleanId(name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')).slice(0, 48);
  const baseUrl = provider.baseurl || provider.baseUrl || provider.api_base_url || '';
  const hash = createHash('sha256').update(`${name}\n${baseUrl}`).digest('hex').slice(0, 10);
  return `provider-${slug || 'provider'}-${hash}`;
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function allowedKeys(value, allowed, label) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} 含有不支持的字段或格式错误`);
}
function fieldName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw new Error('动作字段必须为安全的顶层字段名称');
  return value;
}
const protocols = ['openai_chat_completions', 'openai_responses', 'anthropic_messages', 'gemini_generate_content', 'gemini_interactions', 'openai_image_generations'];
function readAction(action) {
  if (!record(action)) throw new Error('动作必须为对象');
  if (action.type === 'rename') {
    allowedKeys(action, ['type', 'from', 'to', 'ifTargetExists'], 'rename');
    const from = fieldName(action.from), to = fieldName(action.to);
    if (from === to) throw new Error('改名前后的字段不能相同');
    if (action.ifTargetExists !== undefined && action.ifTargetExists !== 'keep') throw new Error('ifTargetExists 目前只支持 keep');
    return { type: 'rename', from, to, ifTargetExists: 'keep' };
  }
  if (action.type === 'delete') {
    allowedKeys(action, ['type', 'field'], 'delete');
    return { type: 'delete', field: fieldName(action.field) };
  }
  if (action.type === 'minimum') {
    allowedKeys(action, ['type', 'field', 'value', 'ifMissing'], 'minimum');
    if (!Number.isSafeInteger(action.value) || action.value < 1) throw new Error('最低值必须为正整数');
    if (action.ifMissing !== undefined && action.ifMissing !== 'skip') throw new Error('ifMissing 目前只支持 skip');
    return { type: 'minimum', field: fieldName(action.field), value: action.value, ifMissing: 'skip' };
  }
  throw new Error(`不支持的动作: ${action.type}`);
}
function readRules(value) {
  allowedKeys(value, ['rules', 'diagnostics'], '配置');
  if (!Array.isArray(value.rules)) throw new Error('配置必须包含 rules 数组');
  return value.rules.map((rule) => {
    if (!record(rule)) throw new Error('规则必须为对象');
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') throw new Error('enabled 必须为 true 或 false');
    if (rule.name !== undefined && typeof rule.name !== 'string') throw new Error('name 必须为字符串');
    const common = { name: rule.name, enabled: rule.enabled !== false };
    allowedKeys(rule, ['name', 'enabled', 'match', 'actions'], '规则');
    allowedKeys(rule.match, ['providers', 'protocol', 'models'], 'match');
    if (!Array.isArray(rule.match.providers) || !rule.match.providers.length || rule.match.providers.some(name => typeof name !== 'string' || !name.trim())) throw new Error('match.providers 必须为非空供应商名称数组');
    const { models, protocol } = rule.match;
    if (models !== undefined && (!Array.isArray(models) || !models.length ||
      models.some(model => typeof model !== 'string' || !model.trim()))) {
      throw new Error('match.models 必须为非空模型名称数组');
    }
    if ((protocol !== undefined || models === undefined) && !protocols.includes(protocol)) throw new Error('match.protocol 必须为支持的实际供应商协议');
    if (!Array.isArray(rule.actions) || !rule.actions.length) throw new Error('actions 不能为空');
    return { ...common, match: { providers: rule.match.providers.map(name => name.trim()), protocol, ...(models && { models: models.map(model => model.trim()) }) }, actions: rule.actions.map(readAction) };
  });
}

function setup(ctx) {
  const settings = ctx.pluginConfig && Object.hasOwn(ctx.pluginConfig, 'rules')
    ? ctx.pluginConfig
    : { ...JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')), ...(ctx.pluginConfig || {}) };
  const providers = (ctx.config.Providers || []).map(provider => ({ name: provider.name, aliases: [provider.name.toLowerCase(), runtimeId(provider).toLowerCase()] }));
  const rules = compileRules(settings, providers);
  const options = settings.diagnostics ?? {};
  allowedKeys(options, ['enabled', 'maxEntries', 'accessKey'], 'diagnostics');
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new Error('diagnostics.enabled 必须为布尔值');
  if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1 || options.maxEntries > 1000)) throw new Error('maxEntries 必须在 1 到 1000 之间');
  if (options.accessKey !== undefined && (typeof options.accessKey !== 'string' || options.accessKey.length < 24 || options.accessKey.length > 256)) throw new Error('diagnostics.accessKey 长度必须在 24 到 256 之间');
  const enabled = options.enabled !== false;
  const token = enabled ? (options.accessKey || randomBytes(32).toString('hex')) : '';
  ctx.registerCoreGatewayPlugin({
    key: 'provider-token-compat',
    enabled: true,
    modulePath: __filename,
    manifest,
    config: { rules, providers, diagnostics: { enabled, maxEntries: options.maxEntries ?? 200, token } },
  });
  const appSurface = ctx.config.plugins?.find(item => item.id === ctx.pluginId)?.surfaces?.apps !== false;
  const appPermission = !ctx.permissions || ctx.permissions.includes('apps');
  if (enabled && ctx.registerApp && appSurface && appPermission) {
    const host = ctx.config.gateway?.host;
    const address = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const authority = address.includes(':') ? `[${address}]` : address;
    ctx.registerApp({ id: 'diagnostics', name: '请求诊断', url: `http://${authority}:${ctx.config.gateway?.port ?? 3456}/v1/plugins/provider-token-compat#key=${token}` });
  }
}

function compileRules(settings, providers) {
  return readRules(settings).map(rule => {
    const aliases = rule.enabled ? rule.match.providers.flatMap(name => {
      const matches = providers.filter(provider => provider.name.toLowerCase() === name.toLowerCase());
      if (matches.length !== 1) throw new Error(`供应商 ${name} 未找到或名称重复`);
      return matches[0].aliases;
    }) : [];
    return { ...rule, aliases: [...new Set(aliases)] };
  });
}

function createGatewayPlugin({ plugin }) {
  return diagnosticHooks(plugin.config, {
    evaluateRequest,
    compileRules,
    version: metadata.version,
    page: () => fs.readFileSync(path.join(__dirname, 'diagnostics.html'), 'utf8'),
  });
}

module.exports = { setup, createGatewayPlugin, manifest };
