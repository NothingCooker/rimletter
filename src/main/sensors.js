// src/main/sensors.js
const nodeFs = require('node:fs');

// 枚举 Windows 盘符（A:-\Z:\），只保留可访问的根路径。无子进程。
function defaultListDrives(fs) {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(root)) drives.push(root); } catch { /* 不可访问的盘符跳过 */ }
  }
  return drives;
}

function createSensors({ si, execFile, extraSensors, fs = nodeFs, listDrives } = {}) {
  const drives = listDrives || (() => defaultListDrives(fs));
  const cpu = {
    name: 'CPU',
    async read() {
      const l = await si.currentLoad();
      return { load: l.currentLoad };
    }
  };
  const mem = {
    name: '内存',
    async read() {
      const m = await si.mem();
      const used = m.active || m.used || 0;
      const total = m.total || 1;
      return { usedPct: (used / total) * 100 };
    }
  };
  const disk = {
    name: '磁盘',
    // 用 fs.statfsSync 替代 si.fsSize()：后者在 Windows 上每次轮询 spawn 2 个 powershell
    // （Get-CimInstance Win32_LogicalDisk + Get-WmiObject diskdrive）。实测 statfsSync 的
    // freeGB/usedPct 与 fsSize 完全一致，且零子进程（v0.4.1 修复高 CPU + powershell 堆积）。
    async read() {
      const out = [];
      for (const root of drives()) {
        try {
          const s = fs.statfsSync(root);
          const mount = root.replace(/\\$/, '');
          out.push({
            mount,
            fs: mount,
            freeGB: (s.bavail * s.bsize) / 1e9,
            usedPct: s.blocks > 0 ? ((s.blocks - s.bfree) / s.blocks) * 100 : 0
          });
        } catch { /* 盘符存在但暂不可访问（如无碟光驱）跳过 */ }
      }
      return out;
    }
  };
  const gpu = {
    name: 'GPU',
    // 仅 NVIDIA：异步 nvidia-smi 直查（不阻塞事件循环）。非 NVIDIA → 无 GPU 数据。
    // 不回退 si.graphics()：它在 Windows 上每次 spawn 7 个 powershell（Get-CimInstance
    // win32_VideoController/desktopmonitor/WmiMonitor 等），无独显机每 2s 轮询一轮 → 子进程
    // 堆积 + 高 CPU（v0.4.1 修复）。GPU 温度/占用仅支持 NVIDIA（设置页已注明）。
    async read() {
      if (execFile) {
        try {
          const out = await execFile('nvidia-smi',
            ['--query-gpu=utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'],
            { encoding: 'utf8', windowsHide: true });
          // promisify(execFile) 解析为 { stdout, stderr }；兼容直接返回字符串的 mock
          const raw = (out && typeof out === 'object' && 'stdout' in out) ? out.stdout : out;
          const first = String(raw).trim().split('\n')[0] || '';
          const [load, temp] = first.split(',').map(s => parseFloat(String(s).trim()));
          return {
            temp: Number.isFinite(temp) ? temp : undefined,
            load: Number.isFinite(load) ? load : undefined
          };
        } catch {
          // nvidia-smi 缺失/查询失败 → 无 GPU 数据（不回退 si.graphics）
        }
      }
      return { temp: undefined, load: undefined };
    }
  };
  // 派发表：内置 + 插件（extraSensors 返回 {name → {read}}）。
  // v0.3.1 修复：插件 registerSensor 的传感器此前进不了 snapshot 的 map → 规则永不触发。
  function buildMap() {
    const map = { cpu: () => cpu.read(), mem: () => mem.read(), disk: () => disk.read(), gpu: () => gpu.read() };
    if (typeof extraSensors === 'function') {
      for (const [name, s] of Object.entries(extraSensors())) {
        if (s && typeof s.read === 'function') map[name] = () => s.read();
      }
    }
    return map;
  }
  // keys 可选：传入时只读这些传感器（轮询按规则按需读取）；缺省读全部（含插件）。
  // 未知传感器（如已卸载插件的残留规则）返回 undefined，规则引擎对其安全跳过。
  async function snapshot(keys) {
    const map = buildMap();
    const wanted = keys == null ? Object.keys(map) : keys;
    const results = await Promise.all(wanted.map(k => (map[k] ? map[k]().catch(() => undefined) : undefined)));
    const out = {};
    wanted.forEach((k, i) => { out[k] = results[i]; });
    return out;
  }
  return { cpu, mem, disk, gpu, snapshot };
}

module.exports = { createSensors };
