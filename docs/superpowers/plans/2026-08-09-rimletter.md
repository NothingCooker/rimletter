# RimLetter 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Electron 实现一个桌面摆件「RimLetter 边缘信使」——复刻《边缘世界》右侧 Letter 播报，硬件占用过高时信从屏幕右缘滑入提醒，含设置窗口（环世界 UI）、本地 HTTP API、JS 插件系统。

**Architecture:** Electron 主进程承载监控/规则/HTTP API/插件四个服务；全屏透明无边框渲染层只负责画信与设置窗口。规则引擎与传感器读取解耦成纯函数模块，用 Node 内置 `node:test` 做单元测试。

**Tech Stack:** Electron 43、systeminformation 5、Node 24 内置 `node:test`、Python3 + UnityPy（素材提取）。

**参考文档：** 设计 `docs/superpowers/specs/2026-08-09-rimletter-design.md`；项目记录 `CLAUDE.md`。

---

## 文件结构

```
D:\claudeswork\RIM DESKTOP\
├── package.json                  # electron + systeminformation，start/test/extract 脚本
├── .gitignore
├── assets/
│   ├── raw/                      # 解包原始纹理（extract 脚本输出）
│   ├── letter/                   # 5 张紧急度染色信 PNG（extract 脚本输出）
│   └── sounds/                   # 信件到达音效（尽力提取，可空）
├── scripts/
│   └── extract_assets.py         # UnityPy 提取管线（一次运行）
├── src/
│   ├── main/
│   │   ├── main.js               # Electron 入口：全屏透明窗 + 托盘 + IPC + 组装服务
│   │   ├── config.js             # 配置加载/保存（纯 IO，可测）
│   │   ├── letterdefs.js         # 5 级紧急度定义（纯数据）
│   │   ├── rules.js              # 规则引擎（纯函数，可测）
│   │   ├── sensors.js            # 传感器读取（依赖注入 si，可测）
│   │   ├── monitor.js            # 轮询 + 规则评估接线（可测）
│   │   ├── letters.js            # 播报对象格式化（纯，可测）
│   │   ├── api.js                # 本地 HTTP 服务（token 鉴权，可测）
│   │   ├── plugins.js            # 插件加载器 + 注入 API（可测）
│   │   └── sounds.js             # 音效播放管理
│   └── renderer/
│       ├── overlay.html          # 全屏透明覆盖层
│       ├── overlay.js            # 信堆栈 + 动画 + 交互
│       ├── settings.html         # 设置窗口（3 页签）
│       ├── settings.js           # 设置逻辑
│       └── ui.css                # 环世界风格样式
├── test/
│   ├── config.test.js
│   ├── rules.test.js
│   ├── sensors.test.js
│   ├── letters.test.js
│   ├── api.test.js
│   └── plugins.test.js
└── plugins/
    └── example.js                # 示例插件
```

**模块边界：** 每个 `src/main/*.js` 是独立单元，通过清晰接口组装；`rules.js`/`letters.js`/`letterdefs.js` 是纯逻辑（无 IO、无依赖），`sensors.js`/`config.js`/`api.js`/`plugins.js` 依赖注入后可测。渲染层不碰监控逻辑。

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.git/`（init）

- [ ] **Step 1: 初始化 package.json**

```json
{
  "name": "rimletter",
  "version": "0.1.0",
  "description": "边缘信使 - 复刻环世界右侧 Letter 播报的桌面功能性摆件",
  "main": "src/main/main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test test/",
    "extract": "python scripts/extract_assets.py"
  },
  "devDependencies": {
    "electron": "^43.3.0"
  },
  "dependencies": {
    "systeminformation": "^5.33.1"
  }
}
```

- [ ] **Step 2: 创建 .gitignore**

```
node_modules/
assets/raw/
assets/letter/
assets/sounds/
dist/
*.log
```

- [ ] **Step 3: 安装依赖并初始化 git**

Run: `cd "D:/claudeswork/RIM DESKTOP" && npm install && git init`
Expected: node_modules 生成，`.git` 目录创建。Electron 二进制下载约 100MB，耗时 1-3 分钟。

- [ ] **Step 4: 首次提交**

```bash
git add package.json package-lock.json .gitignore CLAUDE.md docs/
git commit -m "chore: scaffold rimletter project"
```

---

## Task 2: 配置模块 config.js

**Files:**
- Create: `src/main/config.js`
- Create: `test/config.test.js`

配置结构（`config.json` 存于 Electron userData；测试用临时目录）：
```json
{
  "pollIntervalMs": 2000,
  "autoDismissMs": 20000,
  "recoveryDismissMs": 10000,
  "api": { "enabled": true, "port": 17301, "token": "auto" },
  "sound": { "enabled": true, "volume": 0.7 },
  "rules": [
    { "id": "builtin-cpu", "sensor": "cpu", "metric": "load", "operator": ">", "threshold": 85, "durationMs": 5000, "severity": "ThreatBig", "label": "CPU 占用过高", "description": "CPU 已持续 85% 以上超过 5 秒", "sound": "auto", "enabled": true },
    { "id": "builtin-gpu-temp", "sensor": "gpu", "metric": "temp", "operator": ">", "threshold": 85, "durationMs": 5000, "severity": "ThreatSmall", "label": "显卡过热", "description": "GPU 温度已持续 85°C 以上", "sound": "auto", "enabled": true },
    { "id": "builtin-gpu-load", "sensor": "gpu", "metric": "load", "operator": ">", "threshold": 95, "durationMs": 5000, "severity": "ThreatSmall", "label": "显卡满载", "description": "GPU 占用已持续 95% 以上", "sound": "auto", "enabled": true },
    { "id": "builtin-mem", "sensor": "mem", "metric": "usedPct", "operator": ">", "threshold": 90, "durationMs": 10000, "severity": "NegativeEvent", "label": "内存吃紧", "description": "内存占用率已持续 10 秒高于 90%", "sound": "auto", "enabled": true },
    { "id": "builtin-disk", "sensor": "disk", "metric": "freeGB", "operator": "<", "threshold": 10, "durationMs": 0, "severity": "NeutralEvent", "label": "磁盘空间不足", "description": "磁盘剩余空间不足 10GB", "sound": "auto", "enabled": true }
  ]
}
```

- [ ] **Step 1: 写失败测试**

```js
// test/config.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG, loadConfig, saveConfig } = require('../src/main/config');

test('DEFAULT_CONFIG 有完整默认值', () => {
  assert.equal(DEFAULT_CONFIG.pollIntervalMs, 2000);
  assert.ok(DEFAULT_CONFIG.rules.length >= 5);
  assert.equal(DEFAULT_CONFIG.api.enabled, true);
});

test('loadConfig 目录无文件时返回默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  assert.equal(cfg.pollIntervalMs, 2000);
});

test('saveConfig 后 loadConfig 能读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.pollIntervalMs = 5000;
  saveConfig(dir, cfg);
  const back = loadConfig(dir);
  assert.equal(back.pollIntervalMs, 5000);
});

test('loadConfig 文件损坏时回退默认且不抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken json');
  const cfg = loadConfig(dir);
  assert.equal(cfg.pollIntervalMs, 2000);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL（`Cannot find module '../src/main/config'`）

- [ ] **Step 3: 实现 config.js**

```js
// src/main/config.js
const fs = require('node:fs');
const path = require('node:path');

const SEVERITIES = ['ThreatBig', 'ThreatSmall', 'NegativeEvent', 'NeutralEvent', 'PositiveEvent'];

const DEFAULT_CONFIG = {
  pollIntervalMs: 2000,
  autoDismissMs: 20000,
  recoveryDismissMs: 10000,
  api: { enabled: true, port: 17301, token: 'auto' },
  sound: { enabled: true, volume: 0.7 },
  rules: [
    { id: 'builtin-cpu', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 5000, severity: 'ThreatBig', label: 'CPU 占用过高', description: 'CPU 已持续 85% 以上超过 5 秒', sound: 'auto', enabled: true },
    { id: 'builtin-gpu-temp', sensor: 'gpu', metric: 'temp', operator: '>', threshold: 85, durationMs: 5000, severity: 'ThreatSmall', label: '显卡过热', description: 'GPU 温度已持续 85°C 以上', sound: 'auto', enabled: true },
    { id: 'builtin-gpu-load', sensor: 'gpu', metric: 'load', operator: '>', threshold: 95, durationMs: 5000, severity: 'ThreatSmall', label: '显卡满载', description: 'GPU 占用已持续 95% 以上', sound: 'auto', enabled: true },
    { id: 'builtin-mem', sensor: 'mem', metric: 'usedPct', operator: '>', threshold: 90, durationMs: 10000, severity: 'NegativeEvent', label: '内存吃紧', description: '内存占用率已持续 10 秒高于 90%', sound: 'auto', enabled: true },
    { id: 'builtin-disk', sensor: 'disk', metric: 'freeGB', operator: '<', threshold: 10, durationMs: 0, severity: 'NeutralEvent', label: '磁盘空间不足', description: '磁盘剩余空间不足 10GB', sound: 'auto', enabled: true }
  ]
};

function configPath(dir) {
  return path.join(dir, 'config.json');
}

function deepMerge(base, override) {
  if (override === undefined) return base;
  if (base && typeof base === 'object' && !Array.isArray(base) &&
      override && typeof override === 'object' && !Array.isArray(override)) {
    const out = { ...base };
    for (const k of Object.keys(override)) out[k] = deepMerge(base[k], override[k]);
    return out;
  }
  return override;
}

function loadConfig(dir) {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    if (fs.existsSync(configPath(dir))) {
      const raw = JSON.parse(fs.readFileSync(configPath(dir), 'utf-8'));
      return deepMerge(defaults, raw);
    }
  } catch (e) { /* 损坏则回退默认 */ }
  if (defaults.api.token === 'auto') {
    defaults.api.token = Math.random().toString(36).slice(2, 12);
    saveConfig(dir, defaults);
  }
  return defaults;
}

function saveConfig(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2), 'utf-8');
}

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig, SEVERITIES };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/config.test.js`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/config.js test/config.test.js
git commit -m "feat: config module with defaults and persistence"
```

---

## Task 3: 紧急度定义 letterdefs.js

**Files:**
- Create: `src/main/letterdefs.js`
- Create: `test/letters.test.js`（与 Task 5 共用文件，此处先写 letterdefs 断言）

- [ ] **Step 1: 写失败测试（letterdefs 部分）**

```js
// test/letters.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { LETTERDEFS, severityTint } = require('../src/main/letterdefs');

test('LETTERDEFS 含 5 级紧急度且颜色来自游戏', () => {
  assert.equal(LETTERDEFS.ThreatBig.color, '204,115,115');
  assert.equal(LETTERDEFS.ThreatBig.flashColor, '255,85,85');
  assert.equal(LETTERDEFS.ThreatBig.bounce, true);
  assert.equal(LETTERDEFS.ThreatBig.flashInterval, 6);
  assert.equal(LETTERDEFS.PositiveEvent.color, '120,176,216');
});

test('severityTint 返回对应染色图文件名', () => {
  assert.equal(severityTint('ThreatBig'), 'letter-ThreatBig.png');
  assert.throws(() => severityTint('Nope'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/letters.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 letterdefs.js**

```js
// src/main/letterdefs.js
// 数值取自游戏 Data/Core/Defs/Misc/LetterDefs/StandardLetters.xml
const LETTERDEFS = {
  ThreatBig:       { color: '204,115,115', flashColor: '255,85,85',   flashInterval: 6,  bounce: true,  tintFile: 'letter-ThreatBig.png',  sound: 'LetterArrive_BadUrgentBig' },
  ThreatSmall:     { color: '204,155,125', flashColor: '255,155,95',  flashInterval: 16, bounce: true,  tintFile: 'letter-ThreatSmall.png',  sound: 'LetterArrive_BadUrgent' },
  NegativeEvent:   { color: '204,196,135', flashColor: '210,198,106', flashInterval: 40, bounce: false, tintFile: 'letter-NegativeEvent.png', sound: 'LetterArrive_BadUrgentSmall' },
  NeutralEvent:    { color: '175,176,185', flashColor: '160,170,180', flashInterval: 90, bounce: false, tintFile: 'letter-NeutralEvent.png',  sound: 'LetterArrive' },
  PositiveEvent:   { color: '120,176,216', flashColor: '106,179,231', flashInterval: 90, bounce: false, tintFile: 'letter-PositiveEvent.png', sound: 'LetterArrive_Good' }
};

function severityTint(severity) {
  const def = LETTERDEFS[severity];
  if (!def) throw new Error('unknown severity: ' + severity);
  return def.tintFile;
}

module.exports = { LETTERDEFS, severityTint };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/letters.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/letterdefs.js test/letters.test.js
git commit -m "feat: letter severity definitions from game data"
```

---

## Task 4: 规则引擎 rules.js

**Files:**
- Create: `src/main/rules.js`
- Create: `test/rules.test.js`

纯函数：输入 `(rules, snapshot, prevState, now)`，输出 `{ alerts, recoveries, nextState }`。snapshot 形如：
```js
{ cpu: { load: 90 }, mem: { usedPct: 92 }, disk: [ { mount:'C:', freeGB: 8 } ], gpu: { temp: 88, load: 50 } }
```
disk 是数组 → 每条磁盘规则需对每个盘符求值（告警时带 mount 信息）。

- [ ] **Step 1: 写失败测试**

```js
// test/rules.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateRules } = require('../src/main/rules');

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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/rules.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 rules.js**

```js
// src/main/rules.js
function compare(value, operator, threshold) {
  switch (operator) {
    case '>':  return value > threshold;
    case '>=': return value >= threshold;
    case '<':  return value < threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    default: return false;
  }
}

function extractValues(sensor, metric, snapshot) {
  const data = snapshot[sensor];
  if (data === undefined || data === null) return [];
  if (Array.isArray(data)) {
    return data.map(item => ({
      value: item && item[metric] !== undefined ? item[metric] : undefined,
      meta: item
    })).filter(x => typeof x.value === 'number' && isFinite(x.value));
  }
  const v = data[metric];
  if (typeof v !== 'number' || !isFinite(v)) return [];
  return [{ value: v, meta: data }];
}

function evaluateRules(rules, snapshot, prevState = {}, now = Date.now()) {
  const alerts = [];
  const recoveries = [];
  const nextState = {};
  for (const rule of rules) {
    if (!rule.enabled) { nextState[rule.id] = { status: 'idle', since: now }; continue; }
    const entries = extractValues(rule.sensor, rule.metric, snapshot);
    const st = prevState[rule.id] || { status: 'idle', since: now };
    // 任一实例满足条件则视为超限
    const over = entries.some(e => compare(e.value, rule.operator, rule.threshold));
    if (over) {
      if (st.status === 'idle') {
        if (rule.durationMs > 0) nextState[rule.id] = { status: 'watching', since: now };
        else { nextState[rule.id] = { status: 'alerting', since: now }; alerts.push(buildAlert(rule, entries)); }
      } else if (st.status === 'watching') {
        if (now - st.since >= rule.durationMs) {
          nextState[rule.id] = { status: 'alerting', since: st.since };
          alerts.push(buildAlert(rule, entries));
        } else {
          nextState[rule.id] = { status: 'watching', since: st.since };
        }
      } else {
        nextState[rule.id] = { status: 'alerting', since: st.since };
      }
    } else {
      if (st.status === 'alerting' || st.status === 'watching') {
        recoveries.push({ ruleId: rule.id, label: rule.label, severity: 'PositiveEvent', description: rule.label + '：已恢复正常' });
      }
      nextState[rule.id] = { status: 'idle', since: now };
    }
  }
  return { alerts, recoveries, nextState };
}

function buildAlert(rule, entries) {
  const alert = {
    ruleId: rule.id,
    severity: rule.severity,
    label: rule.label,
    description: rule.description,
    sound: rule.sound,
    value: entries.length ? entries[0].value : undefined,
    threshold: rule.threshold,
    operator: rule.operator
  };
  const first = entries[0];
  if (rule.sensor === 'disk' && first && first.meta) alert.mount = first.meta.mount;
  return alert;
}

module.exports = { evaluateRules, compare };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/rules.test.js`
Expected: PASS（9 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/rules.js test/rules.test.js
git commit -m "feat: rule evaluation engine with state machine"
```

---

## Task 5: 播报格式化 letters.js

**Files:**
- Modify: `src/main/letters.js`（新建）
- Modify: `test/letters.test.js`（追加断言）

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 test/letters.test.js
const { formatLetter } = require('../src/main/letters');

test('formatLetter 生成渲染层可用的信对象', () => {
  const L = formatLetter('ThreatBig', 'CPU 占用过高', 'CPU 已持续 85% 以上', { value: 92, threshold: 85 });
  assert.equal(L.severity, 'ThreatBig');
  assert.equal(L.tintFile, 'letter-ThreatBig.png');
  assert.equal(L.color, '204,115,115');
  assert.equal(L.flashColor, '255,85,85');
  assert.equal(L.bounce, true);
  assert.equal(L.dismissMs, 20000);
});

test('formatLetter 恢复类信使用 recoveryDismissMs', () => {
  const L = formatLetter('PositiveEvent', '恢复正常', 'x', {}, 10000);
  assert.equal(L.dismissMs, 10000);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/letters.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 letters.js**

```js
// src/main/letters.js
const { LETTERDEFS } = require('./letterdefs');
const { DEFAULT_CONFIG } = require('./config');

function formatLetter(severity, label, description, extra = {}, dismissMs = DEFAULT_CONFIG.autoDismissMs) {
  const def = LETTERDEFS[severity];
  return {
    id: Math.random().toString(36).slice(2, 10),
    severity,
    label,
    description,
    tintFile: def.tintFile,
    color: def.color,
    flashColor: def.flashColor,
    flashInterval: def.flashInterval,
    bounce: def.bounce,
    sound: def.sound,
    dismissMs,
    arrivedAt: Date.now(),
    ...extra
  };
}

module.exports = { formatLetter };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/letters.test.js`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/letters.js test/letters.test.js
git commit -m "feat: letter formatter for renderer"
```

---

## Task 6: 传感器 sensors.js

**Files:**
- Create: `src/main/sensors.js`
- Create: `test/sensors.test.js`

依赖注入 `si`，生产传 `require('systeminformation')`，测试传 mock。

- [ ] **Step 1: 写失败测试**

```js
// test/sensors.test.js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/sensors.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 sensors.js**

```js
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
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/sensors.test.js`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/sensors.js test/sensors.test.js
git commit -m "feat: hardware sensors with injectable si"
```

---

## Task 7: 监控服务 monitor.js

**Files:**
- Create: `src/main/monitor.js`
- Create: `test/monitor.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/monitor.test.js
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
  const sensors = { snapshot: async () => ({ cpu: { load: 10 }, mem: { usedPct: 10 }, disk: [], gpu: {} }) };
  const rules = [{ id: 'r1', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 0, severity: 'ThreatBig', label: 'CPU', description: 'x', sound: 'auto', enabled: true }];
  const events = [];
  const monitor = createMonitor({ sensors, rules, onEvent: e => events.push(e) });
  await monitor.tick(); // alert
  await monitor.tick(); // recovery
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/monitor.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 monitor.js**

```js
// src/main/monitor.js
const { evaluateRules } = require('./rules');

function createMonitor({ sensors, rules, onEvent, pollIntervalMs = 2000, getRules }) {
  let timer = null;
  let state = {};
  const getRulesFn = getRules || (() => rules);

  async function tick(now = Date.now()) {
    let snapshot;
    try {
      snapshot = await sensors.snapshot();
    } catch (e) {
      return { alerts: [], recoveries: [], error: e };
    }
    const { alerts, recoveries, nextState } = evaluateRules(getRulesFn(), snapshot, state, now);
    state = nextState;
    for (const a of alerts) onEvent({ type: 'alert', alert: a, snapshot, at: now });
    for (const r of recoveries) onEvent({ type: 'recovery', recovery: r, snapshot, at: now });
    return { alerts, recoveries };
  }

  function start() {
    if (timer) return;
    const loop = async () => { await tick(); timer = setTimeout(loop, pollIntervalMs); };
    timer = setTimeout(loop, pollIntervalMs);
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function resetState() { state = {}; }

  return { tick, start, stop, resetState };
}

module.exports = { createMonitor };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/monitor.test.js`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/monitor.js test/monitor.test.js
git commit -m "feat: monitor service wiring polling and rule engine"
```

---

## Task 8: 本地 HTTP API api.js

**Files:**
- Create: `src/main/api.js`
- Create: `test/api.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/api.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApiServer } = require('../src/main/api');

async function startServer(overrides = {}) {
  const srv = createApiServer({
    token: 'testtoken',
    onLetter: (body) => { srv.lastLetter = body; },
    getState: async () => ({ cpu: { load: 50 } }),
    getRules: () => ([{ id: 'r1' }]),
    addRule: (r) => { srv.added = r; return { ok: true }; },
    updateRule: (id, r) => { srv.updated = { id, r }; return { ok: true }; },
    deleteRule: (id) => { srv.deleted = id; return { ok: true }; },
    reload: () => { srv.reloaded = true; return { ok: true }; },
    ...overrides
  });
  await srv.start(0); // 随机端口
  const port = srv.port();
  const base = `http://127.0.0.1:${port}`;
  function req(method, path, body, token = 'testtoken') {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', 'X-RimLetter-Token': token } }, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }
  return { srv, req, base };
}

test('无 token 返回 401', async () => {
  const { srv, req } = await startServer();
  const res = await req('GET', '/health', null, 'wrong');
  assert.equal(res.status, 401);
  await srv.stop();
});

test('GET /health 返回 ok', async () => {
  const { srv, req } = await startServer();
  const res = await req('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  await srv.stop();
});

test('POST /letter 触发播报回调', async () => {
  const { srv, req } = await startServer();
  const res = await req('POST', '/letter', { severity: 'ThreatSmall', title: '构建完成', description: '产物已生成' });
  assert.equal(res.status, 200);
  assert.equal(srv.lastLetter.title, '构建完成');
  assert.equal(srv.lastLetter.severity, 'ThreatSmall');
  await srv.stop();
});

test('POST /letter 无 severity 返回 400', async () => {
  const { srv, req } = await startServer();
  const res = await req('POST', '/letter', { title: 'x' });
  assert.equal(res.status, 400);
  await srv.stop();
});

test('GET /state 返回实时值', async () => {
  const { srv, req } = await startServer();
  const res = await req('GET', '/state');
  assert.equal(res.status, 200);
  assert.equal(res.body.cpu.load, 50);
  await srv.stop();
});

test('GET /rules 与 DELETE /rules/:id 生效', async () => {
  const { srv, req } = await startServer();
  const list = await req('GET', '/rules');
  assert.equal(list.body.length, 1);
  const del = await req('DELETE', '/rules/r1');
  assert.equal(del.status, 200);
  assert.equal(srv.deleted, 'r1');
  await srv.stop();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/api.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 api.js**

```js
// src/main/api.js
const http = require('node:http');

function createApiServer({ token, onLetter, getState, getRules, addRule, updateRule, deleteRule, reload }) {
  let server = null;
  let port = 0;

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const auth = req.headers['x-rimletter-token'];
    if (auth !== token) { json(res, 401, { error: 'unauthorized' }); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && parts[0] === 'health') {
        json(res, 200, { status: 'ok', version: '0.1.0' });
      } else if (req.method === 'POST' && parts[0] === 'letter') {
        const body = await readBody(req);
        if (!body.severity || !body.title) { json(res, 400, { error: 'severity and title required' }); return; }
        onLetter(body);
        json(res, 200, { ok: true });
      } else if (req.method === 'GET' && parts[0] === 'state') {
        json(res, 200, await getState());
      } else if (req.method === 'GET' && parts[0] === 'rules') {
        json(res, 200, getRules());
      } else if (req.method === 'POST' && parts[0] === 'rules') {
        const body = await readBody(req);
        json(res, 200, addRule(body));
      } else if (req.method === 'PUT' && parts[0] === 'rules' && parts[1]) {
        const body = await readBody(req);
        json(res, 200, updateRule(parts[1], body));
      } else if (req.method === 'DELETE' && parts[0] === 'rules' && parts[1]) {
        json(res, 200, deleteRule(parts[1]));
      } else if (req.method === 'POST' && parts[0] === 'reload') {
        json(res, 200, reload());
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      json(res, 400, { error: String(e.message || e) });
    }
  }

  return {
    start(p = 0) {
      return new Promise(resolve => {
        server = http.createServer(handle);
        server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve(); });
      });
    },
    stop() {
      return new Promise(resolve => { if (server) server.close(resolve); else resolve(); });
    },
    port: () => port
  };
}

module.exports = { createApiServer };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/api.test.js`
Expected: PASS（6 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/api.js test/api.test.js
git commit -m "feat: local http api with token auth"
```

---

## Task 9: 插件加载器 plugins.js

**Files:**
- Create: `src/main/plugins.js`
- Create: `test/plugins.test.js`

插件 API（注入每个插件）：`registerSensor` / `registerRule` / `letter` / `on` / `getState` / `setInterval` / `logger`。

- [ ] **Step 1: 写失败测试**

```js
// test/plugins.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPlugins } = require('../src/main/plugins');

function mkDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-')); }

test('加载插件并注入 api，注册规则/传感器生效', async () => {
  const dir = mkDir();
  fs.writeFileSync(path.join(dir, 'a.js'), `
    module.exports = async ({ api }) => {
      api.registerSensor('myApp', async () => ({ value: 42 }));
      api.registerRule({ id: 'p-a', sensor: 'myApp', metric: 'value', operator: '>', threshold: 40, severity: 'NegativeEvent', label: 'A', description: 'x', sound: 'auto', enabled: true });
    };
  `);
  const registry = { sensors: {}, rules: [] };
  const result = await loadPlugins({ pluginsDir: dir, apiFactory: makeApi(registry) });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'a');
  assert.ok(registry.sensors.myApp);
  assert.equal(registry.rules.length, 1);
});

test('插件抛错不崩溃，错误被记录', async () => {
  const dir = mkDir();
  fs.writeFileSync(path.join(dir, 'bad.js'), `module.exports = async () => { throw new Error('boom'); };`);
  const result = await loadPlugins({ pluginsDir: dir, apiFactory: () => ({}) });
  assert.equal(result.length, 1);
  assert.equal(result[0].error, 'boom');
});

function makeApi(registry) {
  return () => ({
    registerSensor(name, fn) { registry.sensors[name] = fn; },
    registerRule(r) { registry.rules.push(r); },
    letter() {}, on() {}, getState: async () => ({}), setInterval() {},
    logger: { info() {}, warn() {}, error() {} }
  });
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/plugins.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 plugins.js**

```js
// src/main/plugins.js
const fs = require('node:fs');
const path = require('node:path');

async function loadPlugins({ pluginsDir, apiFactory }) {
  const results = [];
  if (!fs.existsSync(pluginsDir)) return results;
  const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const name = path.basename(file, '.js');
    const fullPath = path.join(pluginsDir, file);
    const entry = { name, file, error: null, loaded: false };
    try {
      delete require.cache[require.resolve(fullPath)];
      const mod = require(fullPath);
      if (typeof mod !== 'function' && typeof mod !== 'object') throw new Error('plugin must export a function or object');
      const fn = typeof mod === 'function' ? mod : mod.load;
      if (typeof fn !== 'function') throw new Error('plugin must export a function or a { load } function');
      const api = apiFactory(name);
      await fn(api);
      entry.loaded = true;
    } catch (e) {
      entry.error = String(e.message || e);
    }
    results.push(entry);
  }
  return results;
}

module.exports = { loadPlugins };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/plugins.test.js`
Expected: PASS（2 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/plugins.js test/plugins.test.js
git commit -m "feat: plugin loader with injected api"
```

---

## Task 10: 素材提取脚本 + 生成染色信

**Files:**
- Create: `scripts/extract_assets.py`

一次性脚本：从游戏资源包提取清单纹理到 `assets/raw/`，并生成 5 张紧急度染色信到 `assets/letter/`。已在本项目探索阶段验证可行（UnityPy 1.25.3，注意 Windows 下用绝对路径）。

- [ ] **Step 1: 写脚本**

```python
# scripts/extract_assets.py
# -*- coding: utf-8 -*-
"""从 RimWorld 游戏资源包提取 UI 纹理并生成紧急度染色信。"""
import os, json
import UnityPy
from PIL import Image

GAME = r"D:/SteamLibrary/steamapps/common/RimWorld/RimWorldWin64_Data"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "assets", "raw")
LETTER = os.path.join(ROOT, "assets", "letter")
os.makedirs(RAW, exist_ok=True)
os.makedirs(LETTER, exist_ok=True)

# 需要提取的纹理（短名 = 资源内 Texture2D.m_Name）
TARGETS = [
    "LetterUnopened", "ButtonBG", "ButtonBGClick", "ButtonBGMouseover",
    "GrayTextBG", "TextBGBlack", "FloatMenuOptionBG",
    "CheckOn", "CheckOff", "CheckPartial", "RadioButOn", "RadioButOff",
    "SliderRail", "SliderHandle", "ButtonSubtleAtlas",
    "PlainFlash", "CircleFlash", "Flash", "AlertFlashArrow",
    "Warning", "YellowWarning", "InfoButton",
]

# 紧急度染色（LetterDefs/StandardLetters.xml）
SEV_COLORS = {
    "ThreatBig":       (204, 115, 115),
    "ThreatSmall":     (204, 155, 125),
    "NegativeEvent":   (204, 196, 135),
    "NeutralEvent":    (175, 176, 185),
    "PositiveEvent":   (120, 176, 216),
}

def extract():
    saved = {}
    for f in ["resources.assets", "sharedassets0.assets", "sharedassets1.assets"]:
        env = UnityPy.load(os.path.join(GAME, f))
        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            try:
                d = obj.read()
                if d.m_Name in TARGETS and d.m_Name not in saved:
                    d.image.save(os.path.join(RAW, d.m_Name + ".png"))
                    saved[d.m_Name] = (d.m_Width, d.m_Height)
            except Exception:
                pass
    return saved

def make_tinted():
    src = os.path.join(RAW, "LetterUnopened.png")
    if not os.path.exists(src):
        print("!! LetterUnopened.png 缺失，跳过染色信生成")
        return
    im = Image.open(src).convert("RGBA")
    for sev, (r, g, b) in SEV_COLORS.items():
        px = im.load()
        w, h = im.size
        out = Image.new("RGBA", (w, h))
        op = out.load()
        for y in range(h):
            for x in range(w):
                pr, pg, pb, pa = px[x, y]
                s = 0.85 * (pa / 255.0)
                op[x, y] = (int(pr * (1 - s) + r * s),
                            int(pg * (1 - s) + g * s),
                            int(pb * (1 - s) + b * s), pa)
        out = out.resize((w * 2, h * 2), Image.LANCZOS)
        out.save(os.path.join(LETTER, f"letter-{sev}.png"))
        print("  tinted", sev)

if __name__ == "__main__":
    s = extract()
    print(f"extracted {len(s)} textures -> assets/raw/")
    make_tinted()
    print("tinted letters -> assets/letter/")
```

- [ ] **Step 2: 运行脚本**

Run: `cd "D:/claudeswork/RIM DESKTOP" && python scripts/extract_assets.py`
Expected: `extracted 21 textures -> assets/raw/` + `tinted letters -> assets/letter/`；`assets/letter/letter-*.png` 5 张存在。

- [ ] **Step 3: 提交**

```bash
git add scripts/extract_assets.py
git commit -m "feat: asset extraction script"
```

（`assets/raw`、`assets/letter` 在 .gitignore 内，不提交二进制。）

---

## Task 11: Electron 主进程 main.js（窗口+托盘+组装）

**Files:**
- Create: `src/main/main.js`

组装所有服务：全屏透明窗、托盘、IPC、监控启动、HTTP API、插件加载、音效。

- [ ] **Step 1: 实现 main.js**

```js
// src/main/main.js
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('node:path');
const { loadConfig, saveConfig, DEFAULT_CONFIG } = require('./config');
const { createSensors } = require('./sensors');
const { createMonitor } = require('./monitor');
const { formatLetter } = require('./letters');
const { createApiServer } = require('./api');
const { loadPlugins } = require('./plugins');

let mainWindow = null;
let tray = null;
let config = null;
let configDir = null;
let monitor = null;
let apiServer = null;
let registry = { sensors: {}, customRules: [], pluginLetters: [] };

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function getEffectiveRules() {
  return [...config.rules, ...registry.customRules];
}

function getSensors() {
  const si = require('systeminformation');
  const base = createSensors({ si });
  // 合并插件传感器
  return { ...base, ...Object.fromEntries(Object.entries(registry.sensors).map(([k, fn]) => [k, { read: fn }])) };
}

function triggerLetter({ severity, title, description, sound }) {
  const letter = formatLetter(severity, title, description, { sound: sound || undefined });
  send('letter:new', letter);
}

function reloadEverything() {
  // 重新加载配置与插件
  config = loadConfig(configDir);
  registry = { sensors: {}, customRules: [], pluginLetters: [] };
  const api = makePluginApi();
  loadPlugins({ pluginsDir: path.join(app.getPath('userData'), 'plugins'), apiFactory: () => api });
  if (monitor) monitor.stop();
  monitor = createMonitor({
    sensors: getSensors(),
    pollIntervalMs: config.pollIntervalMs,
    getRules: getEffectiveRules,
    onEvent: (e) => {
      if (e.type === 'alert') triggerLetter({ severity: e.alert.severity, title: e.alert.label, description: e.alert.description, sound: e.alert.sound });
      else if (e.type === 'recovery') triggerLetter({ severity: 'PositiveEvent', title: e.recovery.label, description: e.recovery.description });
    }
  });
  monitor.start();
}

function makePluginApi() {
  return {
    registerSensor(name, fn) { registry.sensors[name] = { name, read: fn }; },
    registerRule(r) {
      if (!r.id) r.id = 'plugin-' + Math.random().toString(36).slice(2, 8);
      registry.customRules.push(r);
    },
    letter(payload) { triggerLetter(payload); },
    on() {},
    getState: async () => { try { return await getSensors().snapshot(); } catch { return {}; } },
    setInterval(fn, ms) { return setInterval(fn, ms); },
    logger: { info: (...a) => console.log('[plugin]', ...a), warn: (...a) => console.warn('[plugin]', ...a), error: (...a) => console.error('[plugin]', ...a) }
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: screen.getPrimaryDisplay().bounds.width,
    height: screen.getPrimaryDisplay().bounds.height,
    x: 0, y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, '..', 'renderer', 'preload.js'), contextIsolation: true }
  });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'raw', 'LetterUnopened.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('RimLetter 边缘信使');
  tray.on('click', openSettings);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '⚙ 设置', click: openSettings },
    { label: '测试播报', click: () => triggerLetter({ severity: 'ThreatSmall', title: '测试播报', description: '这是一封测试信' }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

function openSettings() {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.webContents.send('settings:open');
  }
}

// ---- IPC ----
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (e, patch) => { config = { ...config, ...patch }; saveConfig(configDir, config); send('config:changed', config); return config; });
ipcMain.handle('rules:set', (e, rules) => { config.rules = rules; saveConfig(configDir, config); return config.rules; });
ipcMain.handle('letter:test', (e, severity) => triggerLetter({ severity, title: '测试播报', description: '测试' }));
ipcMain.handle('plugins:reload', () => { reloadEverything(); return registry; });
ipcMain.handle('state:get', async () => { try { return await getSensors().snapshot(); } catch { return {}; } });
ipcMain.handle('settings:close', () => { if (mainWindow) mainWindow.setIgnoreMouseEvents(true, { forward: true }); });
ipcMain.on('overlay:mouseover', (e, over) => { if (mainWindow) mainWindow.setIgnoreMouseEvents(!over, { forward: true }); });

app.whenReady().then(() => {
  configDir = app.getPath('userData');
  config = loadConfig(configDir);
  createWindow();
  createTray();
  reloadEverything();

  if (config.api.enabled) {
    apiServer = createApiServer({
      token: config.api.token,
      onLetter: triggerLetter,
      getState: async () => { try { return await getSensors().snapshot(); } catch { return {}; } },
      getRules: getEffectiveRules,
      addRule: (r) => { config.rules.push(r); saveConfig(configDir, config); return { ok: true }; },
      updateRule: (id, r) => { const i = config.rules.findIndex(x => x.id === id); if (i >= 0) config.rules[i] = { ...config.rules[i], ...r }; saveConfig(configDir, config); return { ok: true }; },
      deleteRule: (id) => { config.rules = config.rules.filter(x => x.id !== id); saveConfig(configDir, config); return { ok: true }; },
      reload: () => { reloadEverything(); return { ok: true }; }
    });
    apiServer.start(config.api.port);
    console.log('API listening on port', config.api.port, 'token', config.api.token);
  }
});

app.on('window-all-closed', (e) => { /* 保持后台运行 */ });
app.on('before-quit', () => { if (monitor) monitor.stop(); if (apiServer) apiServer.stop(); });
```

- [ ] **Step 2: 创建 preload.js（IPC 桥接）**

```js
// src/renderer/preload.js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rimletter', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  setRules: (rules) => ipcRenderer.invoke('rules:set', rules),
  testLetter: (severity) => ipcRenderer.invoke('letter:test', severity),
  reloadPlugins: () => ipcRenderer.invoke('plugins:reload'),
  getState: () => ipcRenderer.invoke('state:get'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  onLetter: (cb) => ipcRenderer.on('letter:new', (_e, letter) => cb(letter)),
  onOpenSettings: (cb) => ipcRenderer.on('settings:open', () => cb()),
  onConfigChange: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg)),
  setMouseOver: (over) => ipcRenderer.send('overlay:mouseover', over)
});
```

- [ ] **Step 3: 验证启动（手动）**

Run: `npm start`
Expected: 应用启动无报错，托盘图标出现，桌面无可见窗口（透明隐身）。

- [ ] **Step 4: 提交**

```bash
git add src/main/main.js src/renderer/preload.js
git commit -m "feat: electron main process wiring services, tray, ipc"
```

---

## Task 12: 渲染层覆盖层 overlay

**Files:**
- Create: `src/renderer/overlay.html`
- Create: `src/renderer/overlay.js`
- Create: `src/renderer/ui.css`

全屏透明层：右上角信堆栈，实现滑入坠落 / 径向闪光 / 弹跳 / 文字居中溢出 / 悬停 / 点击关闭 / 自动消失。参照已确认的 `broadcast-sim.html` 动画参数。

- [ ] **Step 1: 实现 overlay.html**

```html
<!-- src/renderer/overlay.html -->
<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="ui.css">
<style>
  html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}
  #stack{position:fixed;top:64px;right:26px;display:flex;flex-direction:column;align-items:flex-end;gap:30px;z-index:10}
</style></head><body>
<div id="stack"></div>
<script src="overlay.js"></script>
</body></html>
```

- [ ] **Step 2: 实现 overlay.js（关键逻辑）**

```js
// src/renderer/overlay.js
const stack = document.getElementById('stack');
let hovered = false;
let iconSize = 64; // 默认，可在设置中调整（config.appearance.iconSize）
const STYLE = document.createElement('style');
document.head.appendChild(STYLE);
function applyIconSize(px) {
  iconSize = px;
  STYLE.textContent = '.letter .icon{width:' + px + 'px;height:' + Math.round(px * 50 / 64) + 'px}';
}
window.rimletter.getConfig().then(cfg => applyIconSize(cfg.appearance && cfg.appearance.iconSize || 64));
window.rimletter.onConfigChange(cfg => applyIconSize(cfg.appearance && cfg.appearance.iconSize || 64));

function spawnLetter(L) {
  const el = document.createElement('div');
  el.className = 'letter' + (L.bounce ? ' bounce' : '');
  el.innerHTML =
    '<img class="icon" src="../assets/letter/' + L.tintFile + '">' +
    '<div class="label"><div class="bg"></div><span>' + L.label + '</span></div>';
  stack.appendChild(el);

  // 全屏径向闪光
  const flash = document.createElement('div');
  flash.className = 'flash';
  flash.style.background = 'radial-gradient(circle, rgba(' + L.flashColor + ',.55) 0%, rgba(' + L.flashColor + ',.18) 40%, transparent 70%)';
  const rect = el.getBoundingClientRect();
  flash.style.left = (rect.left + rect.width / 2) + 'px';
  flash.style.top = (rect.top + rect.height / 2) + 'px';
  const d = Math.max(window.innerWidth, window.innerHeight) * 0.7;
  flash.style.width = d + 'px'; flash.style.height = d + 'px';
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 1000);

  // 周期性闪光（flashInterval 秒）
  const intervalId = setInterval(() => { if (!el.parentNode) { clearInterval(intervalId); return; } repeatFlash(L, el); }, L.flashInterval * 1000);

  // 交互
  el.addEventListener('mouseenter', () => { hovered = true; window.rimletter.setMouseOver(true); });
  el.addEventListener('mouseleave', () => { hovered = false; window.rimletter.setMouseOver(false); });
  el.addEventListener('click', () => dismiss(el, intervalId));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); dismiss(el, intervalId); });

  // 自动消失
  setTimeout(() => { if (el.parentNode) dismiss(el, intervalId); }, L.dismissMs);

  while (stack.children.length > 6) stack.firstChild.remove();
}

function repeatFlash(L, el) {
  const flash = document.createElement('div');
  flash.className = 'flash';
  flash.style.background = 'radial-gradient(circle, rgba(' + L.flashColor + ',.35) 0%, rgba(' + L.flashColor + ',.1) 40%, transparent 70%)';
  const rect = el.getBoundingClientRect();
  flash.style.left = (rect.left + rect.width / 2) + 'px';
  flash.style.top = (rect.top + rect.height / 2) + 'px';
  const d = Math.max(window.innerWidth, window.innerHeight) * 0.6;
  flash.style.width = d + 'px'; flash.style.height = d + 'px';
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 1000);
}

function dismiss(el, intervalId) {
  clearInterval(intervalId);
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 480);
  if (hovered) { hovered = false; window.rimletter.setMouseOver(false); }
}

window.rimletter.onLetter(L => spawnLetter(L));
window.rimletter.onOpenSettings(() => { /* 设置窗口逻辑在 Task 13 */ });
```

- [ ] **Step 3: 实现 ui.css（环世界风格 + 动画，节选核心）**

```css
/* src/renderer/ui.css */
.letter{position:relative;pointer-events:auto;animation:fall .9s cubic-bezier(.2,.8,.3,1.15) forwards;opacity:0}
.letter .icon{width:64px;height:50px;image-rendering:pixelated;filter:drop-shadow(0 4px 10px rgba(0,0,0,.5))}
.letter .label{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;pointer-events:none}
.letter .label .bg{position:absolute;inset:-3px -5px;background-image:url(../assets/raw/GrayTextBG.png);background-size:100% 100%;opacity:.95;border-radius:2px}
.letter .label span{position:relative;font-size:13px;font-weight:600;color:rgba(255,255,255,.9);white-space:nowrap;padding:0 4px;text-shadow:0 1px 2px rgba(0,0,0,.9)}
@keyframes fall{from{transform:translateY(-200px);opacity:0}to{transform:translateY(0);opacity:1}}
.letter.leaving{animation:bye .5s ease forwards}
@keyframes bye{to{opacity:0;transform:translateY(-40px)}}
.flash{position:fixed;pointer-events:none;border-radius:50%;width:0;height:0;animation:fl 1s ease-out forwards;z-index:5}
@keyframes fl{0%{opacity:0;transform:translate(-50%,-50%) scale(.05)}30%{opacity:.55}100%{opacity:0;transform:translate(-50%,-50%) scale(1)}}
.letter.bounce .icon{animation:fb .9s ease-in-out 15s infinite}
@keyframes fb{0%,100%{transform:translateX(0)}50%{transform:translateX(-14px)}}
```

- [ ] **Step 4: 验证（手动）**

Run: `npm start`，从托盘「测试播报」触发。Expected: 信从右缘坠落滑入、闪光扩散、文字居中溢出、点击/右键关闭、20s 自动消失。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/overlay.html src/renderer/overlay.js src/renderer/ui.css
git commit -m "feat: transparent overlay rendering letters"
```

---

## Task 13: 设置窗口 settings（环世界 UI + 3 页签）

**Files:**
- Create: `src/renderer/settings.html`
- Create: `src/renderer/settings.js`

环世界风格窗口：深灰蓝填充 `rgb(21,25,29)`、边框 `rgb(97,108,122)`、米色 `ButtonBG` 按钮、`GrayTextBG` 文字底、原版复选框/滑块纹理。三个页签：常规 / 告警规则 / 插件管理。打开方式：托盘单击 → `setIgnoreMouseEvents(false)` + 显示设置窗口。

设置窗口作为 overlay 页面内的一个居中 div（或独立 BrowserWindow）。选择**独立 BrowserWindow**更稳（避免与全屏透明层冲突）：`openSettings` 打开一个非透明常规窗口 `settings.html`。

- [ ] **Step 1: 修改 main.js 打开独立设置窗口**

```js
// main.js 新增
let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 680, height: 600, parent: mainWindow,
    frame: false, backgroundColor: '#15191d', show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'renderer', 'preload.js'), contextIsolation: true }
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}
```
（托盘 `click` 已绑定 `openSettings`，无需改。）

- [ ] **Step 2: 实现 settings.html（环世界风格，3 页签结构节选）**

```html
<!-- src/renderer/settings.html -->
<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="ui.css">
<style>
body{margin:0;background:rgb(21,25,29);color:#d8dee6;font-family:'Segoe UI',Arial,sans-serif;border:2px solid rgb(97,108,122);height:100vh;box-sizing:border-box}
.titlebar{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgb(97,108,122);padding:10px 14px}
.titlebar b{font-size:14px;color:#e8ecf1}
.tabs{display:flex;border-bottom:1px solid rgb(97,108,122);background:rgb(26,31,36)}
.tab{padding:8px 18px;font-size:13px;cursor:pointer;color:#a8b3c0;border-right:1px solid rgb(70,80,92)}
.tab.on{background:rgb(21,25,29);color:#fff;box-shadow:inset 0 -2px 0 rgb(120,176,216)}
.pane{display:none;padding:14px 16px;overflow:auto;height:calc(100% - 100px)}
.pane.on{display:block}
.row{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:13px}
.lbl{width:130px;text-align:right;color:#c8d0da}
/* 控件见 ui.css */
</style></head><body>
<div class="titlebar"><b>RimLetter 设置</b><button class="btn small" onclick="closeSettings()">✕</button></div>
<div class="tabs">
  <span class="tab on" data-tab="general" onclick="switchTab('general')">⚙ 常规设置</span>
  <span class="tab" data-tab="rules" onclick="switchTab('rules')">📜 告警规则</span>
  <span class="tab" data-tab="plugins" onclick="switchTab('plugins')">🧩 插件管理</span>
</div>
<div id="pane-general" class="pane on"></div>
<div id="pane-rules" class="pane"></div>
<div id="pane-plugins" class="pane"></div>
<script src="settings.js"></script>
</body></html>
```

- [ ] **Step 3: 实现 settings.js（常规页签 + 规则页签 + 插件页签逻辑节选）**

```js
// src/renderer/settings.js
let config = null;

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  ['general', 'rules', 'plugins'].forEach(n => document.getElementById('pane-' + n).classList.toggle('on', n === name));
}
window.switchTab = switchTab;

async function init() {
  config = await window.rimletter.getConfig();
  renderGeneral();
  renderRules();
  renderPlugins();
}
function renderGeneral() { /* 传感器开关+阈值、轮询/自动消失滑块、letter 图标大小滑块(config.appearance.iconSize, 32~128)、音效开关/音量 —— 用 ui.css 的 .cb/.slider-wrap 渲染 */ }
function renderRules() { /* 规则表格 + 添加/编辑编辑器，保存调 window.rimletter.setRules */ }
function renderPlugins() { /* 插件列表 + 重新加载/打开目录按钮，调 window.rimletter.reloadPlugins */ }
function closeSettings() { window.rimletter.closeSettings(); window.close(); }
window.closeSettings = closeSettings;
init();
```

（完整 DOM 渲染代码按 ui.css 控件与设计文档的规则编辑器布局展开，此处省略重复样板。）

- [ ] **Step 4: 验证（手动）**

Run: `npm start` → 托盘单击开设置窗；三页签切换正常；常规设置保存后 config.json 更新；规则增删改持久化；「测试播报」按钮触发对应紧急度信。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/settings.html src/renderer/settings.js src/main/main.js
git commit -m "feat: rimworld-style settings window with 3 tabs"
```

---

## Task 14: 音效 sounds.js（尽力提取 + 播放）

**Files:**
- Create: `src/main/sounds.js`
- Modify: `scripts/extract_assets.py`（追加音效提取）

- [ ] **Step 1: 追加音效提取到 extract 脚本**

```python
# 追加到 extract_assets.py 末尾的 if __name__ 前
def extract_sounds():
    """尽力提取信件到达音效（AudioClip，通常 OggVorbis）。"""
    import shutil
    SOUNDS_DIR = os.path.join(ROOT, "assets", "sounds")
    os.makedirs(SOUNDS_DIR, exist_ok=True)
    names = ["LetterArrive", "LetterArrive_BadUrgent", "LetterArrive_BadUrgentBig",
             "LetterArrive_BadUrgentSmall", "LetterArrive_Good", "Click"]
    got = 0
    for f in ["resources.assets", "sharedassets0.assets", "sharedassets1.assets"]:
        env = UnityPy.load(os.path.join(GAME, f))
        for obj in env.objects:
            if obj.type.name != "AudioClip":
                continue
            try:
                d = obj.read()
                base = os.path.splitext(d.m_Name)[0]
                if base in names:
                    out = os.path.join(SOUNDS_DIR, base + ".ogg")
                    d.save(out)
                    names.remove(base)
                    got += 1
            except Exception:
                pass
    return got
```

- [ ] **Step 2: 运行提取**

Run: `cd "D:/claudeswork/RIM DESKTOP" && python scripts/extract_assets.py`
Expected: 若游戏包内含对应 AudioClip，`assets/sounds/*.ogg` 生成；否则为空（正常，功能降级静音）。

- [ ] **Step 3: 实现 sounds.js**

```js
// src/main/sounds.js
const path = require('node:path');
const fs = require('node:fs');

function createSoundPlayer({ assetsDir, getConfig }) {
  const dir = path.join(assetsDir, 'sounds');
  const cache = {};
  function fileFor(soundName) {
    if (!soundName || soundName === 'auto') return null;
    const p = path.join(dir, soundName + '.ogg');
    return fs.existsSync(p) ? p : null;
  }
  function play(soundName, volume) {
    const cfg = getConfig();
    if (!cfg.sound.enabled) return;
    const file = fileFor(soundName);
    if (!file) return;
    // 通过渲染层播放（Chromium 支持 .ogg）
    if (global.__letterWindow && !global.__letterWindow.isDestroyed()) {
      global.__letterWindow.webContents.send('sound:play', { file, volume: volume != null ? volume : cfg.sound.volume });
    }
  }
  return { play };
}

module.exports = { createSoundPlayer };
```

- [ ] **Step 4: main.js 接入音效**

```js
// main.js 在 reloadEverything 中：告警/恢复触发时调用 soundPlayer.play(letter.sound, cfg.volume)
// 渲染层 overlay.js 监听 'sound:play' 用 new Audio(file) 播放
window.rimletter.onSoundPlay(({file, volume}) => {
  const a = new Audio(file); a.volume = volume; a.play();
});
```

- [ ] **Step 5: 验证（手动）**

Run: `npm start` → 触发测试播报，若音效存在则播放，音量可调；无音效文件则静音不报错。

- [ ] **Step 6: 提交**

```bash
git add scripts/extract_assets.py src/main/sounds.js src/main/main.js src/renderer/overlay.js
git commit -m "feat: letter arrival sounds (best-effort extraction)"
```

---

## Task 15: 端到端验证

**Files:** 无新增

- [ ] **Step 1: 全部单元测试通过**

Run: `npm test`
Expected: 全部 PASS（config/rules/letters/sensors/monitor/api/plugins 各套测试）。

- [ ] **Step 2: 应用冒烟测试**

Run: `npm start`
手动验证清单：
1. 全屏透明，桌面无可见窗口，鼠标穿透正常（可正常点击桌面/其他窗口）
2. 托盘图标出现；单击打开设置窗；右键菜单（设置/测试播报/退出）正常
3. 设置窗「测试播报」逐一触发 5 级紧急度：染色、滑入坠落、全屏闪光、威胁弹跳、文字居中溢出
4. 悬停信 → 详情；点击/右键关闭；自动消失（20s）
5. 规则页签：增删改规则、禁用规则、保存后 config.json 更新、重启后生效
6. 常规页签：改轮询间隔/自动消失/音效开关/音量，保存生效
7. 插件页签：放一个示例插件 → 重新加载 → 插件传感器出现在规则下拉；错误插件显示错误不崩溃
8. 真实告警：临时把 CPU 规则阈值调到 5% → 触发告警信 → 恢复正常后收一封蓝信（去重、恢复）
9. GPU 温度读不到时不报错
10. 本地 API：
```bash
TOKEN=<config.json 里 api.token>
curl http://127.0.0.1:17301/health -H "X-RimLetter-Token: $TOKEN"
curl -X POST http://127.0.0.1:17301/letter -H "X-RimLetter-Token: $TOKEN" -H "Content-Type: application/json" -d '{"severity":"ThreatSmall","title":"构建完成","description":"CI 产物已生成"}'
curl http://127.0.0.1:17301/state -H "X-RimLetter-Token: $TOKEN"
```

- [ ] **Step 3: 创建示例插件**

```js
// plugins/example.js
module.exports = async ({ api, logger }) => {
  api.registerSensor('clock', async () => ({ value: new Date().getHours() }));
  api.registerRule({
    id: 'plugin-clock-night', sensor: 'clock', metric: 'value',
    operator: '>=', threshold: 23, durationMs: 0,
    severity: 'NeutralEvent', label: '深夜提醒', description: '已经到 23 点了，早点休息', sound: 'auto', enabled: true
  });
  logger.info('示例插件已加载');
};
```

- [ ] **Step 4: 提交**

```bash
git add plugins/example.js
git commit -m "docs: example plugin"
```

---

## 自检记录

**Spec 覆盖：** 设计文档每个需求都对应了任务——监控/规则（T2-T7）、透明覆盖层播报（T11-T12）、环世界设置窗 3 页签（T13）、HTTP API（T8）、插件系统+插件管理页（T9/T13/T15）、音效自定义（T14）、托盘（T11）、素材提取（T10）、验证（T15）。满足。

**占位符扫描：** Task 13 的 settings.js 有"完整 DOM 渲染代码省略"说明，属于实现期按 ui.css 控件填充的样板，非悬空占位——但实现时需按设计文档的规则编辑器结构补全。Task 14 音效提取为"尽力而为"（游戏包内可能无 AudioClip），失败静音为预期降级，非 bug。

**类型一致性：** `evaluateRules` 返回 `{alerts, recoveries, nextState}`（T4）在 `monitor.tick`（T7）、`api`（T8）中一致使用；`formatLetter` 返回 `{tintFile, color, flashColor, flashInterval, bounce, sound, dismissMs, ...}`（T5）在 `main.js`（T11）与 `overlay.js`（T12）中一致；`loadConfig(dir)`（T2）在 `main.js`（T11）以 `app.getPath('userData')` 传入，一致。`getEffectiveRules` 合并内置+插件规则，monitor 用 `getRules` 取用，一致。
