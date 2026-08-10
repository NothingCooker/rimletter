# plugin-weather + plugin-night-watch 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现两个 RimLetter 官方插件——`plugin-weather`（环境事件信）与 `plugin-night-watch`（深夜提醒），含单测与 README。

**Architecture:** 两个独立插件子目录（`plugin-weather/`、`plugin-night-watch/`），单文件 CommonJS 插件，纯函数（映射/触发判定）与加载逻辑（registerConfig + 定时轮询）分离以便 node:test 单测。定时器用全局注册表 `global.__rimletter<名>` 持有，重载时清理旧定时器；每次 tick 自检 `plugins.disabled`，禁用即 clearInterval 自退（防 `api.setInterval` 泄漏）。

**Tech Stack:** Node.js (CommonJS)、`node:test` + `node:assert/strict`、wttr.in 天气 API（全局 `fetch`）、官方插件仓库 `D:\claudeswork\official-plugin`（独立 git 仓库）。

**参考：** 设计文档 `docs/superpowers/specs/2026-08-10-weather-nightwatch-plugin-design.md`；插件模式先例 `D:\claudeswork\official-plugin\plugin-claude\plugin-claude.js`。

**提交约定：** 提交到 official-plugin 仓库，commit message 用 `feat: ...` + 中文说明；**绝不加 `Co-Authored-By` 尾注**。本计划所有 commit 在 `D:\claudeswork\official-plugin` 下执行。

---

### Task 1: plugin-weather 实现（TDD）

**Files:**
- Create: `D:\claudeswork\official-plugin\plugin-weather\plugin-weather.js`
- Create: `D:\claudeswork\official-plugin\plugin-weather\test\weather.test.js`

- [ ] **Step 1: 写失败测试**

创建 `D:\claudeswork\official-plugin\plugin-weather\test\weather.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../plugin-weather.js');
const { mapWeather, isSevereWeather, parseWttr, evaluate } = _test;

const CFG = {
  enabled: true, city: 'Beijing', checkIntervalMinutes: 30,
  notifyConditionChange: true, conditionChangeSeverity: 'NeutralEvent',
  notifyTempSwing: true, tempSwingThreshold: 5, tempSwingSeverity: 'NegativeEvent',
  notifyDailyBriefing: true, briefingHour: 7, briefingSeverity: 'NeutralEvent',
  notifySevere: true, heatThreshold: 35, freezeThreshold: -5, severeSeverity: 'ThreatBig'
};

test('mapWeather: 常见词映射为中文', () => {
  assert.equal(mapWeather('Sunny'), '晴朗');
  assert.equal(mapWeather('Partly cloudy'), '多云');
  assert.equal(mapWeather('Heavy rain'), '暴雨');
  assert.equal(mapWeather('Blizzard'), '暴风雪');
  assert.equal(mapWeather('UnknownXyz'), 'UnknownXyz'); // 未收录保留原文
  assert.equal(mapWeather(''), '');
});

test('isSevereWeather: 恶劣集命中/未命中', () => {
  assert.equal(isSevereWeather('暴雨'), true);
  assert.equal(isSevereWeather('雷暴'), true);
  assert.equal(isSevereWeather('晴朗'), false);
});

test('parseWttr: 正常解析', () => {
  const json = {
    current_condition: [{ temp_C: '33', weatherDesc: [{ value: 'Sunny' }] }],
    weather: [{ date: '2026-08-10', maxtempC: '33', mintempC: '22' }]
  };
  assert.deepEqual(parseWttr(json), { weather: '晴朗', temp: 33, max: 33, min: 22 });
});

test('parseWttr: 结构不符返回 null', () => {
  assert.equal(parseWttr({}), null);
  assert.equal(parseWttr(null), null);
});

test('evaluate: 状况变化来信并更新基线', () => {
  const state = { weather: '晴朗', temp: 30, lastBriefingDate: '', lastSevereNotified: false };
  const current = { weather: '降雨', temp: 30, max: 33, min: 22 };
  const now = new Date(2026, 7, 10, 10, 0);
  const { letters, next } = evaluate(state, current, now, CFG);
  assert.equal(letters.length, 1);
  assert.equal(letters[0].title, '天气变化');
  assert.match(letters[0].description, /晴朗 → 降雨/);
  assert.equal(next.weather, '降雨');
});

test('evaluate: 温度骤变达阈值来信', () => {
  const state = { weather: '晴朗', temp: 25, lastBriefingDate: '', lastSevereNotified: false };
  const current = { weather: '晴朗', temp: 30, max: 30, min: 22 };
  const now = new Date(2026, 7, 10, 10, 0);
  const { letters } = evaluate(state, current, now, CFG);
  assert.equal(letters.length, 1);
  assert.equal(letters[0].title, '气温骤升');
});

test('evaluate: 温差低于阈值不触发', () => {
  const state = { weather: '晴朗', temp: 30, lastBriefingDate: '', lastSevereNotified: false };
  const current = { weather: '晴朗', temp: 32, max: 32, min: 22 };
  const now = new Date(2026, 7, 10, 10, 0);
  const { letters } = evaluate(state, current, now, CFG);
  assert.equal(letters.length, 0);
});

test('evaluate: 简报时点来信且当日防重', () => {
  const state = { weather: '晴朗', temp: 30, lastBriefingDate: '', lastSevereNotified: false };
  const current = { weather: '晴朗', temp: 30, max: 33, min: 22 };
  const now = new Date(2026, 7, 10, 7, 5);
  const r1 = evaluate(state, current, now, CFG);
  assert.equal(r1.letters.length, 1);
  assert.equal(r1.letters[0].title, '今日天气');
  assert.equal(r1.letters[0].description, '晴朗，33°C / 22°C');
  const r2 = evaluate(r1.next, current, now, CFG); // 同日再评估 → 不发
  assert.equal(r2.letters.length, 0);
});

test('evaluate: 恶劣预警触发一次，恢复后重置', () => {
  const state = { weather: '晴朗', temp: 30, lastBriefingDate: '', lastSevereNotified: false };
  const current = { weather: '暴雨', temp: 26, max: 26, min: 22 };
  const now = new Date(2026, 7, 10, 10, 0);
  const r1 = evaluate(state, current, now, CFG);
  assert.ok(r1.letters.some(l => l.title === '恶劣天气来袭'));
  const r2 = evaluate(r1.next, current, now, CFG); // 仍恶劣 → 不再发
  assert.ok(!r2.letters.some(l => l.title === '恶劣天气来袭'));
  const recovered = { weather: '晴朗', temp: 26, max: 26, min: 22 };
  const r3 = evaluate(r2.next, recovered, now, CFG);
  assert.equal(r3.next.lastSevereNotified, false);
});

test('evaluate: 插件禁用则无信', () => {
  const state = { weather: '晴朗', temp: 30, lastBriefingDate: '', lastSevereNotified: false };
  const current = { weather: '降雨', temp: 36, max: 33, min: 22 };
  const now = new Date(2026, 7, 10, 7, 5);
  const { letters } = evaluate({ ...state }, current, now, { ...CFG, enabled: false });
  assert.equal(letters.length, 0);
});
```

- [ ] **Step 2: 创建 stub 插件文件**

创建 `D:\claudeswork\official-plugin\plugin-weather\plugin-weather.js`（函数全部抛「未实现」，测试将失败）：

```js
// plugin-weather.js — 环境事件信（RimLetter）[stub]
'use strict';
function mapWeather() { throw new Error('not implemented'); }
function isSevereWeather() { throw new Error('not implemented'); }
function parseWttr() { throw new Error('not implemented'); }
function evaluate() { throw new Error('not implemented'); }
function fmtDate() { throw new Error('not implemented'); }
function isPluginDisabled() { throw new Error('not implemented'); }
module.exports = async ({ api, logger }) => {};
module.exports._test = { mapWeather, isSevereWeather, parseWttr, evaluate, fmtDate, isPluginDisabled };
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd "D:\claudeswork\official-plugin\plugin-weather" && node --test test/weather.test.js`
Expected: 多个 test FAIL，错误信息含 `not implemented`。

- [ ] **Step 4: 实现完整插件文件**

**整体替换** `D:\claudeswork\official-plugin\plugin-weather\plugin-weather.js` 为：

```js
// plugin-weather.js — 环境事件信（RimLetter）
// 轮询 wttr.in，天气状况变化 / 气温骤变 / 每日简报 / 恶劣天气预警 四类事件来信。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SEVERITIES = [
  { value: 'ThreatBig', label: '重大威胁' },
  { value: 'ThreatSmall', label: '威胁' },
  { value: 'NegativeEvent', label: '负面' },
  { value: 'NeutralEvent', label: '中性' },
  { value: 'PositiveEvent', label: '正面' }
];

// wttr.in weatherDesc（英文）→ RimWorld 风味中文
const WEATHER_MAP = {
  'Sunny': '晴朗',
  'Clear': '晴朗',
  'Sunny with cloudy intervals': '晴间多云',
  'Partly cloudy': '多云',
  'Cloudy': '阴',
  'Overcast': '阴',
  'Mist': '薄雾',
  'Fog': '浓雾',
  'Foggy': '浓雾',
  'Patchy light drizzle': '小雨',
  'Light drizzle': '小雨',
  'Drizzle': '小雨',
  'Patchy light rain': '小雨',
  'Light rain': '小雨',
  'Light rain shower': '小雨',
  'Patchy rain possible': '小雨',
  'Rain': '降雨',
  'Moderate rain': '降雨',
  'Moderate or heavy rain shower': '阵雨',
  'Rain shower': '阵雨',
  'Heavy rain': '暴雨',
  'Heavy rain shower': '暴雨',
  'Torrential rain shower': '暴雨',
  'Sleet': '雨夹雪',
  'Freezing rain': '冻雨',
  'Light snow': '小雪',
  'Patchy light snow': '小雪',
  'Snow': '降雪',
  'Heavy snow': '大雪',
  'Snow shower': '阵雪',
  'Blizzard': '暴风雪',
  'Thundery outbreaks possible': '雷暴',
  'Thundery outbreaks': '雷暴',
  'Thunderstorm': '雷暴',
  'Patchy light rain with thunder': '雷阵雨',
  'Moderate or heavy rain with thunder': '雷暴雨',
  'Hail': '冰雹'
};
const SEVERE_SET = ['浓雾', '暴雨', '冻雨', '大雪', '暴风雪', '雷暴', '雷暴雨', '冰雹'];

function mapWeather(desc) {
  if (!desc) return '';
  return WEATHER_MAP[desc] || desc;
}
function isSevereWeather(weatherZh) {
  return SEVERE_SET.includes(weatherZh);
}

// wttr.in j1 JSON → { weather, temp, max, min }；结构不符返回 null
function parseWttr(json) {
  if (!json || !json.current_condition || !json.weather) return null;
  const cur = json.current_condition[0];
  const today = json.weather[0];
  if (!cur || !today) return null;
  const desc = (cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '';
  const temp = cur.temp_C !== undefined ? Number(cur.temp_C) : null;
  const max = today.maxtempC !== undefined ? Number(today.maxtempC) : null;
  const min = today.mintempC !== undefined ? Number(today.mintempC) : null;
  return { weather: mapWeather(desc), temp, max, min };
}

function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 比对上次状态，生成本轮要发的信（可多封）+ 下一状态；now 为当前 Date
function evaluate(state, current, now, cfg) {
  if (!cfg.enabled) return { letters: [], next: state };
  const letters = [];
  const next = { ...state };
  const tempTxt = current.temp != null ? `（当前 ${current.temp}°C）` : '';
  // 1. 天气状况变化
  if (cfg.notifyConditionChange && state.weather && current.weather && current.weather !== state.weather) {
    letters.push({ severity: cfg.conditionChangeSeverity, title: '天气变化', description: `${state.weather} → ${current.weather}${tempTxt}`, sound: 'auto' });
  }
  if (current.weather) next.weather = current.weather;
  // 2. 温度骤变
  if (cfg.notifyTempSwing && state.temp !== null && current.temp !== null) {
    const d = current.temp - state.temp;
    if (Math.abs(d) >= cfg.tempSwingThreshold) {
      letters.push({ severity: cfg.tempSwingSeverity, title: `气温骤${d > 0 ? '升' : '降'}`, description: `较上次检测${d > 0 ? '上升' : '下降'} ${Math.abs(d).toFixed(1)}°C（当前 ${current.temp}°C）`, sound: 'auto' });
    }
  }
  if (current.temp !== null) next.temp = current.temp;
  // 3. 每日简报（按本地日期防重）
  const today = fmtDate(now);
  if (cfg.notifyDailyBriefing && today !== state.lastBriefingDate && now.getHours() === cfg.briefingHour) {
    const maxTxt = current.max != null ? `${current.max}°C` : '--';
    const minTxt = current.min != null ? `${current.min}°C` : '--';
    letters.push({ severity: cfg.briefingSeverity, title: '今日天气', description: `${current.weather}，${maxTxt} / ${minTxt}`, sound: 'auto' });
    next.lastBriefingDate = today;
  }
  // 4. 恶劣天气预警（防刷：恢复常态才重置）
  if (cfg.notifySevere) {
    const severe = isSevereWeather(current.weather) ||
      (current.temp !== null && current.temp >= cfg.heatThreshold) ||
      (current.temp !== null && current.temp <= cfg.freezeThreshold);
    if (severe && !state.lastSevereNotified) {
      letters.push({ severity: cfg.severeSeverity, title: '恶劣天气来袭', description: `${current.weather}${tempTxt}`, sound: 'auto' });
    }
    next.lastSevereNotified = severe;
  }
  return { letters, next };
}

// 与 config.json 同目录（%APPDATA%\rimletter）；不用 electron（纯 Node）
function userDataDir() {
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'rimletter') : path.join(os.homedir(), '.rimletter');
}
// 插件是否在 config.json 的 plugins.disabled 中（禁用后 tick 自检 → clearInterval 自退）
function isPluginDisabled(pluginName) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'config.json'), 'utf-8'));
    return !!((cfg.plugins && cfg.plugins.disabled) || []).includes(pluginName);
  } catch { return false; }
}

module.exports = async ({ api, logger }) => {}; // Task 2 填充加载逻辑
module.exports._test = { mapWeather, isSevereWeather, parseWttr, evaluate, fmtDate, isPluginDisabled };
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd "D:\claudeswork\official-plugin\plugin-weather" && node --test test/weather.test.js`
Expected: 全部 PASS（11 个 test）。

- [ ] **Step 6: Commit**

```bash
cd "D:\claudeswork\official-plugin"
git add plugin-weather/test/weather.test.js plugin-weather/plugin-weather.js
git commit -m "feat: plugin-weather 核心纯函数（天气映射/四类触发判定）+ 单测"
```

---

### Task 2: plugin-weather 加载逻辑

**Files:**
- Modify: `D:\claudeswork\official-plugin\plugin-weather\plugin-weather.js`（替换 `module.exports = async ({ api, logger }) => {};` 为真实加载逻辑，并新增 `fetchWttr` 函数）

- [ ] **Step 1: 在文件末尾追加 fetchWttr，并替换加载器**

把 `plugin-weather.js` 中的 `module.exports = async ({ api, logger }) => {}; // Task 2 填充加载逻辑` 这一行**替换**为：

```js
async function fetchWttr(city) {
  const url = 'https://wttr.in/' + encodeURIComponent(city) + '?format=j1';
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

module.exports = async ({ api, logger }) => {
  api.registerConfig({
    title: '天气环境事件',
    fields: [
      { key: 'enabled', label: '启用插件', type: 'bool', default: true },
      { key: 'city', label: '城市（名称或坐标）', type: 'text', default: '' },
      { key: 'checkIntervalMinutes', label: '轮询间隔（分钟）', type: 'slider', default: 30, min: 15, max: 180, step: 5, unit: '分钟' },
      { key: 'notifyConditionChange', label: '天气状况变化来信', type: 'bool', default: true },
      { key: 'conditionChangeSeverity', label: '状况信紧急度', type: 'select', options: SEVERITIES, default: 'NeutralEvent' },
      { key: 'notifyTempSwing', label: '气温骤变来信', type: 'bool', default: true },
      { key: 'tempSwingThreshold', label: '温差阈值（°C）', type: 'number', default: 5 },
      { key: 'tempSwingSeverity', label: '骤变信紧急度', type: 'select', options: SEVERITIES, default: 'NegativeEvent' },
      { key: 'notifyDailyBriefing', label: '每日天气简报来信', type: 'bool', default: true },
      { key: 'briefingHour', label: '简报时点（时）', type: 'number', default: 7 },
      { key: 'briefingSeverity', label: '简报信紧急度', type: 'select', options: SEVERITIES, default: 'NeutralEvent' },
      { key: 'notifySevere', label: '恶劣天气预警来信', type: 'bool', default: true },
      { key: 'heatThreshold', label: '高温预警阈值（°C）', type: 'number', default: 35 },
      { key: 'freezeThreshold', label: '严寒预警阈值（°C）', type: 'number', default: -5 },
      { key: 'severeSeverity', label: '恶劣信紧急度', type: 'select', options: SEVERITIES, default: 'ThreatBig' }
    ]
  });

  const cfgRef = { current: api.getConfig() };
  api.on('config', next => { cfgRef.current = next; reschedule(); });

  const pluginName = path.basename(__filename, '.js');
  // 全局注册表：重载时清理旧定时器（api.setInterval 重载不清除，防止双定时器/泄漏）；状态跨重载保留
  const reg = global.__rimletterWeather || (global.__rimletterWeather = {
    timer: null,
    state: { weather: '', temp: null, lastBriefingDate: '', lastSevereNotified: false }
  });
  if (reg.timer) { clearInterval(reg.timer); reg.timer = null; }

  async function tick() {
    if (isPluginDisabled(pluginName)) {
      if (reg.timer) { clearInterval(reg.timer); reg.timer = null; }
      return;
    }
    const cfg = cfgRef.current;
    if (!cfg.enabled || !cfg.city) return;
    let current;
    try { current = parseWttr(await fetchWttr(cfg.city)); }
    catch (e) { logger.warn('天气请求失败: ' + (e.message || e)); return; }
    if (!current) { logger.warn('城市解析失败，请检查城市名/坐标'); return; }
    const { letters, next } = evaluate(reg.state, current, new Date(), cfg);
    reg.state = next;
    for (const l of letters) api.letter(l);
  }

  function reschedule() {
    if (reg.timer) { clearInterval(reg.timer); reg.timer = null; }
    const cfg = cfgRef.current;
    if (!cfg.enabled || !cfg.city) return;
    reg.timer = api.setInterval(tick, cfg.checkIntervalMinutes * 60 * 1000);
    tick(); // 立即跑一轮（建基线）
  }

  reschedule();
  logger.info('天气插件已启动，城市=' + (cfgRef.current.city || '未设置'));
};
```

并把 `module.exports._test = {...}` 行**追加** `fetchWttr` 到导出对象（改成 `module.exports._test = { mapWeather, isSevereWeather, parseWttr, evaluate, fmtDate, isPluginDisabled, fetchWttr };`）。

- [ ] **Step 2: 运行单测确认未破坏**

Run: `cd "D:\claudeswork\official-plugin\plugin-weather" && node --test test/weather.test.js`
Expected: 全部 PASS。

- [ ] **Step 3: 加载检查（模拟 RimLetter 调用，city 为空不触发网络）**

Run（在 `plugin-weather` 目录）：
```bash
node -e "const loader=require('./plugin-weather.js'); let schema=null; const api={registerConfig:s=>{schema=s;},getConfig:()=>({}),on:()=>{},setInterval:()=>1,letter:l=>console.log('letter:',l.title)}; loader({api,logger:console}).then(()=>{console.log('schema fields:',schema.fields.length,'| keys:',schema.fields.map(f=>f.key).join(','));});"
```
Expected: 输出 `schema fields: 15 | keys: enabled,city,checkIntervalMinutes,...`，无异常、无网络请求（city 为空时 reschedule 不启动定时器）。

- [ ] **Step 4: Commit**

```bash
cd "D:\claudeswork\official-plugin"
git add plugin-weather/plugin-weather.js
git commit -m "feat: plugin-weather 加载逻辑（registerConfig/轮询/禁用自检）"
```

---

### Task 3: plugin-weather README + 安装

**Files:**
- Create: `D:\claudeswork\official-plugin\plugin-weather\README.md`

- [ ] **Step 1: 写 README**

创建 `D:\claudeswork\official-plugin\plugin-weather\README.md`：

```markdown
# plugin-weather 天气环境事件

RimLetter 插件：轮询天气，四类环境事件从屏幕右缘滑入「信」——天气状况变化、气温骤变、每日天气简报、恶劣天气预警。

## 安装

1. 把 `plugin-weather.js` 复制到 `%APPDATA%\rimletter\plugins\`（设置窗「打开插件目录」可直达）
2. 在 设置 → 插件管理 中启用
3. 设置 → 插件管理 → 天气环境事件 → 填「城市」（如 `Beijing` / `上海` / `39.9,116.4`）

## 配置

| 字段 | 说明 | 默认 |
|---|---|---|
| 启用插件 | 总开关 | 开 |
| 城市 | 城市名或坐标；留空不轮询 | 空 |
| 轮询间隔（分钟） | 多久查一次天气 | 30 |
| 天气状况变化来信 | 晴→雨等变化来信 | 开 |
| 状况信紧急度 | | 中性 |
| 气温骤变来信 | 温差 ≥ 阈值来信 | 开 |
| 温差阈值（°C） | | 5 |
| 骤变信紧急度 | | 负面 |
| 每日天气简报来信 | 每天固定时点一封当天概览 | 开 |
| 简报时点（时） | | 7 |
| 简报信紧急度 | | 中性 |
| 恶劣天气预警来信 | 暴雨/雷暴/浓雾/高温(≥35°C)/严寒(≤-5°C) 来信 | 开 |
| 高温预警阈值（°C） | | 35 |
| 严寒预警阈值（°C） | | -5 |
| 恶劣信紧急度 | | 重大威胁 |

紧急度可选：ThreatBig（重大威胁）/ ThreatSmall（威胁）/ NegativeEvent（负面）/ NeutralEvent（中性）/ PositiveEvent（正面）。

## 数据源

[wttr.in](https://wttr.in)（免费、无需 key）。天气词自动映射为中文（晴朗/多云/阴/降雨/暴雨/降雪/雷暴/…）。

## 故障排查

- **不来信**：确认插件已启用、城市已填写、对应触发开关为开；看主进程日志有无 `天气请求失败`
- **城市解析失败**：日志提示后检查城市名，或用经纬度格式 `39.9,116.4`
- **网络失败**：离线时本轮跳过、下轮自动重试，不发信

支持 RimLetter v0.2.5+
```

- [ ] **Step 2: 安装到本地插件目录（便于用户直接测试）**

Run:
```bash
cp "D:\claudeswork\official-plugin\plugin-weather\plugin-weather.js" "$APPDATA/rimletter/plugins/plugin-weather.js"
```
Expected: 复制成功（若 RimLetter 正在运行，需在 设置→插件管理 点「重新加载」或重启后生效）。

- [ ] **Step 3: Commit**

```bash
cd "D:\claudeswork\official-plugin"
git add plugin-weather/README.md
git commit -m "docs: plugin-weather README（安装/配置/排查）"
```

---

### Task 4: plugin-night-watch 实现（TDD）

**Files:**
- Create: `D:\claudeswork\official-plugin\plugin-night-watch\plugin-night-watch.js`
- Create: `D:\claudeswork\official-plugin\plugin-night-watch\test\nightwatch.test.js`

- [ ] **Step 1: 写失败测试**

创建 `D:\claudeswork\official-plugin\plugin-night-watch\test\nightwatch.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../plugin-night-watch.js');
const { fmtDate, fmtHM, isRemindTime, shouldSend } = _test;

const CFG = { enabled: true, remindHour: 23, remindMinute: 30, severity: 'ThreatBig', message: '夜深了，殖民者需要休息' };

test('fmtDate: YYYY-MM-DD', () => {
  assert.equal(fmtDate(new Date(2026, 7, 10, 23, 30)), '2026-08-10');
});

test('fmtHM: HH:MM 补零', () => {
  assert.equal(fmtHM(new Date(2026, 7, 10, 23, 30)), '23:30');
  assert.equal(fmtHM(new Date(2026, 7, 10, 9, 5)), '09:05');
});

test('isRemindTime: 命中/未命中', () => {
  assert.equal(isRemindTime(new Date(2026, 7, 10, 23, 30), CFG), true);
  assert.equal(isRemindTime(new Date(2026, 7, 10, 23, 29), CFG), false);
  assert.equal(isRemindTime(new Date(2026, 7, 10, 22, 30), CFG), false);
});

test('shouldSend: 时点命中且今日未发 → true', () => {
  const now = new Date(2026, 7, 10, 23, 30);
  assert.equal(shouldSend({}, now, CFG), true);
});

test('shouldSend: 今日已发 → false', () => {
  const now = new Date(2026, 7, 10, 23, 30);
  assert.equal(shouldSend({ lastSentDate: '2026-08-10' }, now, CFG), false);
});

test('shouldSend: 未到时点 → false', () => {
  const now = new Date(2026, 7, 10, 22, 0);
  assert.equal(shouldSend({}, now, CFG), false);
});

test('shouldSend: 插件禁用 → false', () => {
  const now = new Date(2026, 7, 10, 23, 30);
  assert.equal(shouldSend({}, now, { ...CFG, enabled: false }), false);
});
```

- [ ] **Step 2: 创建 stub 插件文件**

创建 `D:\claudeswork\official-plugin\plugin-night-watch\plugin-night-watch.js`：

```js
// plugin-night-watch.js — 深夜提醒（RimLetter）[stub]
'use strict';
function fmtDate() { throw new Error('not implemented'); }
function fmtHM() { throw new Error('not implemented'); }
function isRemindTime() { throw new Error('not implemented'); }
function shouldSend() { throw new Error('not implemented'); }
function loadState() { throw new Error('not implemented'); }
function saveState() { throw new Error('not implemented'); }
function isPluginDisabled() { throw new Error('not implemented'); }
module.exports = async ({ api, logger }) => {};
module.exports._test = { fmtDate, fmtHM, isRemindTime, shouldSend, loadState, saveState, isPluginDisabled };
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd "D:\claudeswork\official-plugin\plugin-night-watch" && node --test test/nightwatch.test.js`
Expected: 多个 test FAIL，错误信息含 `not implemented`。

- [ ] **Step 4: 实现完整插件文件**

**整体替换** `D:\claudeswork\official-plugin\plugin-night-watch\plugin-night-watch.js` 为：

```js
// plugin-night-watch.js — 深夜提醒（RimLetter）
// 每晚固定时点来一封「夜深了」红信；lastSentDate 持久化到状态文件避免重启补发。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SEVERITIES = [
  { value: 'ThreatBig', label: '重大威胁' },
  { value: 'ThreatSmall', label: '威胁' },
  { value: 'NegativeEvent', label: '负面' },
  { value: 'NeutralEvent', label: '中性' },
  { value: 'PositiveEvent', label: '正面' }
];
const TICK_MS = 30 * 1000;

function userDataDir() {
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'rimletter') : path.join(os.homedir(), '.rimletter');
}
function stateFilePath() { return path.join(userDataDir(), 'plugin-night-watch.json'); }

function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtHM(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function isRemindTime(now, cfg) {
  return now.getHours() === cfg.remindHour && now.getMinutes() === cfg.remindMinute;
}
function shouldSend(state, now, cfg) {
  if (!cfg.enabled) return false;
  if (!isRemindTime(now, cfg)) return false;
  return state.lastSentDate !== fmtDate(now);
}

// lastSentDate 状态文件读写（重启防补发）
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFilePath(), 'utf-8')); }
  catch { return {}; }
}
function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2));
  } catch { /* 写失败忽略，下次再试 */ }
}

// 插件是否在 config.json 的 plugins.disabled 中（禁用后 tick 自检 → clearInterval 自退）
function isPluginDisabled(pluginName) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'config.json'), 'utf-8'));
    return !!((cfg.plugins && cfg.plugins.disabled) || []).includes(pluginName);
  } catch { return false; }
}

module.exports = async ({ api, logger }) => {
  api.registerConfig({
    title: '深夜提醒',
    fields: [
      { key: 'enabled', label: '启用插件', type: 'bool', default: true },
      { key: 'remindHour', label: '提醒时点（时）', type: 'number', default: 23 },
      { key: 'remindMinute', label: '提醒时点（分）', type: 'number', default: 30 },
      { key: 'severity', label: '信紧急度', type: 'select', options: SEVERITIES, default: 'ThreatBig' },
      { key: 'message', label: '信文案', type: 'text', default: '夜深了，殖民者需要休息' }
    ]
  });

  const cfgRef = { current: api.getConfig() };
  api.on('config', next => { cfgRef.current = next; });

  const pluginName = path.basename(__filename, '.js');
  // 全局注册表：重载时清理旧定时器；状态文件与内存双保险
  const reg = global.__rimletterNightWatch || (global.__rimletterNightWatch = { timer: null, state: null });
  if (reg.timer) { clearInterval(reg.timer); reg.timer = null; }
  if (!reg.state) reg.state = loadState();

  function tick() {
    if (isPluginDisabled(pluginName)) {
      if (reg.timer) { clearInterval(reg.timer); reg.timer = null; }
      return;
    }
    const cfg = cfgRef.current;
    const now = new Date();
    if (!shouldSend(reg.state, now, cfg)) return;
    reg.state.lastSentDate = fmtDate(now);
    saveState(reg.state);
    api.letter({ severity: cfg.severity, title: '夜深了', description: `${cfg.message}（现在是 ${fmtHM(now)}）`, sound: 'auto' });
  }

  reg.timer = api.setInterval(tick, TICK_MS);
  logger.info('深夜提醒已启动，每晚 ' + String(cfgRef.current.remindHour).padStart(2, '0') + ':' + String(cfgRef.current.remindMinute).padStart(2, '0') + ' 来信');
};

module.exports._test = { fmtDate, fmtHM, isRemindTime, shouldSend, loadState, saveState, isPluginDisabled };
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd "D:\claudeswork\official-plugin\plugin-night-watch" && node --test test/nightwatch.test.js`
Expected: 全部 PASS（7 个 test）。

- [ ] **Step 6: Commit**

```bash
cd "D:\claudeswork\official-plugin"
git add plugin-night-watch/test/nightwatch.test.js plugin-night-watch/plugin-night-watch.js
git commit -m "feat: plugin-night-watch 深夜提醒（时点命中/状态持久化）+ 单测"
```

---

### Task 5: plugin-night-watch README + 安装

**Files:**
- Create: `D:\claudeswork\official-plugin\plugin-night-watch\README.md`

- [ ] **Step 1: 写 README**

创建 `D:\claudeswork\official-plugin\plugin-night-watch\README.md`：

```markdown
# plugin-night-watch 深夜提醒

RimLetter 插件：每晚固定时点从屏幕右缘滑入一封「夜深了」红信，提醒休息，一天一封不重复。

## 安装

1. 把 `plugin-night-watch.js` 复制到 `%APPDATA%\rimletter\plugins\`（设置窗「打开插件目录」可直达）
2. 在 设置 → 插件管理 中启用

## 配置

| 字段 | 说明 | 默认 |
|---|---|---|
| 启用插件 | 总开关 | 开 |
| 提醒时点（时） | 0–23 | 23 |
| 提醒时点（分） | 0–59 | 30 |
| 信紧急度 | | 重大威胁（ThreatBig 红信） |
| 信文案 | 信描述正文 | 夜深了，殖民者需要休息 |

信标题固定「夜深了」，描述 = 文案 + `（现在是 HH:MM）`。

## 防重复

`lastSentDate` 写入 `%APPDATA%\rimletter\plugin-night-watch.json`，应用重启不会在同日补发。

## 故障排查

- **没来信**：确认插件已启用、时点配置正确；主进程日志应输出「深夜提醒已启动，每晚 HH:MM 来信」
- **重启后补发**：正常情况下不会；若状态文件被删除会补发一封（属预期）

支持 RimLetter v0.2.5+
```

- [ ] **Step 2: 安装到本地插件目录**

Run:
```bash
cp "D:\claudeswork\official-plugin\plugin-night-watch\plugin-night-watch.js" "$APPDATA/rimletter/plugins/plugin-night-watch.js"
```
Expected: 复制成功（RimLetter 运行中需 重新加载/重启 后生效）。

- [ ] **Step 3: Commit**

```bash
cd "D:\claudeswork\official-plugin"
git add plugin-night-watch/README.md
git commit -m "docs: plugin-night-watch README（安装/配置/排查）"
```

---

### Task 6: official-plugin README 补充可用插件清单

**Files:**
- Modify: `D:\claudeswork\official-plugin\README.md`

- [ ] **Step 1: 追加可用插件清单**

在 `D:\claudeswork\official-plugin\README.md` 的「## 目录约定」小节之后追加：

```markdown
## 可用插件

| 插件 | 说明 |
|---|---|
| `plugin-weather` | 天气环境事件信：天气变化 / 气温骤变 / 每日简报 / 恶劣预警 |
| `plugin-night-watch` | 深夜提醒：每晚固定时点一封「夜深了」红信 |
| `plugin-claude` | Claude Code 对接：授权 / 报错 / 回答完成来信 |

每个插件目录内 README 含安装、配置与故障排查。
```

- [ ] **Step 2: 全仓库测试回归**

Run: `cd "D:\claudeswork\official-plugin" && node --test plugin-*/test/*.test.js`
Expected: 全部 PASS（plugin-claude + plugin-weather + plugin-night-watch 全部测试）。

- [ ] **Step 3: Commit**

```bash
cd "D:\claudeswork\official-plugin"
git add README.md
git commit -m "docs: README 补充可用插件清单（weather/night-watch）"
```

---

## 验证清单（全部完成后人工确认）

- [ ] 三个插件单测全绿（Task 6 Step 2）
- [ ] `plugin-weather.js` / `plugin-night-watch.js` 已复制到 `%APPDATA%\rimletter\plugins\`
- [ ] 用户侧：RimLetter 设置→插件管理 启用两插件；weather 填城市后一轮轮询建基线；night-watch 把时点调到近 1–2 分钟内等信滑入；重启验证 night-watch 不补发
