const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPlugins, normalizeConfig, getPluginConfig, emitPluginEvent } = require('../src/main/plugins');

function mkDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-')); }

test('加载插件并注入 api，注册规则/传感器生效', async () => {
  const dir = mkDir();
  fs.writeFileSync(path.join(dir, 'a.js'), `
    module.exports = async ({ api }) => {
      api.registerSensor('myApp', async () => ({ value: 42 }));
      api.registerRule({ id: 'p-a', sensor: 'myApp', metric: 'value', operator: '>', threshold: 40, severity: 'NegativeEvent', label: 'A', description: 'x', sound: 'auto', enabled: true });
    };
  `);
  const registry = { sensors: {}, rules: [] };
  const result = await loadPlugins({ pluginsDir: dir, apiFactory: makeApi(registry) });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'a');
  assert.ok(registry.sensors.myApp);
  assert.equal(registry.rules.length, 1);
});

test('filter 参数可跳过指定插件', async () => {
  const dir = mkDir();
  fs.writeFileSync(path.join(dir, 'a.js'), `module.exports = async ({ api }) => { api.registerRule({ id: 'a', label: 'A' }); };`);
  fs.writeFileSync(path.join(dir, 'b.js'), `module.exports = async ({ api }) => { api.registerRule({ id: 'b', label: 'B' }); };`);
  const registry = { rules: [] };
  const result = await loadPlugins({ pluginsDir: dir, apiFactory: makeApi(registry), filter: name => name !== 'b' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'a');
  assert.equal(registry.rules[0].id, 'a');
});

test('插件抛错不崩溃，错误被记录', async () => {
  const dir = mkDir();
  fs.writeFileSync(path.join(dir, 'bad.js'), `module.exports = async () => { throw new Error('boom'); };`);
  const result = await loadPlugins({ pluginsDir: dir, apiFactory: () => ({}) });
  assert.equal(result.length, 1);
  assert.equal(result[0].error, 'boom');
});

test('normalizeConfig 缺键填默认、剔除未知键', () => {
  const schema = { fields: [{ key: 'h', label: '小时', type: 'number', default: 23 }] };
  assert.deepEqual(normalizeConfig(schema, { extra: 1 }), { h: 23 });
});

test('normalizeConfig 各类型归一', () => {
  const schema = { fields: [
    { key: 'n', label: '数', type: 'number', default: 5, min: 0, max: 10 },
    { key: 'b', label: '开', type: 'bool', default: false },
    { key: 's', label: '选', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' },
    { key: 't', label: '文', type: 'text', default: 'x' },
    { key: 'sl', label: '滑', type: 'slider', default: 50, min: 0, max: 100 }
  ]};
  const out = normalizeConfig(schema, { n: 99, b: 1, s: 'z', t: 'y', sl: 150 });
  assert.deepEqual(out, { n: 10, b: true, s: 'a', t: 'y', sl: 100 });
});

test('normalizeConfig 非法 schema 抛错', () => {
  assert.throws(() => normalizeConfig({ fields: [] }, {}), /fields 必须是非空数组/);
  assert.throws(() => normalizeConfig({ fields: [{ key: 'x', label: 'X', type: 'color' }] }, {}), /类型不支持/);
  assert.throws(() => normalizeConfig({ fields: [{ key: 's', label: '滑', type: 'slider' }] }, {}), /需 min\/max/);
});

test('normalizeConfig 支持 button 字段（无存储值）', () => {
  const schema = { fields: [
    { key: 'n', label: '数', type: 'number', default: 5 },
    { key: 'b', label: '测', type: 'button', buttonText: '测试' }
  ]};
  const out = normalizeConfig(schema, { n: 3 });
  assert.equal(out.n, 3);
  assert.equal(out.b, undefined); // button 字段不产生存储值
});

test('getPluginConfig 合并默认值与存储值；无 schema 返回 null', () => {
  const schema = { fields: [
    { key: 'h', label: '小时', type: 'number', default: 23 },
    { key: 'b', label: '开', type: 'bool', default: true }
  ]};
  assert.deepEqual(getPluginConfig(schema, { h: 22 }), { h: 22, b: true });
  assert.deepEqual(getPluginConfig(schema, {}), { h: 23, b: true });
  assert.equal(getPluginConfig(null, {}), null);
});

test('emitPluginEvent 触发订阅回调，单插件抛错不影响其它，未订阅事件不触发', () => {
  const calls = [];
  const handlers = {
    a: { alert: [p => calls.push('a:' + p.id)] },
    b: { alert: [() => { throw new Error('boom'); }, p => calls.push('b:' + p.id)] },
    c: { config: [() => calls.push('c-config')] } // 非 alert 事件不应触发
  };
  emitPluginEvent(handlers, 'alert', { id: 1 });
  assert.deepEqual(calls, ['a:1', 'b:1']);
  emitPluginEvent(undefined, 'alert', {}); // 无 handlers 不崩
  emitPluginEvent(handlers, 'config', { v: 1 }); // 走 config 通道
  assert.deepEqual(calls, ['a:1', 'b:1', 'c-config']);
});

test('插件注册配置表单 schema 被记录', async () => {
  const dir = mkDir();
  fs.writeFileSync(path.join(dir, 'c.js'), `
    module.exports = async ({ api }) => {
      api.registerConfig({ fields: [{ key: 'h', label: '小时', type: 'number', default: 23 }] });
    };
  `);
  const registry = { configs: {} };
  const result = await loadPlugins({ pluginsDir: dir, apiFactory: makeApi(registry) });
  assert.equal(result.length, 1);
  assert.equal(registry.configs.c.fields[0].key, 'h');
});

function makeApi(registry) {
  return (name) => ({
    registerSensor(n, fn) { registry.sensors[n] = fn; },
    registerRule(r) { registry.rules.push(r); },
    registerConfig(s) { registry.configs[name] = s; },
    getConfig() { return getPluginConfig(registry.configs[name] || null, {}); },
    letter() {}, on() {}, getState: async () => ({}), setInterval() {},
    logger: { info() {}, warn() {}, error() {} }
  });
}
