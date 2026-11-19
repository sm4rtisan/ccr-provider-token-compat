'use strict';
const { createHmac, randomBytes } = require('node:crypto');
const safeNumbers = new Set(['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'top_k']);
const safeBooleans = new Set(['stream', 'parallel_tool_calls', 'store']);
const MAX_FIELDS = 64;
const MAX_HASH_BYTES = 256 * 1024;
function createComparison() {
  const secret = randomBytes(32);
  function snapshot(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const names = Object.keys(body).filter(name => body[name] !== undefined);
    const fields = names.slice(0, MAX_FIELDS).map(name => {
      const value = body[name];
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      let display = '内容已隐藏';
      if (safeNumbers.has(name) && typeof value === 'number' && Number.isFinite(value)) display = String(value);
      else if (safeBooleans.has(name) && typeof value === 'boolean') display = String(value);
      else if (name === 'model' && typeof value === 'string') display = value.slice(0, 256).replace(/[\u0000-\u001f\u007f]/g, '�') + (value.length > 256 ? '…（已截断）' : '');
      else if (Array.isArray(value)) display = `数组，共 ${value.length} 项，内容已隐藏`;
      else if (value && typeof value === 'object') display = `对象，共 ${Object.keys(value).length} 个字段，内容已隐藏`;
      else if (value === null) display = 'null';
      let signature = null;
      // Never retain private field values. Large fields are deliberately not compared.
      try {
        const text = JSON.stringify(value);
        if (typeof text === 'string' && text.length <= MAX_HASH_BYTES && Buffer.byteLength(text) <= MAX_HASH_BYTES) signature = createHmac('sha256', secret).update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
      } catch {}
      return { name, type, display, signature };
    });
    return { fields, truncated: names.length > MAX_FIELDS, totalFields: names.length };
  }
  function compare(ingress, before, after) {
    const stages = [ingress, before, after];
    const names = [...new Set(stages.flatMap(stage => stage?.fields.map(field => field.name) || []))].sort();
    const maps = stages.map(stage => new Map(stage?.fields.map(field => [field.name, field]) || []));
    function change(left, right, name) {
      if (!stages[left] || !stages[right]) return 'unavailable';
      const a = maps[left].get(name), b = maps[right].get(name);
      if ((!a && stages[left].truncated) || (!b && stages[right].truncated)) return 'unknown';
      if (!a && !b) return 'same';
      if (!a) return 'added';
      if (!b) return 'removed';
      if (!a.signature || !b.signature) return 'unknown';
      return a.type === b.type && a.signature === b.signature ? 'same' : 'changed';
    }
    return {
      ingressAvailable: Boolean(ingress),
      stages: stages.map((stage, index) => ({ available: Boolean(stage), truncated: Boolean(stage?.truncated), totalFields: stage?.totalFields ?? 0, label: ['CCR 收到时', '扩展处理前', '扩展处理后'][index] })),
      rows: names.map(name => ({ name, values: maps.map((map, index) => {
        if (!stages[index]) return '未捕获';
        const field = map.get(name);
        return field ? field.display : stages[index].truncated ? '超出采集范围' : '（不存在）';
      }), conversion: change(0, 1, name), extension: change(1, 2, name) })),
      note: '第一栏在本扩展的请求入口采集，早于 CCR 路由与协议转换；扩展处理前可能已被路由、协议转换或更早的插件改写。第三栏不是供应商最终接收内容，后续处理仍可能继续修改。大字段和超出范围的字段不会猜测是否变化。',
    };
  }
  return { snapshot, compare };
}
module.exports = { createComparison };
