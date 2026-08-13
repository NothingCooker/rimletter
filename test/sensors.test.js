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

test('gpu 用异步 nvidia-smi 快速路径读取（不依赖 si.graphics、不阻塞事件循环）', async () => {
  // promisify(execFile) 实际解析为 { stdout, stderr }，mock 贴合生产返回形状
  const execFile = async (file, args) => { assert.equal(file, 'nvidia-smi'); return { stdout: '1, 42\r\n', stderr: '' }; };
  const sensors = createSensors({ si: {}, execFile });
  const out = await sensors.gpu.read();
  assert.equal(out.load, 1);
  assert.equal(out.temp, 42);
});

test('gpu nvidia-smi 输出多行时只取第一块 GPU', async () => {
  const execFile = async () => ({ stdout: '5, 61\n3, 52\n', stderr: '' });
  const sensors = createSensors({ si: {}, execFile });
  const out = await sensors.gpu.read();
  assert.equal(out.load, 5);
  assert.equal(out.temp, 61);
});

test('gpu nvidia-smi 不可用时回退 si.graphics（温度缺失置 undefined）', async () => {
  const execFile = async () => { throw new Error('ENOENT: nvidia-smi'); };
  const si = { graphics: async () => ({ controllers: [{ temperatureGpu: null, utilizationGpu: 77 }] }) };
  const sensors = createSensors({ si, execFile });
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

test('snapshot(keys) 只读取指定传感器，其余不读', async () => {
  const called = [];
  const mk = name => async () => { called.push(name); return {}; };
  const mock = { currentLoad: mk('cpu'), mem: mk('mem'), fsSize: mk('disk'), graphics: mk('gpu') };
  const sensors = createSensors({ si: mock });
  const snap = await sensors.snapshot(['cpu', 'gpu']);
  assert.deepEqual(called, ['cpu', 'gpu']);
  assert.deepEqual(Object.keys(snap).sort(), ['cpu', 'gpu']);
});

test('snapshot(keys) 未知传感器（如插件传感器）返回 undefined，规则安全跳过', async () => {
  const mock = { currentLoad: async () => ({}), mem: async () => ({}), fsSize: async () => ([]), graphics: async () => ({}) };
  const sensors = createSensors({ si: mock });
  const snap = await sensors.snapshot(['cpu', 'unknown-plugin-sensor']);
  assert.ok('cpu' in snap);
  assert.equal(snap['unknown-plugin-sensor'], undefined);
});

test('snapshot 全量路径包含插件传感器（extraSensors）', async () => {
  const mock = { currentLoad: async () => ({ load: 1 }), mem: async () => ({}), fsSize: async () => ([]), graphics: async () => ({}) };
  const extra = () => ({ 'cpu-temp': { name: 'cpu-temp', read: async () => ({ temp: 52, maxCore: 61 }) } });
  const sensors = createSensors({ si: mock, extraSensors: extra });
  const snap = await sensors.snapshot();
  assert.deepEqual(snap['cpu-temp'], { temp: 52, maxCore: 61 });
});

test('snapshot(keys) 按需轮询插件传感器', async () => {
  const mock = { currentLoad: async () => ({ load: 1 }), mem: async () => ({}), fsSize: async () => ([]), graphics: async () => ({}) };
  const extra = () => ({ 'cpu-temp': { name: 'cpu-temp', read: async () => ({ temp: 52 }) } });
  const sensors = createSensors({ si: mock, extraSensors: extra });
  const snap = await sensors.snapshot(['cpu-temp']);
  assert.equal(snap['cpu-temp'].temp, 52);
});

test('snapshot(keys) 未注册传感器（extraSensors 不含）返回 undefined 且不报错', async () => {
  const mock = { currentLoad: async () => ({ load: 1 }), mem: async () => ({}), fsSize: async () => ([]), graphics: async () => ({}) };
  const sensors = createSensors({ si: mock, extraSensors: () => ({}) });
  const snap = await sensors.snapshot(['ghost']);
  assert.equal(snap['ghost'], undefined);
});

test('snapshot(keys) 只请求内置传感器时不轮询插件传感器', async () => {
  const called = [];
  const mock = { currentLoad: async () => { called.push('cpu'); return { load: 1 }; }, mem: async () => ({}), fsSize: async () => ([]), graphics: async () => ({}) };
  const extra = () => ({ 'cpu-temp': { name: 'cpu-temp', read: async () => { called.push('cpu-temp'); return { temp: 52 }; } } });
  const sensors = createSensors({ si: mock, extraSensors: extra });
  await sensors.snapshot(['cpu']);
  assert.deepEqual(called, ['cpu']);
});

test('snapshot(keys) 插件传感器 read 抛错时该传感器降级为 undefined，不拖垮整个快照', async () => {
  const mock = { currentLoad: async () => ({ currentLoad: 1 }), mem: async () => ({}), fsSize: async () => ([]), graphics: async () => ({}) };
  const extra = () => ({ 'bad': { name: 'bad', read: async () => { throw new Error('boom'); } } });
  const sensors = createSensors({ si: mock, extraSensors: extra });
  const snap = await sensors.snapshot(['cpu', 'bad']);
  assert.equal(snap.cpu.load, 1);
  assert.equal(snap.bad, undefined);
});
