// src/main/plugins.js
const fs = require('node:fs');
const path = require('node:path');

const FIELD_TYPES = ['text', 'number', 'bool', 'select', 'slider', 'button'];

function assertSchema(schema) {
  if (!schema || typeof schema !== 'object') throw new Error('registerConfig: schema 必须是对象');
  if (!Array.isArray(schema.fields) || schema.fields.length === 0) throw new Error('registerConfig: fields 必须是非空数组');
  const seen = new Set();
  for (const f of schema.fields) {
    if (!f || typeof f !== 'object') throw new Error('registerConfig: 字段必须是对象');
    if (typeof f.key !== 'string' || !f.key) throw new Error('registerConfig: 字段缺 key');
    if (seen.has(f.key)) throw new Error('registerConfig: 字段 key 重复: ' + f.key);
    seen.add(f.key);
    if (typeof f.label !== 'string' || !f.label) throw new Error('registerConfig: 字段 ' + f.key + ' 缺 label');
    if (!FIELD_TYPES.includes(f.type)) throw new Error('registerConfig: 字段 ' + f.key + ' 类型不支持: ' + f.type);
    if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) throw new Error('registerConfig: select 字段 ' + f.key + ' 需非空 options');
    if (f.type === 'slider' && (typeof f.min !== 'number' || typeof f.max !== 'number')) throw new Error('registerConfig: slider 字段 ' + f.key + ' 需 min/max');
  }
}

function coerceField(f, value) {
  if (value === undefined || value === null || value === '') return f.default;
  switch (f.type) {
    case 'number':
    case 'slider': {
      const n = Number(value);
      if (Number.isNaN(n)) return f.default;
      let v = n;
      if (typeof f.min === 'number' && v < f.min) v = f.min;
      if (typeof f.max === 'number' && v > f.max) v = f.max;
      return v;
    }
    case 'bool': return !!value;
    case 'select': return (f.options || []).some(o => o.value === value) ? value : f.default;
    case 'text': return String(value);
    default: return f.default;
  }
}

// 类型归一：缺键填默认、剔除 schema 外键、各类型转换/clamp
function normalizeConfig(schema, values) {
  assertSchema(schema);
  const out = {};
  for (const f of schema.fields) out[f.key] = coerceField(f, values ? values[f.key] : undefined);
  return out;
}

// 插件配置实际值（schema 默认值 ∪ 存储值）；无 schema 返回 null
function getPluginConfig(schema, stored) {
  if (!schema) return null;
  return normalizeConfig(schema, stored || {});
}

async function loadPlugins({ pluginsDir, apiFactory, filter }) {
  const results = [];
  if (!fs.existsSync(pluginsDir)) return results;
  const files = fs.readdirSync(pluginsDir)
    .filter(f => f.endsWith('.js'))
    .filter(f => !filter || filter(path.basename(f, '.js')));
  for (const file of files) {
    const name = path.basename(file, '.js');
    const fullPath = path.join(pluginsDir, file);
    const entry = { name, file, error: null, loaded: false };
    try {
      delete require.cache[require.resolve(fullPath)];
      const mod = require(fullPath);
      if (typeof mod !== 'function' && typeof mod !== 'object') throw new Error('plugin must export a function or object');
      const fn = typeof mod === 'function' ? mod : mod.load;
      if (typeof fn !== 'function') throw new Error('plugin must export a function or a { load } function');
      const api = apiFactory(name);
      // 插件签名：async ({ api, logger }) => {} —— 传入上下文对象
      const ctx = {
        api,
        logger: {
          info: (...a) => console.log(`[plugin:${name}]`, ...a),
          warn: (...a) => console.warn(`[plugin:${name}]`, ...a),
          error: (...a) => console.error(`[plugin:${name}]`, ...a)
        }
      };
      await fn(ctx);
      entry.loaded = true;
    } catch (e) {
      entry.error = String(e.message || e);
    }
    results.push(entry);
  }
  return results;
}

// 派发插件订阅事件（api.on(event, cb) 注册的回调，见 main.js registry.pluginConfigHandlers）。
// handlers 结构：{ [pluginName]: { [event]: [cb, ...] } }。单个插件回调抛错不影响其它插件，
// 与 setPluginConfig 里 config 事件的逐个 try/catch 处理一致。
function emitPluginEvent(handlers, event, payload) {
  if (!handlers) return;
  for (const m of Object.values(handlers)) {
    for (const cb of (m[event] || [])) {
      try { cb(payload); } catch (e) { /* 单插件报错不拖垮事件总线 */ }
    }
  }
}

module.exports = { loadPlugins, FIELD_TYPES, assertSchema, normalizeConfig, getPluginConfig, emitPluginEvent };
