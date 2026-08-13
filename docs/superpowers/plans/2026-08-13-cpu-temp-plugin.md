# CPU 测温官方插件 + v0.3.1 插件传感器链路修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「CPU 温度监控」官方插件（数据源 LibreHardwareMonitor），并修复 v0.3.0 的插件传感器链路 bug（插件 `registerSensor` 的传感器不被轮询/不进规则下拉），发 v0.3.1。

**Architecture:** 主程序侧修 `sensors.js` 的 `snapshot()` 使其派发内置 + 插件传感器（经 `extraSensors` 注入），渲染层规则编辑器从 `getState()` 快照推断插件传感器与指标；official-plugins 仓库新增 `plugin-cpu-temp`，插件用 `registerSensor` 注册 `cpu-temp` 传感器（解析 LHM `data.json`）+ `registerRule` 注册两条默认规则 + `registerConfig` 提供配置表单。

**Tech Stack:** Electron（主进程 Node）/ systeminformation / 渲染层原生 JS / node:test（主仓库与插件测试均零额外依赖）/ LibreHardwareMonitor（外部数据源，仅 Web API 轮询）。

**两个工作目录：**
- 主仓库：`D:\claudeswork\RIM DESKTOP`（master 分支）
- 官方插件仓库：`D:\claudeswork\official-plugin`（main 分支，独立 git 仓库）

**规格：** `docs/superpowers/specs/2026-08-13-cpu-temp-plugin-design.md`

---

## Phase A：主程序修复（v0.3.1）— 工作目录 `D:\claudeswork\RIM DESKTOP`

### Task 1: sensors.js — `snapshot()` 派发内置 + 插件传感器（TDD）

**Files:**
- Modify: `src/main/sensors.js`（重写 `snapshot` 与返回值）
- Test: `test/sensors.test.js`

- [ ] **Step 1: 写失败测试** — 在 `test/sensors.test.js` 末尾追加 3 个用例（贴在现有第 92 行后）：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sensors.test.js`
Expected: 3 个新用例 FAIL（`snapshot['cpu-temp']` 为 `undefined`），原有用例 PASS。

- [ ] **Step 3: 实现** — 重写 `src/main/sensors.js`。把 `snapshot` 的派发表改为「内置 + extraSensors 合并」：

```js
function createSensors({ si, execFile, extraSensors }) {
  const cpu = { ... };   // 原 cpu 定义不变
  const mem = { ... };   // 原 mem 定义不变
  const disk = { ... };  // 原 disk 定义不变
  const gpu = { ... };   // 原 gpu 定义不变
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
    const results = await Promise.all(wanted.map(k => (map[k] ? map[k]() : undefined)));
    const out = {};
    wanted.forEach((k, i) => { out[k] = results[i]; });
    return out;
  }
  return { cpu, mem, disk, gpu, snapshot };
}
```

注意：删除不再使用的 `BASE_SENSORS` 常量；`cpu/mem/disk/gpu` 四个对象体保持原样（gpu 的 nvidia-smi 异步快速路径不动）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/sensors.test.js`
Expected: 全部 PASS（含原有 8 个用例）。

- [ ] **Step 5: 提交**

```bash
git add test/sensors.test.js src/main/sensors.js
git commit -m "fix: snapshot 派发插件传感器，修复插件 registerSensor 不被轮询"
```

### Task 2: main.js — 注入 `extraSensors`

**Files:**
- Modify: `src/main/main.js:46-56`（`getSensors`）

- [ ] **Step 1: 改 `getSensors()`** — 现有函数体：

```js
function getSensors() {
  const si = require('systeminformation');
  return createSensors({ si, execFile: execFileAsync, extraSensors: () => registry.sensors });
}
```

（删除原 `const base = createSensors(...)` + 手动把 `registry.sensors` 展开进 `merged` 的循环——`snapshot` 已通过 `extraSensors` 读到插件传感器，`merged[name]` 直接访问也无处使用。）

- [ ] **Step 2: 跑既有测试防回归**

Run: `node --test`
Expected: 101+ 个用例全 PASS。

- [ ] **Step 3: 提交**

```bash
git add src/main/main.js
git commit -m "fix: main.js 经 extraSensors 注入插件传感器"
```

### Task 3: settings.js — 规则编辑器下拉包含插件传感器

**Files:**
- Modify: `src/renderer/settings.js:12-17`（加模块变量）、`170-224`（`openEditor` 改为 async 并从快照推断）

- [ ] **Step 1: 加模块变量** — 在 `SENSOR_METRICS`（第 17 行）后加：

```js
let pluginSensorMetrics = {}; // { sensorName: [{k,label}] } 从最新传感器快照推断（内置之外的新键）
```

- [ ] **Step 2: 改 `openEditor`** — 把 `async function openEditor(id) {` 起的函数体改为：

```js
async function openEditor(id) {
  editingRuleId = id;
  const r = id ? config.rules.find(x => x.id === id) : defaultRule();
  // 插件传感器指标从最新快照推断：内置之外的新传感器键，取数值标量键（数组如 cores 排除）
  try {
    const st = await window.rimletter.getState();
    pluginSensorMetrics = {};
    if (st && typeof st === 'object') {
      for (const [name, data] of Object.entries(st)) {
        if (SENSOR_METRICS[name] || !data || typeof data !== 'object' || Array.isArray(data)) continue;
        pluginSensorMetrics[name] = Object.keys(data).filter(k => !Array.isArray(data[k])).map(k => ({ k, label: k }));
      }
    }
  } catch (e) { pluginSensorMetrics = {}; }
  const allMetrics = { ...SENSOR_METRICS, ...pluginSensorMetrics };
  const box = document.getElementById('rule-editor');
  const sensorOpts = Object.keys(allMetrics).map(s => '<option value="' + s + '"' + (r.sensor === s ? ' selected' : '') + '>' + sensorLabel(s) + '</option>').join('');
  const metricOpts = (allMetrics[r.sensor] || allMetrics.cpu).map(m =>
    '<option value="' + m.k + '"' + (r.metric === m.k ? ' selected' : '') + '>' + m.label + '</option>').join('');
  // …后续 opOpts/sevOpts/box.innerHTML 等原有代码不动…
```

并同步改传感器 change 回调里的一处：把

```js
  document.getElementById('ed-sensor').addEventListener('change', e => {
    const s = e.target.value;
    document.getElementById('ed-metric').innerHTML = (SENSOR_METRICS[s] || []).map(m =>
      '<option value="' + m.k + '">' + m.label + '</option>').join('');
```

改为：

```js
  document.getElementById('ed-sensor').addEventListener('change', e => {
    const s = e.target.value;
    document.getElementById('ed-metric').innerHTML = ({ ...SENSOR_METRICS, ...pluginSensorMetrics }[s] || []).map(m =>
      '<option value="' + m.k + '">' + m.label + '</option>').join('');
```

其余（`ed-gpu-hint` 等）不动。`openEditor` 变 async 后调用处（`renderRules` 里的 `.addEventListener('click', () => openEditor(...))`）无需改，fire-and-forget 即可。

- [ ] **Step 3: 手动冒烟**（可选，需起 Electron；本地 `npm start` 可能受代理影响，可跳过并在 CI/发布后验证）

Run: `npm start` → 打开设置 → 告警规则 → 添加规则，确认下拉含 `cpu-temp` 且指标为 `temp`/`maxCore`（需先启用 cpu-temp 插件）。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/settings.js
git commit -m "feat: 规则编辑器下拉包含插件传感器（指标从快照推断）"
```

### Task 4: 版本号 0.3.1 + 文档

**Files:**
- Modify: `package.json:3`（version）、`CLAUDE.md`（实现状态）、`README.md`（如有插件列表）

- [ ] **Step 1: bump 版本**

`package.json` 第 3 行：`"version": "0.3.0"` → `"version": "0.3.1"`。

- [ ] **Step 2: 更新 CLAUDE.md「实现状态」** — 顶部列表插一行（置顶）：

```
- ✅ v0.3.1：修复插件传感器链路（registerSensor 的传感器现可被轮询/进规则下拉/显示在 /state）；新增官方插件「CPU 温度信」（需运行 LibreHardwareMonitor，见官方插件仓库）
```

- [ ] **Step 3: 更新 README** — 若 README 有「官方插件」小节，加一行 CPU 温度信（数据源 LibreHardwareMonitor）；无则跳过。

- [ ] **Step 4: 提交**

```bash
git add package.json CLAUDE.md README.md
git commit -m "chore: bump v0.3.1 + 文档（插件传感器链路修复、CPU 温度官方插件）"
```

---

## Phase B：官方插件 — 工作目录 `D:\claudeswork\official-plugin`

### Task 5: `plugin-cpu-temp.js` 主体（解析器 + 传感器 + 默认规则 + 配置表单）

**Files:**
- Create: `plugin-cpu-temp/plugin-cpu-temp.js`

- [ ] **Step 1: 写文件** — 完整内容如下：

```js
// plugin-cpu-temp.js — CPU 温度信（RimLetter 官方插件）
// 轮询 LibreHardwareMonitor 的本地 Web API（http://127.0.0.1:{port}/data.json），
// CPU 封装温度 / 最高核心温度过高来信。
// 需 RimLetter v0.3.1+（插件传感器链路修复所在版本）；需运行 LibreHardwareMonitor。
'use strict';

const SEVERITIES = [
  { value: 'ThreatBig', label: '重大威胁' },
  { value: 'ThreatSmall', label: '威胁' },
  { value: 'NegativeEvent', label: '负面' },
  { value: 'NeutralEvent', label: '中性' },
  { value: 'PositiveEvent', label: '正面' }
];

// 数值容错：数字直接返回；字符串剥单位、兼容逗号/点小数点（LHM 按系统区域格式化）。
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/[^\d.,-]/g, '').match(/-?\d+[.,]?\d*/);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// 遍历 LHM data.json 的 Children 树，收集 CPU 硬件节点的温度传感器。
// data.json 结构（LHM HttpServer.cs 源码确认）：
//   根 { Text:"Sensor", Children:[ 电脑节点 ] } → 电脑节点.Children → 硬件节点 → 类型分组 → 传感器节点
//   CPU 硬件节点 ImageURL === "images_icon/cpu.png"；温度传感器 Type === "Temperature"，RawValue 为干净的数值。
// 返回 { temps:[{name,value}], coreTemps:[number], pkg:number|null }。
function collectCpuTempSensors(json) {
  const root = (json && Array.isArray(json.Children)) ? json.Children : (Array.isArray(json) ? json : []);
  const temps = [];
  const coreTemps = [];
  let pkg = null;
  function collectTemps(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      collectTemps(node.Children);
      if (node.Type === 'Temperature') {
        const v = toNum(node.RawValue != null ? node.RawValue : node.Value);
        if (v === null) continue;
        const name = String(node.Text || '');
        temps.push({ name, value: v });
        if (/^Core\s*#/i.test(name)) coreTemps.push(v);
        if (!pkg && (/Package/i.test(name) || /Tctl/i.test(name) || /Tdie/i.test(name))) pkg = v;
      }
    }
  }
  function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const isCpu = typeof node.ImageURL === 'string' && node.ImageURL.indexOf('cpu') !== -1;
      if (isCpu) { collectTemps(node.Children); continue; } // CPU 硬件下无嵌套硬件，收完即止
      walk(node.Children);
    }
  }
  walk(root);
  return { temps, coreTemps, pkg };
}

// → { temp, maxCore, cores }；找不到 CPU 温度返回 null。
function parseLhm(json) {
  const { temps, coreTemps, pkg } = collectCpuTempSensors(json);
  if (temps.length === 0) return null;
  const temp = pkg !== null ? pkg : temps[0].value;
  const maxCore = coreTemps.length ? Math.max(...coreTemps) : undefined;
  return { temp, maxCore, cores: coreTemps, count: temps.length };
}

async function fetchLhm(port) {
  const url = 'http://127.0.0.1:' + port + '/data.json';
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

module.exports = async ({ api, logger }) => {
  const fields = [
    { key: 'enabled', label: '启用插件', type: 'bool', default: true },
    { key: 'port', label: 'LHM 端口', type: 'number', default: 8085, min: 1, max: 65535 },
    { key: 'notifyTemp', label: 'CPU 封装温度过高来信', type: 'bool', default: true },
    { key: 'tempThreshold', label: '封装温度阈值（°C）', type: 'number', default: 85, min: 40, max: 110 },
    { key: 'tempSeverity', label: '封装温度信紧急度', type: 'select', options: SEVERITIES, default: 'ThreatSmall' },
    { key: 'notifyCore', label: 'CPU 最高核心过高来信', type: 'bool', default: true },
    { key: 'coreThreshold', label: '最高核心阈值（°C）', type: 'number', default: 90, min: 40, max: 110 },
    { key: 'coreSeverity', label: '核心信紧急度', type: 'select', options: SEVERITIES, default: 'ThreatSmall' },
    { key: 'durationSec', label: '持续时长（秒）', type: 'number', default: 5, min: 0, max: 60 },
    { key: 'test', label: '测试读取温度', type: 'button', buttonText: '测试' }
  ];
  api.registerConfig({ title: 'CPU 温度监控', fields });

  if (api.registerAction) {
    api.registerAction('test', async () => {
      const cfg = api.getConfig();
      try {
        const r = parseLhm(await fetchLhm(cfg.port));
        if (!r) return '未找到 CPU 温度传感器：请确认 LibreHardwareMonitor 已运行并勾选 Remote web server（端口 ' + cfg.port + '）';
        return 'LHM 已连接：CPU ' + r.temp + '°C，最高核心 ' + (r.maxCore != null ? r.maxCore + '°C' : '--') + '，共 ' + r.count + ' 个温度传感器';
      } catch (e) {
        return '连接失败：' + (e && e.message || e) + '（请确认 LibreHardwareMonitor 已运行，端口 ' + cfg.port + '）';
      }
    });
  }

  const cfgRef = { current: api.getConfig() };
  api.on('config', next => { cfgRef.current = next; applyRules(); });

  function applyRules() {
    const cfg = cfgRef.current;
    api.registerRule({
      id: 'plugin-cpu-temp-high',
      sensor: 'cpu-temp', metric: 'temp', operator: '>', threshold: cfg.tempThreshold,
      durationMs: (cfg.durationSec || 0) * 1000, severity: cfg.tempSeverity,
      label: 'CPU 温度过高', description: 'CPU 温度已持续 ' + cfg.tempThreshold + '°C 以上', sound: 'auto',
      enabled: !!cfg.enabled && !!cfg.notifyTemp
    });
    api.registerRule({
      id: 'plugin-cpu-temp-core',
      sensor: 'cpu-temp', metric: 'maxCore', operator: '>', threshold: cfg.coreThreshold,
      durationMs: (cfg.durationSec || 0) * 1000, severity: cfg.coreSeverity,
      label: 'CPU 核心过热', description: '最高核心温度已持续 ' + cfg.coreThreshold + '°C 以上', sound: 'auto',
      enabled: !!cfg.enabled && !!cfg.notifyCore
    });
  }
  applyRules();

  let warned = false;
  api.registerSensor('cpu-temp', async () => {
    const cfg = cfgRef.current;
    if (!cfg.enabled) return { temp: undefined, maxCore: undefined, cores: [] };
    try {
      const r = parseLhm(await fetchLhm(cfg.port));
      warned = false;
      if (!r) return { temp: undefined, maxCore: undefined, cores: [] };
      return { temp: r.temp, maxCore: r.maxCore, cores: r.cores };
    } catch (e) {
      if (!warned) { warned = true; logger.warn('CPU 温度读取失败（LibreHardwareMonitor 未运行？）: ' + (e && e.message || e)); }
      return { temp: undefined, maxCore: undefined, cores: [] };
    }
  });

  logger.info('CPU 温度插件已加载（数据源 LibreHardwareMonitor，端口 ' + cfgRef.current.port + '）');
};

module.exports._test = { toNum, collectCpuTempSensors, parseLhm, fetchLhm };
```

- [ ] **Step 2: 提交**

```bash
cd D:/claudeswork/official-plugin
git add plugin-cpu-temp/plugin-cpu-temp.js
git commit -m "feat: CPU 温度信插件（LibreHardwareMonitor 数据源）"
```

### Task 6: 插件单测（fixture 驱动，TDD）

**Files:**
- Create: `plugin-cpu-temp/test/cpu-temp.test.js`

- [ ] **Step 1: 写测试**（先写，此时 `require('../plugin-cpu-temp.js')` 已存在 → 直接跑即应通过；若按严格 TDD，可先把 `_test` 导出留空让用例失败，再实现。这里主体已在 Task 5 实现，直接写用例验证行为）：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../plugin-cpu-temp.js');
const { toNum, collectCpuTempSensors, parseLhm } = _test;

// 基于真实 LHM data.json 结构的 fixture（含 CPU + GPU 硬件，模拟多行格式）
const SAMPLE = {
  id: 0, Text: 'Sensor', Min: 'Min', Value: 'Value', Max: 'Max', ImageURL: '',
  Children: [
    { id: 1, Text: 'MYPC', ImageURL: 'images_icon/computer.png', Children: [
      { id: 2, Text: 'Intel Core i7-13700K', ImageURL: 'images_icon/cpu.png', Children: [
        { id: 3, Text: 'Temperatures', Children: [
          { id: 4, Text: 'CPU Package', Type: 'Temperature', Value: '52,3 °C', RawValue: 52.3, Min: '42,0 °C', Max: '71,0 °C', ImageURL: 'images/transparent.png' },
          { id: 5, Text: 'CPU Core Average', Type: 'Temperature', RawValue: 48.1 },
          { id: 6, Text: 'Core #1', Type: 'Temperature', RawValue: 47.0 },
          { id: 7, Text: 'Core #2', Type: 'Temperature', RawValue: 61.5 },
          { id: 8, Text: 'Core #3', Type: 'Temperature', RawValue: 49.2 }
        ]},
        { id: 9, Text: 'Loads', Children: [
          { id: 10, Text: 'CPU Total', Type: 'Load', RawValue: 12.0 }
        ]}
      ]},
      { id: 11, Text: 'NVIDIA GeForce RTX 4070', ImageURL: 'images_icon/nvidia.png', Children: [
        { id: 12, Text: 'Temperatures', Children: [
          { id: 13, Text: 'GPU Core', Type: 'Temperature', RawValue: 43.0 }
        ]}
      ]}
    ]}
  ]
};

test('toNum: 数字直接通过', () => {
  assert.equal(toNum(52.3), 52.3);
  assert.equal(toNum(0), 0);
});

test('toNum: 字符串剥单位、兼容逗号小数点', () => {
  assert.equal(toNum('52,3 °C'), 52.3);
  assert.equal(toNum('61.5'), 61.5);
  assert.equal(toNum('  -5,0 °C '), -5);
});

test('toNum: 非有限值返回 null', () => {
  assert.equal(toNum('--'), null);
  assert.equal(toNum(''), null);
  assert.equal(toNum(undefined), null);
  assert.equal(toNum(NaN), null);
});

test('parseLhm: 解析 CPU 封装温度、最高核心与逐核数组', () => {
  const r = parseLhm(SAMPLE);
  assert.equal(r.temp, 52.3);          // CPU Package
  assert.equal(r.maxCore, 61.5);       // Core #2
  assert.deepEqual(r.cores, [47, 61.5, 49.2]);
  assert.equal(r.count, 5);
});

test('parseLhm: 忽略 GPU 温度，只取 CPU 硬件', () => {
  const json = {
    Children: [
      { ImageURL: 'images_icon/nvidia.png', Children: [
        { Text: 'Temperatures', Children: [{ Text: 'GPU Core', Type: 'Temperature', RawValue: 43 }] }
      ]}
    ]
  };
  assert.equal(parseLhm(json), null);
});

test('parseLhm: 无 CPU 温度传感器返回 null（LHM 未跑/无传感器）', () => {
  assert.equal(parseLhm({ Children: [] }), null);
  assert.equal(parseLhm(null), null);
  assert.equal(parseLhm({}), null);
});

test('parseLhm: RawValue 缺失时回退解析 Value 字符串', () => {
  const json = {
    Children: [
      { ImageURL: 'images_icon/cpu.png', Children: [
        { Text: 'Temperatures', Children: [
          { Text: 'CPU Package', Type: 'Temperature', Value: '50,0 °C' }
        ]}
      ]}
    ]
  };
  const r = parseLhm(json);
  assert.equal(r.temp, 50);
  assert.equal(r.maxCore, undefined);
  assert.deepEqual(r.cores, []);
});

test('collectCpuTempSensors: 仅收集 CPU 硬件的 Temperature 传感器', () => {
  const { temps } = collectCpuTempSensors(SAMPLE);
  assert.equal(temps.length, 5);
  assert.ok(temps.every(t => t.name !== 'GPU Core'));
});
```

- [ ] **Step 2: 跑测试**

Run: `node --test plugin-cpu-temp/test/cpu-temp.test.js`
Expected: 全部 PASS。

- [ ] **Step 3: 提交**

```bash
cd D:/claudeswork/official-plugin
git add plugin-cpu-temp/test/cpu-temp.test.js
git commit -m "test: CPU 温度插件解析器单测（fixture 驱动）"
```

### Task 7: 插件 README

**Files:**
- Create: `plugin-cpu-temp/README.md`

- [ ] **Step 1: 写文件** — 内容要点：**需 RimLetter v0.3.1+**；LHM 安装与运行指引（GitHub 下载便携版 → 解压运行 → Options → 勾选 Remote web server，默认端口 8085 → 需常驻后台，退出 RimLetter 后仍要开着）；配置表（复制 `plugins.json` 相关字段说明）；紧急度说明；故障排查（不来信 → ① 插件已启用 ② LHM 是否在跑 ③ 配置表单「测试读取温度」看连接结果 ④ 端口被占用改 port）；数据源免责（LHM 开源免费，CPU 温度读取能力受主板/CPU 支持约束）。

示例骨架：

```markdown
# plugin-cpu-temp CPU 温度信

RimLetter 插件：轮询 LibreHardwareMonitor 的本地 Web API，CPU 封装温度 / 最高核心温度过高时从屏幕右缘滑入「信」。

> 需要 **RimLetter v0.3.1+**（此版本修复了插件传感器链路）。数据源为 [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)（开源免费）。

## 安装

1. 设置 → 插件管理 → 插件市场 → 找到「CPU 温度信」→ 安装（自动启用）；或把 `plugin-cpu-temp.js` 手动复制到 `%APPDATA%\rimletter\plugins\`
2. **安装并运行 LibreHardwareMonitor**（见下）
3. 设置 → 插件管理 → CPU 温度监控 → 点「测试读取温度」确认能连上

## 运行 LibreHardwareMonitor

1. GitHub Releases 下载 **LibreHardwareMonitor** 便携版（免安装）→ 解压 → 运行 `LibreHardwareMonitor.exe`
2. 菜单 **Options → Remote web server** 打勾（默认端口 8085）
3. **保持运行**：LHM 退出后本插件读不到温度（会优雅地不发信，不误报）
4. 托盘图标可最小化到托盘，不占任务栏

## 配置

| 字段 | 说明 | 默认 |
|---|---|---|
| 启用插件 | 总开关 | 开 |
| LHM 端口 | LibreHardwareMonitor Remote web server 端口 | 8085 |
| CPU 封装温度过高来信 | 封装温度 ≥ 阈值来信 | 开 |
| 封装温度阈值（°C） | | 85 |
| 封装温度信紧急度 | | 威胁 |
| CPU 最高核心过高来信 | 最高单核温度 ≥ 阈值来信 | 开 |
| 最高核心阈值（°C） | | 90 |
| 核心信紧急度 | | 威胁 |
| 持续时长（秒） | 超限持续多久才发信，防瞬时尖峰 | 5 |

紧急度可选：ThreatBig（重大威胁）/ ThreatSmall（威胁）/ NegativeEvent（负面）/ NeutralEvent（中性）/ PositiveEvent（正面）。

## 故障排查

- **不来信**：① 确认插件已启用；② 确认 LHM 在运行且已勾选 Remote web server；③ 在配置表单点「测试读取温度」，看按钮旁提示
- **测试提示「连接失败」**：LHM 没运行，或端口不对（在配置里改成 LHM 实际端口）
- **测试提示「未找到 CPU 温度传感器」**：LHM 在跑但没读到 CPU 温度（部分主板/CPU 不暴露），或未勾选 Remote web server
- **改配置后立即生效**：保存后自动重注册规则；若改了端口，保存后下一轮轮询即用新端口

## 数据源与免责

温度由 LibreHardwareMonitor 读取（经主板/CPU 传感器，Windows 原生不提供 CPU 温度）。能否读到取决于硬件与主板支持。RimLetter 仅消费其本地 Web API，不上传任何数据。
```

- [ ] **Step 2: 提交**

```bash
cd D:/claudeswork/official-plugin
git add plugin-cpu-temp/README.md
git commit -m "docs: CPU 温度插件 README（LHM 指引 + 故障排查）"
```

### Task 8: `plugins.json` + 仓库 README 更新

**Files:**
- Modify: `plugins.json`、`README.md`（仓库根）

- [ ] **Step 1: `plugins.json` 加条目** — 在 `"plugins"` 数组末尾追加：

```json
    { "id": "cpu-temp", "name": "CPU 温度信", "desc": "CPU 温度/最高核心过高来信（需运行 LibreHardwareMonitor）", "author": "NothingCooker", "file": "plugin-cpu-temp/plugin-cpu-temp.js", "version": "1.0.0" }
```

（注意：最后一条 JSON 不能带尾逗号；若这是最后一项，去掉上一项的尾逗号。）

- [ ] **Step 2: 仓库 README「可用插件」表加一行**：

```markdown
| `plugin-cpu-temp` | CPU 温度信：CPU 封装 / 最高核心温度过高来信（需运行 LibreHardwareMonitor，需 RimLetter v0.3.1+） |
```

- [ ] **Step 3: 校验清单 JSON 合法**

Run: `node -e "JSON.parse(require('fs').readFileSync('plugins.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: 提交**

```bash
cd D:/claudeswork/official-plugin
git add plugins.json README.md
git commit -m "feat: 市场清单加入 CPU 温度信插件"
```

---

## Phase C：发布

### Task 9: 主仓库发布 v0.3.1

**Files:**
- 无代码改动；git + gh 操作

- [ ] **Step 1: 全量跑测试**

Run（在 `D:\claudeswork\RIM DESKTOP`）：`node --test`
Expected: 全部 PASS（101 + 新增 3 = 104 个）。

- [ ] **Step 2: 提交并推送（带代理）**

```bash
cd D:/claudeswork/RIM DESKTOP
git add -A
git commit -m "chore: bump v0.3.1"
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 git push
```

- [ ] **Step 3: 打 tag 并推送（触发 CI 构建 Release）**

```bash
git tag v0.3.1
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 git push origin v0.3.1
```

- [ ] **Step 4: 等 CI 构建完成后发布草稿 Release**

Run: `HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 "C:/Program Files/GitHub CLI/gh.exe" release edit v0.3.1 --repo NothingCooker/rimletter --notes "v0.3.1：修复插件传感器链路；新增 CPU 温度官方插件" --draft=false`
Expected: 成功输出；确认 GitHub Releases 页面 v0.3.1 为 Latest。

> **执行前先与用户确认**：发布公开 Release 是外发操作，动手前再向用户确认一次。

### Task 10: official-plugins 发布

**Files:**
- git + 推送

- [ ] **Step 1: 提交并推送（带代理）**

```bash
cd D:/claudeswork/official-plugin
git add -A
git commit -m "feat: 发布 CPU 温度信官方插件 v1.0.0"
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 git push
```

Expected: push 成功；jsDelivr 自动刷新后，RimLetter 插件市场可搜到「CPU 温度信」。

- [ ] **Step 2: 手动核验市场可见**（可选，需装 v0.3.1 后）

主程序 设置 → 插件管理 → 插件市场 → 刷新，确认出现「CPU 温度信」并可安装。

---

## Self-Review

- **规格覆盖**：3.1/3.2 → Task 1-2；3.3 → Task 3；3.4 → Task 1 测试；4.1 → Task 8；4.2/4.3/4.4 → Task 5-6；4.5 → Task 7；5 → Task 9-10；6（不在范围）→ 未引入。
- **占位符**：无 TBD/TODO；Task 5 与 Task 7 含完整代码/文档。
- **类型一致**：传感器统一 `{ temp, maxCore, cores }`；规则 metric `temp`/`maxCore`；`parseLhm` 返回 `{ temp, maxCore, cores, count }`；`collectCpuTempSensors` 返回 `{ temps, coreTemps, pkg }`，各 Task 引用一致。
- **风险提示**：渲染层 `getState()` 在 LHM 未运行时会等到 `fetch` 拒绝（localhost 拒连为即时 RST，可接受）；插件解析依赖真实 LHM `data.json` 形状，已按官方源码字段（`ImageURL`/`Type`/`RawValue`）实现，发布前可用「测试读取温度」按钮实测校准。
