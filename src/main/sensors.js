// src/main/sensors.js
function createSensors({ si }) {
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
    async read() {
      const g = await si.graphics();
      const c = g.controllers && g.controllers[0];
      return {
        temp: typeof c?.temperatureGpu === 'number' ? c.temperatureGpu : undefined,
        load: typeof c?.utilizationGpu === 'number' ? c.utilizationGpu : undefined
      };
    }
  };
  async function snapshot() {
    const [c, m, d, g] = await Promise.all([cpu.read(), mem.read(), disk.read(), gpu.read()]);
    return { cpu: c, mem: m, disk: d, gpu: g };
  }
  return { cpu, mem, disk, gpu, snapshot };
}

module.exports = { createSensors };
