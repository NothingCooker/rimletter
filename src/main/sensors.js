// src/main/sensors.js
function createSensors({ si, execFile, extraSensors }) {
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
