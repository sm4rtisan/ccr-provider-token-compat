'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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

function readRules(value) {
  if (!value || !Array.isArray(value.rules)) throw new Error('settings.json 必须包含 rules 数组');
  return value.rules.map((rule) => {
    if (!rule || typeof rule.provider !== 'string' || !rule.provider.trim()) throw new Error('每条规则必须指定供应商名称');
    if (rule.chatUseMaxCompletionTokens !== undefined && typeof rule.chatUseMaxCompletionTokens !== 'boolean') throw new Error('chatUseMaxCompletionTokens 必须为 true 或 false');
    const minimum = rule.responsesMinOutputTokens;
    if (minimum !== undefined && (!Number.isSafeInteger(minimum) || minimum < 1)) throw new Error('responsesMinOutputTokens 必须为正整数');
    return { ...rule, provider: rule.provider.trim() };
  });
}

function setup(ctx) {
  const settings = ctx.pluginConfig && Object.hasOwn(ctx.pluginConfig, 'rules')
    ? ctx.pluginConfig
    : JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
  const rules = readRules(settings).map((rule) => {
    const matches = (ctx.config.Providers || []).filter((provider) => provider.name?.toLowerCase() === rule.provider.toLowerCase());
    if (matches.length !== 1) throw new Error(`供应商 ${rule.provider} 未找到或名称重复，请检查 settings.json`);
    const provider = matches[0];
    return { ...rule, aliases: [...new Set([provider.name, runtimeId(provider)].map((name) => name.toLowerCase()))] };
  });
  ctx.registerCoreGatewayPlugin({
    key: 'provider-token-compat',
    enabled: true,
    modulePath: __filename,
    config: { rules },
  });
}

function createGatewayPlugin({ plugin }) {
  const rules = plugin.config.rules;
  return {
    providerHooks: [{
      key: 'provider-token-compat-outbound',
      transformRequest(input) {
        const request = input.upstreamRequest;
        const provider = input.targetProviderConfig;
        if (!provider || (request.bodyEncoding || 'json') !== 'json' || !request.body || typeof request.body !== 'object' || Array.isArray(request.body)) return { ok: true, value: request };
        const name = String(provider.name || '').toLowerCase().split('::')[0];
        const rule = rules.find((item) => item.aliases.includes(name));
        if (!rule) return { ok: true, value: request };
        const body = request.body;
        let next = body;
        if (provider.type === 'openai_chat_completions' && rule.chatUseMaxCompletionTokens && Object.hasOwn(body, 'max_tokens')) {
          next = { ...body };
          if (!Object.hasOwn(next, 'max_completion_tokens')) next.max_completion_tokens = next.max_tokens;
          delete next.max_tokens;
        }
        if (provider.type === 'openai_responses' && rule.responsesMinOutputTokens) {
          const limit = body.max_output_tokens;
          if (Number.isSafeInteger(limit) && limit > 0 && limit < rule.responsesMinOutputTokens) next = { ...body, max_output_tokens: rule.responsesMinOutputTokens };
        }
        return { ok: true, value: next === body ? request : { ...request, body: next } };
      },
    }],
  };
}

module.exports = { setup, createGatewayPlugin };
