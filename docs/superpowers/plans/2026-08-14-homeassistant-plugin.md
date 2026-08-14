# Home Assistant 集成插件（测试版）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 RimLetter 能接收 Home Assistant 通知（rest_command 推送→信）并把 HA 实体接入规则引擎告警，全部承载在一个「测试版」官方插件里；核心只加 `api.host` 可配绑定地址。

**Architecture:** 分两个仓库。主仓库 `D:\claudeswork\RIM DESKTOP`（rimletter 本体）做核心改动：`api.host` 可配绑定（`api.js`/`config.js`/`main.js`）+ 设置页输入行 + `formatLetter` 未知 severity 回退。官方插件仓库 `D:\claudeswork\official-plugin`（rimletter-official-plugins）新增 `plugin-homeassistant/`：纯函数（`sanitize`/`entityToValue`/`pickFetch`/`fetchHaStates`/`buildRestCommandYaml`）+ 插件本体（`registerConfig`/`registerSensor`/`registerAction`），实体传感器用**惰性限频刷新**（read() 触发、pollIntervalSec 内最多拉一次 HA，避免孤儿定时器与 monitor 阻塞）。

**Tech Stack:** Node.js（`node:test`/`node:assert`，两个仓库同款）、Electron 主进程（插件在 main 进程内运行，可用 `node:https`）、`fetch`（globalThis.fetch / 可注入 mock）。

**关键设计点（对照 spec）：**
- HA 插件**不用 `setInterval`** 拉 HA —— 插件重载时旧定时器会孤儿泄漏。改用「read() 惰性限频」：传感器 read() 触发 refreshIfDue()，`pollIntervalSec` 内最多一次 HTTP；read() 立即返回缓存，绝不阻塞 monitor 的 2s 轮询。无规则引用 HA 传感器时自然不拉取（与项目「只轮询已启用规则引用的传感器」一致）。
- HA 断连语义依赖 `rules.js`：传感器返回 `{ value: undefined }` → `extractValues` 空数组 → 未告警静默、已告警保持告警不误判恢复。
- 两个仓库分别提交；核心 v0.6.0 发布后，HA 插件的局域网能力才可用（同机现在即可用）。

---

## Phase A：核心改动（主仓库 `D:\claudeswork\RIM DESKTOP`）

### Task 1: API 绑定地址 host 可配

**Files:**
- Modify: `src/main/config.js:12`
- Modify: `src/main/api.js:73-84`
- Modify: `src/main/main.js:407`
- Test: `test/api.test.js`

- [ ] **Step 1: 写失败测试（api.js 需暴露 host() 内省）**

在 `test/api.test.js` 末尾追加：

```js
test('start 缺省 host 绑定 127.0.0.1', async () => {
  const { srv } = await startServer();
  assert.equal(srv.host(), '127.0.0.1');
  await srv.stop();
});

test('start 支持显式指定绑定 host（0.0.0.0）', async () => {
  const srv = createApiServer({
    token: 't', onLetter: () => {}, getState: async () => ({}), getRules: () => [],
    addRule: () => ({}), updateRule: () => ({}), deleteRule: () => ({}), reload: () => ({})
  });
  await srv.start(0, '0.0.0.0');
  assert.equal(srv.host(), '0.0.0.0');
  await srv.stop();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/api.test.js`
Expected: 两个新用例 FAIL —— `srv.host is not a function`（当前 `createApiServer` 未暴露 host()）。

- [ ] **Step 3: 实现 host 参数与内省**

`src/main/config.js`，`DEFAULT_CONFIG.api` 增加 `host`：

```js
  api: { enabled: true, port: 17301, token: 'auto', host: '127.0.0.1', cors: false },
```

`src/main/api.js`，`start` 接受 host，返回对象增加 `host()`：

```js
  return {
    start(p = 0, host = '127.0.0.1') {
      return new Promise(resolve => {
        server = http.createServer(handle);
        server.listen(p, host, () => { port = server.address().port; resolve(); });
      });
    },
    stop() {
      return new Promise(resolve => { if (server) server.close(resolve); else resolve(); });
    },
    host: () => (server && server.address() ? server.address().address : '127.0.0.1'),
    port: () => port
  };
```

`src/main/main.js`，传入 host：

```js
    apiServer.start(config.api.port, config.api.host);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/api.test.js`
Expected: 全部 PASS（含两个新用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/config.js src/main/api.js src/main/main.js test/api.test.js
git commit -m "feat: API 绑定地址 host 可配（api.host，默认 127.0.0.1）"
```

### Task 2: formatLetter 未知 severity 回退 NeutralEvent

**Files:**
- Modify: `src/main/letters.js:5-25`
- Test: `test/letters.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/letters.test.js` 末尾追加：

```js
test('formatLetter 未知 severity 回退 NeutralEvent（外部 payload 传错值不抛错）', () => {
  const L = formatLetter('BogusSeverity', 'x', 'y');
  assert.equal(L.severity, 'NeutralEvent');
  assert.equal(L.tintFile, 'letter-NeutralEvent.png');
  assert.equal(L.sound, 'LetterArrive');
  assert.equal(L.color, '175,176,185');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/letters.test.js`
Expected: 新用例 FAIL —— `LETTERDEFS['BogusSeverity']` 为 undefined，`def.tintFile` 抛 TypeError。

- [ ] **Step 3: 实现回退**

`src/main/letters.js` 的 `formatLetter`，severity 与定义都取「有效值」：

```js
function formatLetter(severity, label, description, extra = {}, dismissMs = DEFAULT_CONFIG.autoDismissMs) {
  // 未知 severity 回退中性（如 HA 等外部 payload 传错值）：染色/音效/紧急度整体按 NeutralEvent，
  // 避免 def 为 undefined 抛错。severity 字段也写回有效值，渲染层观感一致。
  const eff = LETTERDEFS[severity] ? severity : 'NeutralEvent';
  const def = LETTERDEFS[eff];
  const { sound, ...rest } = extra;
  return {
    id: Math.random().toString(36).slice(2, 10),
    severity: eff,
    label,
    description,
    tintFile: def.tintFile,
    color: def.color,
    flashColor: def.flashColor,
    flashInterval: def.flashInterval,
    bounce: def.bounce,
    sound: (sound && sound !== 'auto') ? sound : def.sound,
    dismissMs,
    arrivedAt: Date.now(),
    ...rest
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/letters.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/letters.js test/letters.test.js
git commit -m "fix: formatLetter 未知 severity 回退 NeutralEvent，防外部 payload 传错抛错"
```

### Task 3: 设置页「API 绑定地址」输入行

**Files:**
- Modify: `src/renderer/settings.js`

- [ ] **Step 1: 常规 tab 增加输入行**

`renderGeneral()` 中，在「日志级别」行之后、`'<div class="rw-sep"></div>'` 之前插入：

```js
    '<div class="rw-row"><span class="rw-lbl">API 绑定地址</span>' +
      '<input class="rw-input" id="api-host" value="' + esc((config.api && config.api.host) || '127.0.0.1') + '" style="width:110px">' +
      '<span class="rw-gray">局域网推送时改 0.0.0.0，重启生效</span></div>' +
```

- [ ] **Step 2: 增加 change 处理**

在 `renderGeneral()` 的「日志级别选择」事件绑定之后追加：

```js
  // API 绑定地址（重启生效；只接受主机名/IP 形态，非法输入回退原值）
  const apiHostEl = document.getElementById('api-host');
  if (apiHostEl) apiHostEl.addEventListener('change', () => {
    const v = (apiHostEl.value || '').trim();
    if (!v || !/^[A-Za-z0-9._:-]+$/.test(v)) { apiHostEl.value = (config.api && config.api.host) || '127.0.0.1'; return; }
    config.api = config.api || {};
    config.api.host = v;
    persistConfig();
  });
```

- [ ] **Step 3: 手动验证（渲染层无法单测）**

Run: `npm start`
Expected: 托盘 → 设置 → 常规，出现「API 绑定地址」输入行，默认 `127.0.0.1`；改成 `0.0.0.0` 后点其它处触发 change，`%APPDATA%\rimletter\config.json` 中 `api.host` 变为 `0.0.0.0`。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/settings.js
git commit -m "feat: 设置页新增 API 绑定地址输入（重启生效）"
```

### Task 4: 全量测试确认

**Files:**
- Test: `test/`（全量）

- [ ] **Step 1: 运行全量测试**

Run: `npm test`
Expected: 全部 PASS（156 基线 + 新增 3：Task1 api 2 条 + Task2 letters 1 条 = 159）。

---

## Phase B：HA 插件（官方仓库 `D:\claudeswork\official-plugin`）

> 后续命令默认 `cd D:/claudeswork/official-plugin`。

### Task 5: 插件本体 `plugin-homeassistant/plugin-homeassistant.js`

**Files:**
- Create: `plugin-homeassistant/plugin-homeassistant.js`

- [ ] **Step 1: 写插件文件（含纯函数 + `_test` 导出）**

完整内容：

```js
// plugin-homeassistant.js — Home Assistant 集成（RimLetter 官方插件，测试版）
//
// 功能：
//   1. 接收 HA 通知：HA 侧 rest_command POST 到 RimLetter /letter（配置里「复制 rest_command YAML」生成模板）
//   2. 实体监控：轮询 HA 实体状态，注册成 ha_* 传感器，进 RimLetter 规则引擎告警
//
// 需 RimLetter v0.6.0+（api.host 局域网支持，见设置 → 常规 → API 绑定地址）。
// ⚠ 测试版：功能与边界仍在验证，欢迎反馈 bug：
//   https://github.com/NothingCooker/rimletter-official-plugins/issues
'use strict';

const https = require('node:https');

const SEVERITIES = [
  { value: 'ThreatBig', label: '重大威胁' },
  { value: 'ThreatSmall', label: '威胁' },
  { value: 'NegativeEvent', label: '负面' },
  { value: 'NeutralEvent', label: '中性' },
  { value: 'PositiveEvent', label: '正面' }
];

const STALE_MULTIPLIER = 3;       // 缓存超过 3×刷新间隔视为断连
const ERR_LOG_THROTTLE_MS = 60000; // 同一错误 60s 内最多记一次日志

// 实体 ID → 传感器名后缀：保留 [a-z0-9_]，其余转 _，去连续/首尾下划线。
// 'sensor.Living Room Temp' → 'living_room_temp'
function sanitize(entityId) {
  return String(entityId || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// HA state 对象 → 数值。on/off → 1/0；数字/数字字符串 → Number；其它（含 unavailable/unknown）→ undefined。
function entityToValue(st) {
  if (!st || typeof st !== 'object') return undefined;
  const s = st.state;
  if (s === 'on') return 1;
  if (s === 'off') return 0;
  if (typeof s === 'number') return Number.isFinite(s) ? s : undefined;
  if (typeof s === 'string') {
    const t = s.trim();
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// https 自签场景的 fetch 替代（rejectUnauthorized=false），返回与 fetch 兼容的 { ok, status, json, text }。
function insecureFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      rejectUnauthorized: false
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: async () => JSON.parse(data),
        text: async () => data
      }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// 决定 fetch 实现：https 且 verifySsl=false → insecureFetch；否则用注入的 fetchImpl（默认全局 fetch）。
function pickFetch(fetchImpl, verifySsl, url) {
  if (verifySsl === false && String(url).startsWith('https:')) return insecureFetch;
  return fetchImpl || globalThis.fetch;
}

// 拉取 HA 全量 states 并按 watchSet 过滤 → { entity_id → stateObj }。失败抛错。
async function fetchHaStates(fetchImpl, { haUrl, token, watchSet }) {
  const base = String(haUrl || '').replace(/\/+$/, '');
  const res = await fetchImpl(base + '/api/states', {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('HA /api/states HTTP ' + res.status);
  const states = await res.json();
  if (!Array.isArray(states)) throw new Error('HA /api/states 响应格式异常');
  const out = {};
  for (const st of states) {
    if (st && typeof st.entity_id === 'string' && watchSet.has(st.entity_id)) out[st.entity_id] = st;
  }
  return out;
}

// 生成 HA 侧 rest_command YAML（粘贴进 configuration.yaml 的 rest_command 段）。
function buildRestCommandYaml({ url, token }) {
  const base = String(url || 'http://127.0.0.1:17301').replace(/\/+$/, '');
  const auth = token ? '"' + token + '"' : '!secret rimletter_token';
  return [
    '# RimLetter 收信 rest_command（HA → RimLetter，测试版）',
    '# 用法：自动化里调用 rest_command.rimletter_notify(title=..., message=..., severity=...)',
    '# severity 取值：ThreatBig / ThreatSmall / NegativeEvent / NeutralEvent / PositiveEvent',
    'rest_command:',
    '  rimletter_notify:',
    '    url: "' + base + '/letter"',
    '    method: POST',
    '    content_type: "application/json"',
    '    headers:',
    '      x-rimletter-token: ' + auth,
    '    payload: >-',
    '      {"severity": "{{ severity | default(\'NeutralEvent\') }}",',
    '       "title": "{{ title }}",',
    '       "description": "{{ message | default(\'\') }}"}'
  ].join('\n');
}

module.exports = async ({ api, logger }) => {
  const fields = [
    { key: 'enabled', label: '启用监控', type: 'bool', default: true },
    { key: 'haUrl', label: 'HA 地址', type: 'text', default: 'http://127.0.0.1:8123' },
    { key: 'token', label: 'HA 长期令牌', type: 'text', default: '' },
    { key: 'watchEntities', label: '监控实体（逗号分隔）', type: 'text', default: '' },
    { key: 'pollIntervalSec', label: '刷新间隔（秒）', type: 'number', default: 15, min: 5, max: 300 },
    { key: 'verifySsl', label: '校验 SSL（自签 https 时关闭）', type: 'bool', default: true },
    { key: 'rimLetterUrl', label: 'RimLetter 推送地址', type: 'text', default: 'http://127.0.0.1:17301' },
    { key: 'rimLetterToken', label: 'RimLetter API token', type: 'text', default: '' },
    { key: 'test_connection', label: '测试 HA 连接', type: 'button', buttonText: '测试连接' },
    { key: 'copy_rest_command', label: '生成 HA rest_command', type: 'button', buttonText: '复制 YAML' }
  ];
  api.registerConfig({ title: 'Home Assistant 集成（测试版）', fields });

  const cfgRef = { current: api.getConfig() };
  const state = { cache: {}, lastPollAt: 0, lastErrAt: 0 };
  api.on('config', next => { cfgRef.current = next; registerSensors(); });

  function watchSetOf(cfg) {
    return new Set((cfg.watchEntities || '').split(',').map(s => s.trim()).filter(Boolean));
  }

  // 惰性限频刷新：read() 触发；pollIntervalSec 内最多拉一次；失败保留旧缓存、节流记日志。
  function refreshIfDue() {
    const cfg = cfgRef.current;
    if (!cfg.enabled) return;
    const watchSet = watchSetOf(cfg);
    if (watchSet.size === 0) return;
    const pollMs = (cfg.pollIntervalSec || 15) * 1000;
    const now = Date.now();
    if (now - state.lastPollAt < pollMs) return;
    state.lastPollAt = now;
    const fetchImpl = pickFetch(globalThis.fetch, cfg.verifySsl, cfg.haUrl);
    fetchHaStates(fetchImpl, { haUrl: cfg.haUrl, token: cfg.token, watchSet })
      .then(map => {
        const t = Date.now();
        for (const [id, st] of Object.entries(map)) {
          const v = entityToValue(st);
          if (v === undefined) delete state.cache[id];
          else state.cache[id] = { value: v, ts: t };
        }
      })
      .catch(e => {
        const now2 = Date.now();
        if (now2 - state.lastErrAt >= ERR_LOG_THROTTLE_MS) {
          state.lastErrAt = now2;
          logger.warn('HA 拉取失败（检查 haUrl/token/连接/证书）: ' + (e && e.message || e));
        }
      });
  }

  // 每个监控实体注册一个 ha_* 传感器（同名替换；重载插件后旧实体传感器自动清除）。
  function registerSensors() {
    const cfg = cfgRef.current;
    const pollMs = (cfg.pollIntervalSec || 15) * 1000;
    for (const entityId of watchSetOf(cfg)) {
      const name = 'ha_' + sanitize(entityId);
      if (!name || name === 'ha_') continue;
      api.registerSensor(name, async () => {
        if (!cfgRef.current.enabled) return { value: undefined };
        refreshIfDue();
        const c = state.cache[entityId];
        const val = (c && Date.now() - c.ts < STALE_MULTIPLIER * pollMs) ? c.value : undefined;
        return { value: val };
      });
    }
  }
  registerSensors();

  if (api.registerAction) {
    api.registerAction('test_connection', async () => {
      const cfg = cfgRef.current;
      const fetchImpl = pickFetch(globalThis.fetch, cfg.verifySsl, cfg.haUrl);
      try {
        const base = String(cfg.haUrl || '').replace(/\/+$/, '');
        const res = await fetchImpl(base + '/api/', { headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const info = await res.json();
        const st = await fetchImpl(base + '/api/states', { headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(10000) });
        const states = await st.json();
        const n = Array.isArray(states) ? states.length : 0;
        return '连接成功：HA ' + (info.version || '?') + '，共 ' + n + ' 个实体';
      } catch (e) {
        return '连接失败：' + (e && e.message || e) + '（检查 haUrl/token）';
      }
    });
    api.registerAction('copy_rest_command', async () => {
      const cfg = cfgRef.current;
      return buildRestCommandYaml({ url: cfg.rimLetterUrl, token: cfg.rimLetterToken });
    });
  }

  logger.info('Home Assistant 集成（测试版）已加载：' + (cfgRef.current.haUrl || '') + '，监控 ' + watchSetOf(cfgRef.current).size + ' 个实体');
};

module.exports._test = { sanitize, entityToValue, pickFetch, fetchHaStates, buildRestCommandYaml, insecureFetch };
```

- [ ] **Step 2: 语法检查**

Run: `node -c plugin-homeassistant/plugin-homeassistant.js`
Expected: 无输出（语法 OK）。

### Task 6: 插件纯函数单测

**Files:**
- Create: `plugin-homeassistant/test/ha.test.js`

- [ ] **Step 1: 写测试**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../plugin-homeassistant.js');
const { sanitize, entityToValue, pickFetch, fetchHaStates, buildRestCommandYaml } = _test;

test('sanitize: 实体 ID → 传感器名后缀', () => {
  assert.equal(sanitize('sensor.living_room_temperature'), 'living_room_temperature');
  assert.equal(sanitize('sensor.Living Room Temp'), 'living_room_temp');
  assert.equal(sanitize('binary_sensor.front_door'), 'binary_sensor_front_door');
  assert.equal(sanitize(''), '');
});

test('entityToValue: on/off → 1/0', () => {
  assert.equal(entityToValue({ state: 'on' }), 1);
  assert.equal(entityToValue({ state: 'off' }), 0);
});

test('entityToValue: 数字与数字字符串 → Number', () => {
  assert.equal(entityToValue({ state: 23.5 }), 23.5);
  assert.equal(entityToValue({ state: '23.5' }), 23.5);
  assert.equal(entityToValue({ state: '0' }), 0);
});

test('entityToValue: 非数值状态（unavailable/文本）→ undefined', () => {
  assert.equal(entityToValue({ state: 'unavailable' }), undefined);
  assert.equal(entityToValue({ state: 'heating' }), undefined);
  assert.equal(entityToValue({ state: '' }), undefined);
  assert.equal(entityToValue(null), undefined);
  assert.equal(entityToValue(undefined), undefined);
});

test('buildRestCommandYaml: 生成可粘贴的 rest_command 模板', () => {
  const yaml = buildRestCommandYaml({ url: 'http://192.168.1.100:17301', token: 'abc' });
  assert.match(yaml, /url: "http:\/\/192\.168\.1\.100:17301\/letter"/);
  assert.match(yaml, /x-rimletter-token: "abc"/);
  assert.match(yaml, /rest_command:/);
  assert.match(yaml, /payload: >-/);
});

test('buildRestCommandYaml: token 为空时用 !secret 占位', () => {
  const yaml = buildRestCommandYaml({ url: 'http://127.0.0.1:17301', token: '' });
  assert.match(yaml, /x-rimletter-token: !secret rimletter_token/);
});

test('fetchHaStates: 拉全量并过滤 watchSet', async () => {
  const fake = async () => ({
    ok: true, status: 200,
    json: async () => [
      { entity_id: 'sensor.temperature', state: '23.5' },
      { entity_id: 'binary_sensor.door', state: 'on' },
      { entity_id: 'light.living_room', state: 'unavailable' }
    ]
  });
  const watchSet = new Set(['sensor.temperature', 'binary_sensor.door']);
  const out = await fetchHaStates(fake, { haUrl: 'http://127.0.0.1:8123', token: 't', watchSet });
  assert.ok(out['sensor.temperature']);
  assert.ok(out['binary_sensor.door']);
  assert.ok(!out['light.living_room']);
});

test('fetchHaStates: HTTP 错误抛错', async () => {
  const fake = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => fetchHaStates(fake, { haUrl: 'http://x', token: 't', watchSet: new Set() }));
});

test('fetchHaStates: 请求带 Bearer token 头', async () => {
  let captured;
  const fake = async (url, opts) => { captured = opts.headers; return { ok: true, status: 200, json: async () => [] }; };
  await fetchHaStates(fake, { haUrl: 'http://x', token: 'secret', watchSet: new Set() });
  assert.equal(captured.Authorization, 'Bearer secret');
});

test('pickFetch: https + verifySsl=false → insecureFetch；否则用注入实现', () => {
  const fakeFetch = () => {};
  assert.equal(pickFetch(fakeFetch, false, 'https://ha:8123'), _test.insecureFetch);
  assert.equal(pickFetch(fakeFetch, true, 'https://ha:8123'), fakeFetch);
  assert.equal(pickFetch(fakeFetch, false, 'http://ha:8123'), fakeFetch);
});
```

- [ ] **Step 2: 运行测试**

Run: `node --test plugin-homeassistant/test/`
Expected: 全部 PASS（10 条）。

- [ ] **Step 3: 提交**

```bash
git add plugin-homeassistant/
git commit -m "feat: HA 集成插件（测试版）——收信 rest_command + 实体监控（含纯函数单测）"
```

### Task 7: 插件 README（Beta 标注 + 使用说明）

**Files:**
- Create: `plugin-homeassistant/README.md`

- [ ] **Step 1: 写 README**

```markdown
# Home Assistant 集成（测试版）

> ⚠ **测试版**：功能与边界仍在验证，欢迎反馈 bug —— [GitHub Issues](https://github.com/NothingCooker/rimletter-official-plugins/issues)

把 Home Assistant 接进 RimLetter：HA 通知滑入屏幕右侧变成环世界风格的信，HA 实体接入规则引擎告警。
需 **RimLetter v0.6.0+**（局域网能力依赖 `api.host`）。

## 功能

1. **接收 HA 通知**：HA 自动化经 `rest_command` POST 到 RimLetter `/letter`，显示成信。
2. **实体监控**：轮询 HA 实体状态，注册成 `ha_*` 传感器，可在 RimLetter 设置 → 规则编辑器里像 CPU/内存一样配阈值告警。

## 安装与配置

设置 → 插件管理 → 从市场安装「Home Assistant 集成」，然后填写：

| 字段 | 说明 |
|---|---|
| HA 地址 | `http://127.0.0.1:8123`（同机）或 `http://<HA 设备 IP>:8123` |
| HA 长期令牌 | HA 侧 个人资料 → 长期访问令牌 → 创建 |
| 监控实体 | 要监控的实体 ID，逗号分隔，如 `sensor.temperature,binary_sensor.door` |
| 刷新间隔 | HA 实体状态刷新秒数（默认 15） |
| 校验 SSL | HA 用自签 https 时关闭 |
| RimLetter 推送地址 / token | 生成 rest_command 用；token 同 `%APPDATA%\rimletter\config.json` 里的 `api.token` |

填好后点「测试连接」，返回 HA 版本与实体数即成功。

## 实体监控用法

1. 配置里填好要监控的实体 ID（如 `sensor.temperature`）。
2. 设置 → 规则编辑器 → 新增规则：传感器选 `ha_sensor_temperature`，指标 `value`，配阈值/紧急度/持续/回落。
3. 达到阈值滑入信，回落自动恢复。

> 说明：`on`/`off` 实体按 1/0 处理；`unavailable`/非数值状态不计（规则跳过）。取属性值的场景请在 HA 侧建 template sensor 转成带状态的新实体。

## 接收 HA 通知用法

1. 插件配置里点「复制 rest_command YAML」，把生成的 YAML 加到 HA `configuration.yaml` 的 `rest_command` 段并重启 HA。
2. 在 HA 自动化里调用：

```yaml
action: rest_command.rimletter_notify
data:
  title: "门口有人"
  message: "前门传感器触发"
  severity: ThreatSmall
```

> 同机：地址默认 `127.0.0.1`。局域网：RimLetter 设置 → 常规 → API 绑定地址改 `0.0.0.0`，HA 里把 YAML 的 url 改成 RimLetter 电脑的局域网 IP，并放行防火墙端口。

## 故障排查

| 现象 | 排查 |
|---|---|
| 测试连接失败 | 检查 haUrl、token；HA 未启动/端口不对 |
| 实体没数 | 实体 ID 是否在「监控实体」里；实体 state 是否为数字/on/off |
| 收不到通知 | rest_command 是否重启生效；RimLetter API 是否启动（日志里有「API 已启动」）；token 是否一致 |
| 局域网连不上 | api.host 是否 0.0.0.0；防火墙是否放行；url 的 IP 是否本机局域网 IP |
```

- [ ] **Step 2: 提交**

```bash
git add plugin-homeassistant/README.md
git commit -m "docs: HA 插件 README（测试版标注 + 安装/实体监控/收信/排查）"
```

### Task 8: 市场清单 + 仓库 README 表格

**Files:**
- Modify: `plugins.json`
- Modify: `README.md`（仓库根）

- [ ] **Step 1: plugins.json 增加条目**

在 `plugins.json` 的 `plugins` 数组末尾（cpu-temp 之后）加：

```json
    { "id": "homeassistant", "name": "Home Assistant 集成", "desc": "接收 HA 通知来信 + HA 实体监控（测试版，欢迎反馈 bug）", "author": "NothingCooker", "file": "plugin-homeassistant/plugin-homeassistant.js", "version": "0.1.0-beta" }
```

- [ ] **Step 2: 仓库根 README「可用插件」表格加一行**

在 `plugin-cpu-temp` 行之后加：

```markdown
| `plugin-homeassistant` | Home Assistant 集成（测试版）：接收 HA 通知来信 + 实体监控告警（需 RimLetter v0.6.0+） |
```

- [ ] **Step 3: 提交**

```bash
git add plugins.json README.md
git commit -m "chore: 市场清单加入 HA 集成插件（测试版）"
```

### Task 9: 插件仓库全量测试 + 收尾

**Files:**
- Test: `plugin-*/test/`（全量）

- [ ] **Step 1: 跑所有插件测试**

Run: `node --test plugin-weather/test/ plugin-night-watch/test/ plugin-claude/test/ plugin-cpu-temp/test/ plugin-homeassistant/test/`
Expected: 全部 PASS（含新 HA 插件 10 条）。

- [ ] **Step 2: 确认两仓库都干净**

```bash
git -C "D:/claudeswork/RIM DESKTOP" status --short
git status --short
```
Expected: 两仓库工作区干净（若有遗漏提交，补交）。

- [ ] **Step 3: 记录收尾（不提交）**

在「已知注意点」中确认：HA 插件端到端验证需真实 HA（beta 阶段）；插件修改 `watchEntities` 后需「重载插件」或重启应用清除旧 `ha_*` 传感器。核心 v0.6.0 发布前局域网推送不可用（同机可用）。

---

## 发布衔接（核心 v0.6.0，用户执行）

1. 主仓库打 v0.6.0（含 `api.host`、formatLetter 回退、设置页输入行），按现有 release 流程发布。
2. 官方插件仓库推 main 后，RimLetter 设置 → 插件管理 → 更新全部，即可看到「Home Assistant 集成（测试版）」。
3. release notes 提及 HA 插件为测试版、欢迎反馈 bug（附 issues 链接）。
