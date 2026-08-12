const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateRules, neededSensors } = require('../src/main/rules');

const T0 = 1_000_000;
const mkCpuRule = (id, threshold, durationMs = 0) => ({
  id, sensor: 'cpu', metric: 'load', operator: '>', threshold,
  durationMs, severity: 'ThreatBig', label: 'CPU 过高', description: 'x', sound: 'auto', enabled: true
});

test('瞬时超过阈值（durationMs=0）立即告警', () => {
  const rules = [mkCpuRule('r1', 85, 0)];
  const snap = { cpu: { load: 90 } };
  const out = evaluateRules(rules, snap, {}, T0);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].ruleId, 'r1');
  assert.equal(out.recoveries.length, 0);
  assert.equal(out.nextState.r1.status, 'alerting');
});

test('持续时长未满不告警', () => {
  const rules = [mkCpuRule('r1', 85, 5000)];
  const snap = { cpu: { load: 90 } };
  const out = evaluateRules(rules, snap, {}, T0);
  assert.equal(out.alerts.length, 0);
  assert.equal(out.nextState.r1.status, 'watching');
});

test('持续时长满 5 秒后告警', () => {
  const rules = [mkCpuRule('r1', 85, 5000)];
  const prev = { r1: { status: 'watching', since: T0 - 6000 } };
  const out = evaluateRules(rules, { cpu: { load: 90 } }, prev, T0);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.nextState.r1.status, 'alerting');
});

test('告警后回落触发 recovery，且不重复告警', () => {
  const rules = [mkCpuRule('r1', 85, 0)];
  const prev = { r1: { status: 'alerting', since: T0 - 2000 } };
  const out = evaluateRules(rules, { cpu: { load: 50 } }, prev, T0);
  assert.equal(out.alerts.length, 0);
  assert.equal(out.recoveries.length, 1);
  assert.equal(out.nextState.r1.status, 'idle');
});

test('已告警且仍在超限时不再重复告警', () => {
  const rules = [mkCpuRule('r1', 85, 0)];
  const prev = { r1: { status: 'alerting', since: T0 - 2000 } };
  const out = evaluateRules(rules, { cpu: { load: 95 } }, prev, T0);
  assert.equal(out.alerts.length, 0);
  assert.equal(out.nextState.r1.status, 'alerting');
});

test('disabled 规则不评估', () => {
  const rules = [{ ...mkCpuRule('r1', 85, 0), enabled: false }];
  const out = evaluateRules(rules, { cpu: { load: 95 } }, {}, T0);
  assert.equal(out.alerts.length, 0);
});

test('缺失传感器值（undefined）不评估、不崩溃', () => {
  const rules = [mkCpuRule('r1', 85, 0)];
  const out = evaluateRules(rules, { cpu: { load: undefined } }, {}, T0);
  assert.equal(out.alerts.length, 0);
});

test('磁盘规则对每个盘符求值，告警含 mount', () => {
  const rules = [{ id: 'd1', sensor: 'disk', metric: 'freeGB', operator: '<', threshold: 10, durationMs: 0, severity: 'NeutralEvent', label: '磁盘不足', description: 'x', sound: 'auto', enabled: true }];
  const snap = { disk: [{ mount: 'C:', freeGB: 8 }, { mount: 'D:', freeGB: 200 }] };
  const out = evaluateRules(rules, snap, {}, T0);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].mount, 'C:');
});

test('neededSensors 只收集已启用规则引用的传感器（去重、保序）', () => {
  const rules = [
    mkCpuRule('r1', 85, 0),
    { ...mkCpuRule('r2', 90, 0) }, // 与 r1 同 sensor：去重
    { id: 'g1', sensor: 'gpu', metric: 'temp', operator: '>', threshold: 85, durationMs: 0, severity: 'ThreatSmall', label: '显卡过热', description: 'x', sound: 'auto', enabled: true },
    { ...mkCpuRule('r3', 85, 0), enabled: false } // disabled 不计入
  ];
  assert.deepEqual(neededSensors(rules), ['cpu', 'gpu']);
});

test('neededSensors 无启用规则时返回空数组', () => {
  const rules = [{ ...mkCpuRule('r1', 85, 0), enabled: false }];
  assert.deepEqual(neededSensors(rules), []);
});
