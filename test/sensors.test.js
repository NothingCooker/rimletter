const { test } = require('node:test');
const assert = require('node:assert');
const { createSensors } = require('../src/main/sensors');

test('cpu 读取当前负载百分比', async () => {
  const mock = { currentLoad: async () => ({ currentLoad: 88.5 }) };
  const sensors = createSensors({ si: mock });
  const out = await sensors.cpu.read();
  assert.equal(out.load, 88.5);
});

test('mem 读取占用率', async () => {
  const mock = { mem: async () => ({ total: 1000, active: 910 }) };
  const sensors = createSensors({ si: mock });
  const out = await sensors.mem.read();
  assert.equal(out.usedPct, 91);
});

test('disk 返回各盘符 freeGB', async () => {
  const mock = { fsSize: async () => ([{ mount: 'C:', available: 8e9 }, { mount: 'D:', available: 2e11 }]) };
  const sensors = createSensors({ si: mock });
  const out = await sensors.disk.read();
  assert.equal(out[0].mount, 'C:');
  assert.equal(Math.round(out[0].freeGB), 8);
});

test('gpu 读取温度与占用（温度可缺失时置 undefined）', async () => {
  const mock = { graphics: async () => ({ controllers: [{ temperatureGpu: null, utilizationGpu: 77 }] }) };
  const sensors = createSensors({ si: mock });
  const out = await sensors.gpu.read();
  assert.equal(out.temp, undefined);
  assert.equal(out.load, 77);
});

test('sensors 提供 snapshot 接口，返回全部传感器值', async () => {
  const mock = {
    currentLoad: async () => ({ currentLoad: 10 }),
    mem: async () => ({ total: 100, active: 50 }),
    fsSize: async () => ([]),
    graphics: async () => ({ controllers: [] })
  };
  const sensors = createSensors({ si: mock });
  const snap = await sensors.snapshot();
  assert.equal(snap.cpu.load, 10);
  assert.equal(snap.mem.usedPct, 50);
  assert.ok(Array.isArray(snap.disk));
  assert.ok(snap.gpu);
});
