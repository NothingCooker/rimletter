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
