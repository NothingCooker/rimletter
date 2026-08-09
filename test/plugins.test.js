const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPlugins } = require('../src/main/plugins');

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

test('插件抛错不崩溃，错误被记录', async () => {
  const dir = mkDir();
  fs.writeFileSync(path.join(dir, 'bad.js'), `module.exports = async () => { throw new Error('boom'); };`);
  const result = await loadPlugins({ pluginsDir: dir, apiFactory: () => ({}) });
  assert.equal(result.length, 1);
  assert.equal(result[0].error, 'boom');
});

function makeApi(registry) {
  return () => ({
    registerSensor(name, fn) { registry.sensors[name] = fn; },
    registerRule(r) { registry.rules.push(r); },
    letter() {}, on() {}, getState: async () => ({}), setInterval() {},
    logger: { info() {}, warn() {}, error() {} }
  });
}
