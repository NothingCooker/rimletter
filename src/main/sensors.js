// src/main/sensors.js
function createSensors({ si, execFile }) {
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
    async read() {
      const list = await si.fsSize();
      return list.map(d => ({
        mount: d.mount,
        fs: d.fs,
        freeGB: d.available / 1e9,
        usedPct: typeof d.use === 'number' ? d.use : 0
      }));
    }
  };
  const gpu = {
    name: 'GPU',
    // systeminformation 的 graphics() 在 Windows 上内部用 execSync 同步跑 nvidia-smi + WMI 枚举，
    // 实测每次调用墙钟 ~0.5s，其中约 100ms 是主进程事件循环的同步冻结；而监控每 pollIntervalMs
    // （默认 2s）轮询一次 → 周期性硬冻结，表现为「鼠标时不时卡一下但占用不高」（混合显卡笔记本
    // 上 nvidia-smi 更慢、更明显）。故快速路径改为异步 execFile 直查所需两个字段，不阻塞事件循环；
    // nvidia-smi 不可用（非 NVIDIA）时回退 si.graphics()。
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
          // nvidia-smi 缺失/查询失败 → 回退下方 systeminformation 路径
        }
      }
      const g = await si.graphics();
      const c = g.controllers && g.controllers[0];
      return {
        temp: typeof c?.temperatureGpu === 'number' ? c.temperatureGpu : undefined,
        load: typeof c?.utilizationGpu === 'number' ? c.utilizationGpu : undefined
      };
    }
  };
  const BASE_SENSORS = ['cpu', 'mem', 'disk', 'gpu'];
  // keys 可选：传入时只读取这些传感器（轮询按规则按需读取，避免无谓开销）；
  // 不传时保持原有行为，读取全部基础传感器（on-demand 调用，如设置页/API/插件 getState）。
  // 未知传感器（如插件传感器）返回 undefined，规则引擎对其安全跳过。
  async function snapshot(keys) {
    const map = { cpu: () => cpu.read(), mem: () => mem.read(), disk: () => disk.read(), gpu: () => gpu.read() };
    const wanted = keys == null ? BASE_SENSORS : keys;
    const results = await Promise.all(wanted.map(k => (map[k] ? map[k]() : undefined)));
    const out = {};
    wanted.forEach((k, i) => { out[k] = results[i]; });
    return out;
  }
  return { cpu, mem, disk, gpu, snapshot };
}

module.exports = { createSensors };
