const { test } = require('node:test');
const assert = require('node:assert');
const { createMonitor } = require('../src/main/monitor');

test('tick 一次：触发告警并回调 onEvent', async () => {
  const sensors = { snapshot: async () => ({ cpu: { load: 99 }, mem: { usedPct: 10 }, disk: [], gpu: {} }) };
  const rules = [{ id: 'r1', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 0, severity: 'ThreatBig', label: 'CPU', description: 'x', sound: 'auto', enabled: true }];
  const events = [];
  const monitor = createMonitor({ sensors, rules, onEvent: e => events.push(e) });
  const result = await monitor.tick();
  assert.equal(result.alerts.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'alert');
});

test('tick 恢复事件含 recovery', async () => {
  let high = true; // 先高后低：第一次 tick 告警，第二次恢复
  const sensors = { snapshot: async () => ({ cpu: { load: high ? 99 : 10 }, mem: { usedPct: 10 }, disk: [], gpu: {} }) };
  const rules = [{ id: 'r1', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 0, severity: 'ThreatBig', label: 'CPU', description: 'x', sound: 'auto', enabled: true }];
  const events = [];
  const monitor = createMonitor({ sensors, rules, onEvent: e => events.push(e) });
  await monitor.tick(); // alert
  high = false;
  await monitor.tick(); // recovery
  assert.equal(events.filter(e => e.type === 'alert').length, 1);
  assert.equal(events.filter(e => e.type === 'recovery').length, 1);
});

test('recoveriesEnabled=false：不广播恢复事件（状态仍复位，可再次告警）', async () => {
  let high = true;
  const sensors = { snapshot: async () => ({ cpu: { load: high ? 99 : 10 }, mem: { usedPct: 10 }, disk: [], gpu: {} }) };
  const rules = [{ id: 'r1', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 0, severity: 'ThreatBig', label: 'CPU', description: 'x', sound: 'auto', enabled: true }];
  const events = [];
  const monitor = createMonitor({ sensors, rules, onEvent: e => events.push(e), recoveriesEnabled: () => false });
  await monitor.tick(); // alert
  high = false;
  await monitor.tick(); // 值回落后恢复事件被抑制
  assert.equal(events.filter(e => e.type === 'alert').length, 1);
  assert.equal(events.filter(e => e.type === 'recovery').length, 0);
  // 状态仍复位：再次回到高位可重新告警
  high = true;
  await monitor.tick();
  assert.equal(events.filter(e => e.type === 'alert').length, 2);
});

test('snapshot 抛错时回调 onError（不崩溃）', async () => {
  const sensors = { snapshot: async () => { throw new Error('sensor down'); } };
  const rules = [];
  const errors = [];
  const monitor = createMonitor({ sensors, rules, onEvent: () => {}, onError: e => errors.push(e) });
  await monitor.tick();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /sensor down/);
});

test('tick 只把已启用规则引用的传感器传给 snapshot', async () => {
  const calls = [];
  const sensors = { snapshot: async (keys) => { calls.push(keys); return { cpu: { load: 99 } }; } };
  const rules = [{ id: 'r1', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 0, severity: 'ThreatBig', label: 'CPU', description: 'x', sound: 'auto', enabled: true }];
  const monitor = createMonitor({ sensors, rules, onEvent: () => {} });
  await monitor.tick();
  assert.deepEqual(calls[0], ['cpu']);
});

test('tick 无启用规则时传空数组、不读任何传感器', async () => {
  const calls = [];
  const sensors = { snapshot: async (keys) => { calls.push(keys); return {}; } };
  const rules = [{ id: 'r1', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 0, severity: 'ThreatBig', label: 'CPU', description: 'x', sound: 'auto', enabled: false }];
  const monitor = createMonitor({ sensors, rules, onEvent: () => {} });
  const result = await monitor.tick();
  assert.deepEqual(calls[0], []);
  assert.equal(result.alerts.length, 0);
});

test('start/stop 起停轮询，stop 后不再回调', async () => {
  const sensors = { snapshot: async () => ({ cpu: { load: 99 }, mem: { usedPct: 10 }, disk: [], gpu: {} }) };
  const rules = [];
  let count = 0;
  const monitor = createMonitor({ sensors, rules, onEvent: () => count++ });
  monitor.start();
  await new Promise(r => setTimeout(r, 300));
  monitor.stop();
  const after = count;
  await new Promise(r => setTimeout(r, 300));
  assert.equal(count, after);
});
