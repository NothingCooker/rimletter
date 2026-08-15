const { test } = require('node:test');
const assert = require('node:assert');
const { createSensors, defaultListMounts } = require('../src/main/sensors');

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

test('disk 返回各盘符 freeGB（用 fs.statfsSync，无子进程）', async () => {
  const fs = {
    existsSync: () => true,
    statfsSync: (root) => root === 'C:\\' ? { bavail: 8e9, bsize: 1, blocks: 1000, bfree: 500 } : { bavail: 2e11, bsize: 1, blocks: 1000, bfree: 500 }
  };
  const sensors = createSensors({ si: {}, fs, listDrives: () => ['C:\\', 'D:\\'] });
  const out = await sensors.disk.read();
  assert.equal(out[0].mount, 'C:');
  assert.equal(Math.round(out[0].freeGB), 8);
  assert.equal(Math.round(out[1].freeGB), 200);
});

test('disk 盘符不可访问时跳过（statfsSync 抛错）', async () => {
  const fs = { existsSync: () => true, statfsSync: () => { throw new Error('device not ready'); } };
  const sensors = createSensors({ si: {}, fs, listDrives: () => ['A:\\', 'B:\\'] });
  const out = await sensors.disk.read();
  assert.deepEqual(out, []);
});

test('gpu nvidia-smi 温度字段缺失时置 undefined', async () => {
  const execFile = async () => ({ stdout: '1, \r\n', stderr: '' });
  const sensors = createSensors({ si: {}, execFile });
  const out = await sensors.gpu.read();
  assert.equal(out.load, 1);
  assert.equal(out.temp, undefined);
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

test('gpu nvidia-smi 不可用且未配置 lhmPort 时返回无数据（不回退 si.graphics）', async () => {
  const execFile = async () => { throw new Error('ENOENT: nvidia-smi'); };
  let graphicsCalled = false;
  const si = { graphics: async () => { graphicsCalled = true; return { controllers: [] }; } };
  const sensors = createSensors({ si, execFile }); // 无 lhmPort → LHM 回退关闭
  const out = await sensors.gpu.read();
  assert.equal(out.temp, undefined);
  assert.equal(out.load, undefined);
  assert.equal(graphicsCalled, false, '不应调用 si.graphics（避免每 2s spawn 7 个 powershell）');
});

test('snapshot 注册 nvidia-gpu 传感器（主名）与 gpu 兼容别名', async () => {
  const execFile = async () => ({ stdout: '7, 55\r\n', stderr: '' });
  const sensors = createSensors({ si: {}, execFile });
  const snap = await sensors.snapshot(['nvidia-gpu', 'gpu']);
  assert.equal(snap['nvidia-gpu'].temp, 55);
  assert.equal(snap['nvidia-gpu'].load, 7);
  assert.equal(snap.gpu.temp, 55); // 别名同实现
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
  const si = {
    currentLoad: async () => { called.push('cpu'); return {}; },
    mem: async () => { called.push('mem'); return { total: 100, active: 50 }; }
  };
  const execFile = async () => { called.push('gpu'); return { stdout: '1, 42', stderr: '' }; };
  const fs = { existsSync: () => true, statfsSync: () => { called.push('disk'); return { bavail: 1, bsize: 1, blocks: 10, bfree: 5 }; } };
  const sensors = createSensors({ si, execFile, fs, listDrives: () => ['C:\\'] });
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

// ---- Linux 挂载点枚举（/proc/mounts）----

const PROC_MOUNTS =
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n' +
  'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0\n' +
  '/dev/sda2 / ext4 rw,relatime 0 0\n' +
  '/dev/sda2 /var/lib/docker/overlay2 ext4 rw,relatime 0 0\n' + // 同一设备 bind mount → 去重
  '/dev/nvme0n1p5 /home btrfs rw,relatime 0 0\n' +
  '/dev/loop3 /snap/core/xxx squashfs ro,nodev,relatime 0 0\n' + // loop 排除
  '/dev/zram0 /var/swap zram rw 0 0\n' +                          // zram 排除
  'tmpfs /run tmpfs rw,nosuid,nodev 0 0\n' +
  '192.168.1.5:/data /mnt/nfs nfs4 rw 0 0\n';                     // NFS 排除

function mountsFs(text) {
  return { readFileSync: (p) => { if (p === '/proc/mounts') return text; throw new Error('not found'); } };
}

test('defaultListMounts 只保留真实块设备挂载并排除 loop/zram/伪文件系统', () => {
  const mounts = defaultListMounts(mountsFs(PROC_MOUNTS));
  assert.deepEqual(mounts, ['/', '/home']);
});

test('defaultListMounts 对同一设备 bind mount 去重（保留首个目标）', () => {
  const text = '/dev/sda2 / ext4 rw 0 0\n/dev/sda2 /mnt/other ext4 rw 0 0\n';
  assert.deepEqual(defaultListMounts(mountsFs(text)), ['/']);
});

test('defaultListMounts /proc/mounts 读取失败时回退根挂载点', () => {
  assert.deepEqual(defaultListMounts({ readFileSync: () => { throw new Error('EACCES'); } }), ['/']);
});

test('defaultListMounts 无 /dev/ 挂载时回退根挂载点', () => {
  assert.deepEqual(defaultListMounts(mountsFs('proc /proc proc 0 0\ntmpfs /tmp tmpfs 0 0\n')), ['/']);
});

test('Linux 平台默认用 /proc/mounts 枚举磁盘（statfsSync 读挂载点）', async () => {
  const fs = {
    readFileSync: () => PROC_MOUNTS,
    statfsSync: (root) => ({ bavail: 8e9, bsize: 1, blocks: 1000, bfree: 500 })
  };
  const sensors = createSensors({ si: {}, fs, platform: 'linux' });
  const out = await sensors.disk.read();
  assert.equal(out[0].mount, '/');
  assert.equal(Math.round(out[0].freeGB), 8);
});

test('win32 平台默认仍用盘符枚举（不受平台分支影响）', async () => {
  const fs = {
    existsSync: (p) => p === 'C:\\',
    statfsSync: (root) => ({ bavail: 8e9, bsize: 1, blocks: 1000, bfree: 500 })
  };
  const sensors = createSensors({ si: {}, fs, platform: 'win32' });
  const out = await sensors.disk.read();
  assert.equal(out.length, 1);
  assert.equal(out[0].mount, 'C:');
});
