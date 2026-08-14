# plugin-dsh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-file RimLetter plugin (`plugin-dsh.js`) that connects to a running DeepSeek Harness web instance and slides in RimWorld-style letters for approval-waiting, error, and turn-complete events.

**Architecture:** Pure sidecar — RimLetter loads the plugin, which opens two SSE long-connections to `http://{host}:{port}/api/events.mux` and `.../api/events.host` (loopback trust fence = no auth), parses `data:` frames, maps them to letters via a pure `mapFrame(cfg, frame)` function, and sends via `api.letter()`. No listener, no state file, no hook mode (unlike plugin-claude). Auto-reconnects with exponential backoff (5s→30s cap) when dsh is down.

**Tech Stack:** Node.js CommonJS, built-in `node:http`, global `fetch` + web `ReadableStream` (Node ≥18 / Electron main), `node:test` for unit tests. Zero external dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-dsh-plugin-design.md`

---

## File Structure

All implementation happens in the **official-plugin repo** at `D:\claudeswork\official-plugin\` (separate git repo, main branch). The plan file lives in the RimLetter repo.

```
D:\claudeswork\official-plugin\
├── plugin-dsh\
│   ├── plugin-dsh.js    # Create — the plugin (single file: constants, pure fns, SSE connection layer, plugin export)
│   ├── test\dsh.test.js # Create — node:test unit + integration tests
│   └── README.md        # Create — install/usage/troubleshooting
└── plugins.json         # Modify — add the plugin-dsh marketplace entry
```

Responsibilities:
- `plugin-dsh.js` — everything the plugin does. Pure functions (`summarize`, `normalizeEndpoint`, `mapFrame`, `isDoneTurnEnd`, `dispatch`) exported under `module.exports._test` for tests. `runStream` is the SSE connection loop. `module.exports` is the RimLetter plugin entry `async ({ api, logger }) => {}`.
- `test/dsh.test.js` — unit tests for pure functions + one integration test for `runStream` against a local `http.Server`.
- `README.md` — user-facing install/config/troubleshooting, mirroring `plugin-claude/README.md`.
- `plugins.json` — marketplace manifest; add one entry.

RimLetter plugin API confirmed (from `src/main/main.js` + `src/main/plugins.js`): plugin exports `async ({ api, logger }) => {}`; `api.registerConfig(schema)`, `api.getConfig()`, `api.on('config', cb)`, `api.letter({severity,title,description,sound})`; `logger.info/warn/error`.

---

## Task 1: Scaffold plugin + pure helpers (`summarize`, `normalizeEndpoint`)

**Files:**
- Create: `D:\claudeswork\official-plugin\plugin-dsh\plugin-dsh.js`
- Test: `D:\claudeswork\official-plugin\plugin-dsh\test\dsh.test.js`

- [ ] **Step 1: Write the failing test** — create the test file with the two helper tests:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../plugin-dsh.js');

const { summarize, normalizeEndpoint } = _test;

test('summarize: 折叠空白并截断', () => {
  assert.equal(summarize('  a\n  b  c ', 5), 'a b c');
  assert.equal(summarize('hello world', 3), 'hel');
  assert.equal(summarize('', 10), '');
});

test('normalizeEndpoint: 合法值透传', () => {
  assert.deepEqual(normalizeEndpoint({ host: '0.0.0.0', port: 8080 }), { host: '0.0.0.0', port: 8080 });
  assert.deepEqual(normalizeEndpoint({}), { host: '127.0.0.1', port: 3080 });
});

test('normalizeEndpoint: 非法端口/地址兜底', () => {
  assert.equal(normalizeEndpoint({ host: '127.0.0.1', port: 'abc' }).port, 3080);
  assert.equal(normalizeEndpoint({ host: '127.0.0.1', port: 0 }).port, 3080);
  assert.equal(normalizeEndpoint({ host: '127.0.0.1', port: 99999 }).port, 3080);
  assert.equal(normalizeEndpoint({ host: '   ', port: 3080 }).host, '127.0.0.1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `D:\claudeswork\official-plugin\plugin-dsh`): `node --test test/dsh.test.js`
Expected: FAIL — `Cannot find module '../plugin-dsh.js'` (file doesn't exist yet).

- [ ] **Step 3: Create the plugin skeleton with the two helpers**

Create `D:\claudeswork\official-plugin\plugin-dsh\plugin-dsh.js`:

```js
// plugin-dsh.js — DeepSeek Harness（dsh）对接插件（RimLetter）
// 直连 dsh web 的两条 SSE 事件流（/api/events.mux + /api/events.host），
// 把 授权 / 报错 / 回答完成 三类事件映射成 RimWorld 风格的信。
// 无需钩子、无需监听器：dsh 未运行时自动重连。
'use strict';

const SEVERITIES = [
  { value: 'ThreatBig', label: '重大威胁' },
  { value: 'ThreatSmall', label: '威胁' },
  { value: 'NegativeEvent', label: '负面' },
  { value: 'NeutralEvent', label: '中性' },
  { value: 'PositiveEvent', label: '正面' }
];

const DEFAULT_PORT = 3080;
const RECONNECT_MS = 5000;      // 基础重连间隔
const MAX_RECONNECT_MS = 30000; // 退避封顶

// ---------- 纯函数 ----------

function summarize(text, max = 120) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

// 归一 dsh 地址；非法 host/port 兜底默认值
function normalizeEndpoint(cfg) {
  const host = (cfg && typeof cfg.host === 'string' && cfg.host.trim())
    ? cfg.host.trim() : '127.0.0.1';
  let port = Number(cfg && cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = DEFAULT_PORT;
  return { host, port };
}

// 供单测导出（实现过程中逐步填充）
module.exports._test = { summarize, normalizeEndpoint, DEFAULT_PORT };
```

Note: `module.exports` is currently just the `_test` object — Task 4 replaces it with the plugin function. Tests only read `._test`, so they keep working.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/dsh.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin-dsh/plugin-dsh.js plugin-dsh/test/dsh.test.js
git commit -m "feat: plugin-dsh 脚手架 + summarize/normalizeEndpoint 纯函数"
```

---

## Task 2: `mapFrame` (frame → letter)

**Files:**
- Modify: `D:\claudeswork\official-plugin\plugin-dsh\plugin-dsh.js` (add `mapFrame`)
- Modify: `D:\claudeswork\official-plugin\plugin-dsh\test\dsh.test.js` (add tests)

- [ ] **Step 1: Write the failing tests** — append to `test/dsh.test.js`:

```js
const DEFAULT_CFG = {
  enabled: true,
  host: '127.0.0.1',
  port: 3080,
  notifyApproval: true,
  notifyDone: true,
  notifyError: true,
  approvalSeverity: 'ThreatSmall',
  doneSeverity: 'PositiveEvent',
  errorSeverity: 'NegativeEvent',
  doneDebounceMs: 8000
};

const approvalFrame = (toolName = 'bash', reason) => ({
  type: 'server-request', rpcId: 'r1', method: 'approval/requested',
  payload: { sessionId: 's1', approvalId: 'a1', toolName, reason }
});
const doneFrame = () => ({
  type: 'server-request', rpcId: 'r1', method: 'session/event',
  payload: { sessionId: 's1', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }
});
const errorTurnFrame = (message = ' 5xx\n  from api ', code = 'server_error') => ({
  type: 'server-request', rpcId: 'r1', method: 'session/event',
  payload: { sessionId: 's1', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message, code } } } } }
});
const agentErrorFrame = (message = 'provider 5xx') => ({
  type: 'server-request', rpcId: 'r1', method: 'host/agent-error',
  payload: { sessionId: 's1', message }
});

const { mapFrame } = require('../plugin-dsh.js')._test;

test('mapFrame: approval/requested → 授权信', () => {
  const l = mapFrame(DEFAULT_CFG, approvalFrame('Bash'));
  assert.equal(l.severity, 'ThreatSmall');
  assert.equal(l.title, 'dsh 需要你的授权');
  assert.match(l.description, /Bash/);
  assert.equal(l.sound, 'auto');
});

test('mapFrame: approval/requested 带 reason → 描述含 reason', () => {
  const l = mapFrame(DEFAULT_CFG, approvalFrame('bash', '高危命令'));
  assert.match(l.description, /高危命令/);
});

test('mapFrame: turn/end completed → 完成信', () => {
  const l = mapFrame(DEFAULT_CFG, doneFrame());
  assert.equal(l.severity, 'PositiveEvent');
  assert.equal(l.title, 'dsh 完成回答');
  assert.equal(l.sound, 'auto');
});

test('mapFrame: turn/end error → 报错信（描述取 message）', () => {
  const l = mapFrame(DEFAULT_CFG, errorTurnFrame());
  assert.equal(l.severity, 'NegativeEvent');
  assert.equal(l.title, 'dsh 报错');
  assert.ok(l.description.startsWith('5xx from api'));
});

test('mapFrame: turn/end error 无 message → 描述取 code', () => {
  const l = mapFrame(DEFAULT_CFG, errorTurnFrame('', 'rate_limit'));
  assert.equal(l.description, 'rate_limit');
});

test('mapFrame: host/agent-error → 报错信', () => {
  const l = mapFrame(DEFAULT_CFG, agentErrorFrame());
  assert.equal(l.severity, 'NegativeEvent');
  assert.equal(l.title, 'dsh 报错');
  assert.match(l.description, /provider 5xx/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/dsh.test.js`
Expected: FAIL — `_test.mapFrame` is undefined.

- [ ] **Step 3: Implement `mapFrame`** — add to `plugin-dsh.js` after `normalizeEndpoint`:

```js
// 把 SSE 帧映射成信；cfg 为插件配置（已合并默认值）；frame 为解析后的 {type, method, payload}
function mapFrame(cfg, frame) {
  if (!cfg.enabled) return null;
  const method = frame && frame.method;
  if (method === 'approval/requested') {
    if (!cfg.notifyApproval) return null;
    const p = frame.payload || {};
    const tool = String(p.toolName || '').trim();
    const reason = summarize(p.reason, 60);
    const desc = (tool ? '等待你授权执行工具：' + tool : 'dsh 正在等待你的授权') + (reason ? '（' + reason + '）' : '');
    return { severity: cfg.approvalSeverity, title: 'dsh 需要你的授权', description: desc, sound: 'auto' };
  }
  if (method === 'session/event') {
    const ev = (frame.payload && frame.payload.event) || {};
    if (ev.type !== 'turn/end') return null;
    const reason = ((ev.data || {}).reason) || {};
    if (reason.kind === 'completed') {
      if (!cfg.notifyDone) return null;
      return { severity: cfg.doneSeverity, title: 'dsh 完成回答', description: 'dsh 完成一次回答', sound: 'auto' };
    }
    if (reason.kind === 'error') {
      if (!cfg.notifyError) return null;
      const err = reason.error || {};
      return {
        severity: cfg.errorSeverity,
        title: 'dsh 报错',
        description: summarize(err.message || err.code, 120) || 'dsh 运行出错',
        sound: 'auto'
      };
    }
    return null;
  }
  if (method === 'host/agent-error') {
    if (!cfg.notifyError) return null;
    const p = frame.payload || {};
    return {
      severity: cfg.errorSeverity,
      title: 'dsh 报错',
      description: summarize(p.message, 120) || 'dsh 运行出错',
      sound: 'auto'
    };
  }
  return null;
}
```

Update the `_test` export: `module.exports._test = { summarize, normalizeEndpoint, mapFrame, DEFAULT_PORT };`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/dsh.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin-dsh/plugin-dsh.js plugin-dsh/test/dsh.test.js
git commit -m "feat: plugin-dsh mapFrame 帧→信映射（授权/完成/报错）"
```

---

## Task 3: `mapFrame` null/edge cases

**Files:**
- Modify: `D:\claudeswork\official-plugin\plugin-dsh\test\dsh.test.js` (add tests)

- [ ] **Step 1: Write the failing tests** — append:

```js
test('mapFrame: enabled=false → null', () => {
  assert.equal(mapFrame({ ...DEFAULT_CFG, enabled: false }, approvalFrame()), null);
  assert.equal(mapFrame({ ...DEFAULT_CFG, enabled: false }, doneFrame()), null);
});

test('mapFrame: notifyApproval=false → null', () => {
  assert.equal(mapFrame({ ...DEFAULT_CFG, notifyApproval: false }, approvalFrame()), null);
});

test('mapFrame: notifyDone=false → null', () => {
  assert.equal(mapFrame({ ...DEFAULT_CFG, notifyDone: false }, doneFrame()), null);
});

test('mapFrame: notifyError=false → 报错帧 null', () => {
  assert.equal(mapFrame({ ...DEFAULT_CFG, notifyError: false }, errorTurnFrame()), null);
  assert.equal(mapFrame({ ...DEFAULT_CFG, notifyError: false }, agentErrorFrame()), null);
});

test('mapFrame: turn/end 其他 kind → null', () => {
  for (const kind of ['aborted', 'blocked', 'max-tokens', 'interrupted']) {
    const frame = { ...doneFrame() };
    frame.payload.event.data.reason = { kind };
    assert.equal(mapFrame(DEFAULT_CFG, frame), null, kind);
  }
});

test('mapFrame: 无关帧 → null', () => {
  assert.equal(mapFrame(DEFAULT_CFG, { method: 'session/subscribed', payload: {} }), null);
  assert.equal(mapFrame(DEFAULT_CFG, { method: 'session/event', payload: { event: { type: 'tool/call', data: {} } } }), null);
  assert.equal(mapFrame(DEFAULT_CFG, { method: 'stream/error', payload: { error: {} } }), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/dsh.test.js`
Expected: FAIL — `mapFrame` not exported yet.

- [ ] **Step 3: Add `mapFrame` to the export** (implementation already exists from Task 2):

In `plugin-dsh.js`, add `mapFrame` to the `_test` export if not already done in Task 2 Step 3. Verify the export line is:
`module.exports._test = { summarize, normalizeEndpoint, mapFrame, DEFAULT_PORT };`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/dsh.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin-dsh/plugin-dsh.js plugin-dsh/test/dsh.test.js
git commit -m "test: plugin-dsh mapFrame 边界（禁用/开关/其他 kind/无关帧）"
```

---

## Task 4: `dispatch` (debounced sender)

**Files:**
- Modify: `D:\claudeswork\official-plugin\plugin-dsh\plugin-dsh.js` (add `isDoneTurnEnd`, `dispatch`)
- Modify: `D:\claudeswork\official-plugin\plugin-dsh\test\dsh.test.js` (add tests)

- [ ] **Step 1: Write the failing tests** — append:

```js
const { dispatch } = require('../plugin-dsh.js')._test;

test('dispatch: 正常发信并返回 true', () => {
  const sent = [];
  const ok = dispatch(DEFAULT_CFG, { letter: l => sent.push(l) }, { last: 0 }, approvalFrame());
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'dsh 需要你的授权');
});

test('dispatch: 完成信在防抖窗口内被跳过', () => {
  const sent = [];
  const last = { last: Date.now() };
  const ok = dispatch(DEFAULT_CFG, { letter: l => sent.push(l) }, last, doneFrame());
  assert.equal(ok, false);
  assert.equal(sent.length, 0);
});

test('dispatch: 完成信防抖后恢复', () => {
  const sent = [];
  const last = { last: Date.now() - 10000 };
  const ok = dispatch(DEFAULT_CFG, { letter: l => sent.push(l) }, last, doneFrame());
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
});

test('dispatch: 报错帧不受完成信防抖影响', () => {
  const sent = [];
  const last = { last: Date.now() };
  const ok = dispatch(DEFAULT_CFG, { letter: l => sent.push(l) }, last, agentErrorFrame());
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/dsh.test.js`
Expected: FAIL — `_test.dispatch` is undefined.

- [ ] **Step 3: Implement `isDoneTurnEnd` + `dispatch`** — add after `mapFrame`:

```js
// 是否「完成回答」帧（用于防抖）
function isDoneTurnEnd(frame) {
  if (!frame || frame.method !== 'session/event') return false;
  const ev = (frame.payload && frame.payload.event) || {};
  return ev.type === 'turn/end' && !!(ev.data && ev.data.reason && ev.data.reason.kind === 'completed');
}

// 发信分派：完成信防抖在此做（插件进程常驻内存）；返回是否真的发了信
function dispatch(cfg, api, lastDoneRef, frame) {
  const letter = mapFrame(cfg, frame);
  if (!letter) return false;
  if (isDoneTurnEnd(frame)) {
    const now = Date.now();
    if (now - lastDoneRef.last < cfg.doneDebounceMs) return false;
    lastDoneRef.last = now;
  }
  api.letter(letter);
  return true;
}
```

Update export: `module.exports._test = { summarize, normalizeEndpoint, mapFrame, isDoneTurnEnd, dispatch, DEFAULT_PORT };`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/dsh.test.js`
Expected: PASS (19 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin-dsh/plugin-dsh.js plugin-dsh/test/dsh.test.js
git commit -m "feat: plugin-dsh dispatch 发信分派 + 完成信防抖"
```

---

## Task 5: `runStream` (SSE connection loop) + plugin entry

**Files:**
- Modify: `D:\claudeswork\official-plugin\plugin-dsh\plugin-dsh.js` (add `sleep`, `runStream`, replace `module.exports`)
- Modify: `D:\claudeswork\official-plugin\plugin-dsh\test\dsh.test.js` (add integration test)

- [ ] **Step 1: Write the failing integration test** — append (needs `node:http`):

```js
const http = require('node:http');
const { runStream } = require('../plugin-dsh.js')._test;

test('runStream: 读取本地 SSE 帧', async () => {
  const frames = [];
  let resRef = null;
  let connected = false;
  const server = http.createServer((req, res) => {
    connected = true;
    resRef = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const stopSignal = new AbortController();
  const stop = runStream({
    name: 'test',
    url: 'http://127.0.0.1:' + port + '/api/events.mux',
    onFrame: f => frames.push(f),
    logger: { warn: () => {}, info: () => {} },
    stopSignal: stopSignal.signal
  });
  const deadline = Date.now() + 2000;
  while (!connected && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.ok(connected, '连接未建立');
  resRef.write('data: ' + JSON.stringify({ method: 'approval/requested', payload: { toolName: 'Bash' } }) + '\n\n');
  resRef.write('data: ' + JSON.stringify({ method: 'host/agent-error', payload: { message: 'x' } }) + '\n\n');
  const waitUntil = Date.now() + 2000;
  while (frames.length < 2 && Date.now() < waitUntil) await new Promise(r => setTimeout(r, 20));
  stop();
  stopSignal.abort();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].method, 'approval/requested');
  assert.equal(frames[1].method, 'host/agent-error');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/dsh.test.js`
Expected: FAIL — `_test.runStream` is undefined.

- [ ] **Step 3: Implement `sleep` + `runStream` + plugin entry**

Add after `dispatch`:

```js
function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal && signal.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort);
  });
}

// ---------- 连接层 ----------

// 单条 SSE 连接循环：连上→逐帧回调→断/错→指数退避重连；stop() 终止
// stopSignal.abort() 会同时中止进行中的 fetch 与 sleep。
function runStream({ name, url, onFrame, logger, stopSignal }) {
  const streamAbort = new AbortController();
  let reader = null;
  const onAbort = () => streamAbort.abort();
  stopSignal.addEventListener('abort', onAbort);

  async function connectOnce() {
    let res;
    try {
      res = await fetch(url, { signal: streamAbort.signal });
    } catch (e) {
      if (streamAbort.signal.aborted) return undefined;
      return '连接失败: ' + (e.message || e);
    }
    if (streamAbort.signal.aborted) {
      try { res.body && res.body.cancel && res.body.cancel().catch(() => {}); } catch { /* 忽略 */ }
      return undefined;
    }
    if (!res.ok || !res.body) return 'HTTP ' + res.status;
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          const trimmed = line.replace(/\r$/, '');
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          let frame;
          try { frame = JSON.parse(data); } catch (e) { logger.warn(name + ' 帧解析失败: ' + e.message); continue; }
          try { onFrame(frame); } catch (e) { logger.warn(name + ' 处理帧出错: ' + (e.message || e)); }
        }
      }
    } catch (e) {
      if (streamAbort.signal.aborted) return undefined;
      return '流中断: ' + (e.message || e);
    } finally {
      const r = reader;
      reader = null;
      if (r) { try { r.cancel().catch(() => {}); } catch { /* 忽略 */ } }
    }
    return null; // 正常结束
  }

  (async function loop() {
    let attempt = 0;
    while (!streamAbort.signal.aborted) {
      const err = await connectOnce();
      if (streamAbort.signal.aborted) break;
      if (!err) attempt = 0; // 曾成功连上 → 重置退避
      attempt++;
      const delay = Math.min(RECONNECT_MS * Math.pow(2, attempt - 1), MAX_RECONNECT_MS);
      if (err) logger.warn(name + ' ' + err + '，' + delay + 'ms 后重连');
      else logger.info(name + ' 连接结束，' + delay + 'ms 后重连');
      await sleep(delay, streamAbort.signal);
    }
  })();

  return function stop() {
    streamAbort.abort();
    if (reader) { try { reader.cancel().catch(() => {}); } catch { /* 忽略 */ } }
    stopSignal.removeEventListener('abort', onAbort);
  };
}

// ---------- 插件模式 ----------

module.exports = async ({ api, logger }) => {
  api.registerConfig({
    title: 'DeepSeek Harness 对接',
    fields: [
      { key: 'enabled', label: '启用插件', type: 'bool', default: true },
      { key: 'host', label: 'dsh 地址', type: 'text', default: '127.0.0.1' },
      { key: 'port', label: 'dsh 端口', type: 'number', default: DEFAULT_PORT },
      { key: 'notifyApproval', label: '授权时发信', type: 'bool', default: true },
      { key: 'notifyDone', label: '回答完成发信', type: 'bool', default: true },
      { key: 'notifyError', label: '报错时发信', type: 'bool', default: true },
      { key: 'approvalSeverity', label: '授权信紧急度', type: 'select', options: SEVERITIES, default: 'ThreatSmall' },
      { key: 'doneSeverity', label: '完成信紧急度', type: 'select', options: SEVERITIES, default: 'PositiveEvent' },
      { key: 'errorSeverity', label: '报错信紧急度', type: 'select', options: SEVERITIES, default: 'NegativeEvent' },
      { key: 'doneDebounceMs', label: '完成信最小间隔', type: 'slider', default: 8000, min: 0, max: 60000, step: 1000, unit: '毫秒' }
    ]
  });

  const cfgRef = { current: api.getConfig() };
  api.on('config', next => { cfgRef.current = next; restart(); });

  const lastDoneRef = { last: 0 };
  const reg = global.__rimletterDsh || (global.__rimletterDsh = { stop: null });

  function restart() {
    const old = reg.stop;
    if (old) { try { old(); } catch { /* 忽略 */ } }
    reg.stop = null;
    if (!cfgRef.current.enabled) { logger.info('插件已禁用，停止连接'); return; }
    const { host, port } = normalizeEndpoint(cfgRef.current);
    const base = 'http://' + host + ':' + port;
    const stopSignal = new AbortController();
    const onFrame = frame => dispatch(cfgRef.current, api, lastDoneRef, frame);
    const stopMux = runStream({ name: 'mux', url: base + '/api/events.mux', onFrame, logger, stopSignal: stopSignal.signal });
    const stopHost = runStream({ name: 'host', url: base + '/api/events.host', onFrame, logger, stopSignal: stopSignal.signal });
    reg.stop = () => { stopSignal.abort(); stopMux(); stopHost(); };
    logger.info('dsh SSE 连接已启动 base=' + base);
  }

  restart();
};

// 供单测导出
module.exports._test = { summarize, normalizeEndpoint, mapFrame, isDoneTurnEnd, dispatch, runStream, DEFAULT_PORT };
```

**Key point:** `module.exports` is now the async plugin function (RimLetter's loader calls `require(file)` and expects a function or `{ load }`). The `_test` property is attached to that function object, so `require('../plugin-dsh.js')._test` still works in tests.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/dsh.test.js`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin-dsh/plugin-dsh.js plugin-dsh/test/dsh.test.js
git commit -m "feat: plugin-dsh runStream SSE 连接层 + 插件入口"
```

---

## Task 6: README + marketplace manifest

**Files:**
- Create: `D:\claudeswork\official-plugin\plugin-dsh\README.md`
- Modify: `D:\claudeswork\official-plugin\plugins.json`

- [ ] **Step 1: Create README.md** mirroring `plugin-claude/README.md` structure:

````markdown
# plugin-dsh — DeepSeek Harness（dsh）对接插件

RimLetter 与 DeepSeek Harness 联动：dsh 需要你授权、报错、或完成一次回答时，屏幕右缘滑入一封 RimWorld 风格的信。

## 前提

先运行 dsh Web：`dsh web`（默认 `http://127.0.0.1:3080`）。插件直连它的 SSE 事件流，dsh 未运行时插件会自动重试、连上即恢复。

## 效果

| 事件（dsh SSE 事件流） | 信标题 | 默认紧急度 |
|---|---|---|
| 需要授权（approval/requested） | dsh 需要你的授权 | ThreatSmall |
| 报错（turn/end error / host agent-error） | dsh 报错 | NegativeEvent |
| 回答完成（turn/end completed，防抖 8s） | dsh 完成回答 | PositiveEvent |

## 安装

1. 把 `plugin-dsh.js` 复制到 `%APPDATA%\rimletter\plugins\`（设置 → 插件管理 →「打开插件目录」直达）。
2. 设置 → 插件管理 → 启用 `plugin-dsh`。
3. 确认 dsh 正在运行（`dsh web`，`127.0.0.1:3080`）。

## 配置项（设置 → 插件管理 → plugin-dsh → 配置）

| 字段 | 说明 | 默认 |
|---|---|---|
| 启用插件 | 总开关 | 开 |
| dsh 地址 / dsh 端口 | dsh web 的 host / port | 127.0.0.1 / 3080 |
| 授权时发信 / 回答完成发信 / 报错时发信 | 三类事件独立开关 | 全开 |
| 授权信/完成信/报错信紧急度 | ThreatBig / ThreatSmall / NegativeEvent / NeutralEvent / PositiveEvent | ThreatSmall / PositiveEvent / NegativeEvent |
| 完成信最小间隔 | 两次完成信的最短间隔（毫秒） | 8000 |

> 音效恒为各紧急度默认游戏原声；全局静音/音量在 RimLetter 设置里调。

## 工作方式（简要）

- 插件启动 → 直连 dsh 的两条 SSE 事件流（`/api/events.mux` 与 `/api/events.host`，`127.0.0.1` 免鉴权）。
- 解析帧 → 映射成信 → `api.letter()` 播报；完成信受防抖限制。
- dsh 未运行 / 中途断开 → 自动重连（5s→30s 退避封顶），连上即恢复。

## 卸载

设置 → 插件管理 → 禁用 `plugin-dsh`。无需清理其他文件（插件不写状态文件、不改任何配置）。

## 故障排查

- **信不来**：确认 dsh 已运行（浏览器开 `http://127.0.0.1:3080` 应见 UI）；确认插件已启用。
- **改了端口/地址**：在插件配置里把 dsh 地址/端口改对。
- **看日志**：RimLetter 设置 → 日志级别设 debug，看 `[plugin:plugin-dsh]` 连接日志。

## 支持版本

- RimLetter v0.2.5+
````

- [ ] **Step 2: Add the marketplace entry** — edit `D:\claudeswork\official-plugin\plugins.json`, inserting a new line after the `claude` entry (keep valid JSON):

```json
    { "id": "dsh", "name": "DeepSeek Harness 对接", "desc": "授权/报错/回答完成来信（需运行 dsh web）", "author": "NothingCooker", "file": "plugin-dsh/plugin-dsh.js", "version": "1.0.0" },
```

- [ ] **Step 3: Validate plugins.json is still valid JSON**

Run (from `D:\claudeswork\official-plugin`): `node -e "const j=require('./plugins.json'); console.log(j.plugins.length + ' plugins, ids: ' + j.plugins.map(p=>p.id).join(','))"`
Expected: prints count and all ids including `dsh`.

- [ ] **Step 4: Commit**

```bash
git add plugin-dsh/README.md plugins.json
git commit -m "docs: plugin-dsh README + plugins.json 上架"
```

---

## Task 7: Manual end-to-end verification (human)

**Files:** none (manual checks against a real dsh instance)

- [ ] **Step 1: Copy to plugins dir + enable**
  Copy `plugin-dsh.js` to `%APPDATA%\rimletter\plugins\`; in RimLetter 设置 → 插件管理, enable `plugin-dsh`. Confirm the config form appears (设置 → 插件管理 → plugin-dsh → 配置).

- [ ] **Step 2: Confirm connection with dsh running**
  Start `dsh web` (or confirm it's already up at `http://127.0.0.1:3080`). In RimLetter's log (debug level), confirm `[plugin:plugin-dsh] dsh SSE 连接已启动 base=http://127.0.0.1:3080`.

- [ ] **Step 3: Trigger each letter type**
  - 授权信: in dsh, start a task whose tool needs approval → expect 「dsh 需要你的授权」.
  - 完成信: let a turn finish normally → expect 「dsh 完成回答」 (debounced).
  - 报错信: force a turn error or agent error → expect 「dsh 报错」.

- [ ] **Step 4: Verify reconnect behavior**
  Stop `dsh web`. Confirm the plugin keeps running, logs warn + retry, and doesn't crash RimLetter. Restart `dsh web`; confirm letters resume (and any pending approval is replayed on reconnect).

- [ ] **Step 5: Commit any fixes from the above, then bump `plugins.json` version if behavior changed**
  If verification revealed bugs, fix them (re-run `node --test test/dsh.test.js`), commit, and note the final version in `plugins.json`.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §3 decision 1 (SSE sidecar) → Task 5 (`runStream` + entry wiring). ✓
- §3 decision 2 (event set = approval/done/error) → Task 2/3 (`mapFrame`). ✓
- §3 decision 3 (`sound:'auto'`) → every `mapFrame` return. ✓
- §6 connection lifecycle (5s retry / 5→30s backoff / config-change reconnect / disabled stop) → Task 5 (`runStream` loop, `restart()` on `api.on('config')`). ✓
- §7 event mapping table → Task 2/3. ✓
- §8 config fields (10 fields, exact types/defaults) → Task 5 `registerConfig`. ✓
- §9 error handling (dsh down / disconnect / bad JSON / bad port) → Task 1 (`normalizeEndpoint`), Task 5 (`connectOnce` try/catch, frame-parse catch). ✓
- §10 tests → Tasks 1–5; manual E2E → Task 7. ✓
- §11 README outline → Task 6. ✓
- §12 verification points: `fetch` + `ReadableStream` confirmed available (plugin-claude already uses global `fetch`; repo runs Node 24); `data:` line framing handled in `runStream`; mux replay of pending approvals requires no code (connection-open replay is server-side). ✓

**Placeholder scan:** No TBD/TODO/"similar to Task N" — every code step has full source. ✓

**Type consistency:** `mapFrame(cfg, frame) → letter|null` used identically in Tasks 2/3/4 and the `onFrame` wiring in Task 5. `dispatch(cfg, api, lastDoneRef, frame)` signature matches Task 4 tests and Task 5 `onFrame`. `runStream` options object keys (`name, url, onFrame, logger, stopSignal`) match Task 5 test call. `_test` export keys match every test's destructure. ✓
