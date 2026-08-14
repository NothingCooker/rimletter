# 更新多通道测速 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 更新检查前对全部通道（每个加速前缀 + 原生 GitHub）主动测速，按实际安装包下载吞吐选出最快通道优先，并把测速过程以文字可视化在设置页「立即检查」按钮旁。

**Architecture:** 新增纯函数模块 `src/main/speedtest.js`（注入 fetch，URL 构造/清单解析/吞吐测量/通道排序全部可单测）；`src/main/updater.js` 在 `checkNow()` 里先跑测速 → 按吞吐重排通道 → 再走现有响应式回退状态机。设置页仅文字展示 `speedtesting`/`checking` 状态。

**Tech Stack:** Node.js（node:test 单测）、electron-updater（现有状态机）、全局 `fetch`（Node 18+，main.js 注入）。

设计文档：`docs/superpowers/specs/2026-08-14-update-speedtest-design.md`（已提交 `517af69`）。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/main/speedtest.js` | 测速纯函数：URL 构造、清单解析、吞吐测量、通道排序 | 新建 |
| `test/speedtest.test.js` | 上述函数的单元测试 | 新建 |
| `src/main/updater.js` | checkNow 集成测速 + 状态机 | 修改 |
| `test/updater.test.js` | 测速集成测试 | 修改 |
| `src/main/config.js` | `update.speedTest` 默认值 | 修改 |
| `test/config.test.js` | 新配置项测试 | 修改 |
| `src/main/main.js` | 给 createUpdater 注入 fetch/arch/speedTest/isSpeedTestEnabled | 修改 |
| `src/renderer/settings.js` | speedtesting/checking 文案 + 「更新前测速」开关 | 修改 |

**约定：提交绝不加 `Co-Authored-By: Claude` 尾注。**

---

## Task 1: speedtest.js — URL 构造 + 清单解析（TDD）

**Files:**
- Create: `src/main/speedtest.js`
- Create: `test/speedtest.test.js`

- [ ] **Step 1: 写失败测试** — 新建 `test/speedtest.test.js`，先测 URL 构造、清单路径解析、fetchManifest：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildChannelProbeUrls, fetchManifest, parsePath } = require('../src/main/speedtest');

test('buildChannelProbeUrls 生成 proxy + github 探测 URL', () => {
  const urls = buildChannelProbeUrls({ proxyChannels: ['https://p1'], publishRepo: 'o/r', arch: 'x64' });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].label, 'p1');
  assert.equal(urls[0].manifestUrl, 'https://p1/https://github.com/o/r/releases/latest/download/latest.yml');
  assert.equal(urls[0].installBase, 'https://p1/https://github.com/o/r/releases/latest/download');
  assert.equal(urls[1].label, 'github');
  assert.equal(urls[1].manifestUrl, 'https://github.com/o/r/releases/latest/download/latest.yml');
});

test('arm64 用 latest-arm64.yml', () => {
  const urls = buildChannelProbeUrls({ proxyChannels: [], publishRepo: 'o/r', arch: 'arm64' });
  assert.equal(urls[0].manifestUrl, 'https://github.com/o/r/releases/latest/download/latest-arm64.yml');
});

test('无 proxyChannels 时仅原生 github', () => {
  const urls = buildChannelProbeUrls({ publishRepo: 'o/r', arch: 'x64' });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].label, 'github');
});

test('parsePath 取顶层 path', () => {
  const yml = 'version: 0.3.4\npath: RimLetter-Setup-x64.exe\nsha512: abc\n';
  assert.equal(parsePath(yml), 'RimLetter-Setup-x64.exe');
});

test('parsePath 无顶层 path 时 fallback files - url', () => {
  const yml = 'version: 0.3.4\nfiles:\n  - url: RimLetter-Setup-ia32.exe\n    sha512: x\n';
  assert.equal(parsePath(yml), 'RimLetter-Setup-ia32.exe');
});

test('parsePath 无 path 返回 null', () => {
  assert.equal(parsePath('version: 0.3.4\n'), null);
});

test('fetchManifest 解析成功清单', async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => 'path: App.exe\n' });
  const r = await fetchManifest(fetch, 'u', 1000);
  assert.deepEqual(r, { ok: true, path: 'App.exe' });
});

test('fetchManifest HTTP 失败返回 ok:false', async () => {
  const fetch = async () => ({ ok: false, status: 429 });
  const r = await fetchManifest(fetch, 'u', 1000);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('429'));
});

test('fetchManifest 超时返回 ok:false', async () => {
  const fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const r = await fetchManifest(fetch, 'u', 20);
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "D:/claudeswork/RIM DESKTOP" && node --test test/speedtest.test.js`
Expected: FAIL — `Cannot find module '../src/main/speedtest'`（模块不存在）

- [ ] **Step 3: 实现** — 新建 `src/main/speedtest.js`：

```js
// src/main/speedtest.js
// 更新多通道测速：纯函数 + 注入 fetch，便于单测。
const DEFAULT_CHUNK_BYTES = 1024 * 1024; // 1MB
const DEFAULT_TIMEOUT_MS = 5000;

// 带超时的 fetch：AbortController 超时后 abort
function withTimeoutFetch(fetch, url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// 通道探测 URL：每个加速前缀一个清单/安装包基址，末尾追加原生 github
function buildChannelProbeUrls({ proxyChannels = [], publishRepo, arch }) {
  const parts = publishRepo.split('/');
  const owner = parts[0], repo = parts[1];
  const manifest = arch === 'arm64' ? 'latest-arm64.yml' : 'latest.yml';
  const urls = proxyChannels.map(base => ({
    label: base.replace(/^https?:\/\//, ''),
    manifestUrl: base + '/https://github.com/' + owner + '/' + repo + '/releases/latest/download/' + manifest,
    installBase: base + '/https://github.com/' + owner + '/' + repo + '/releases/latest/download'
  }));
  urls.push({
    label: 'github',
    manifestUrl: 'https://github.com/' + owner + '/' + repo + '/releases/latest/download/' + manifest,
    installBase: 'https://github.com/' + owner + '/' + repo + '/releases/latest/download'
  });
  return urls;
}

// 从 latest.yml 文本解析安装包相对路径：优先顶层 path:，fallback files 段 - url:
function parsePath(ymlText) {
  const lines = String(ymlText || '').split('\n');
  for (const line of lines) {
    const m = /^\s*path:\s*(\S+)\s*$/.exec(line);
    if (m) return m[1];
  }
  for (const line of lines) {
    const m = /^\s*-\s*url:\s*(\S+)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

// 下载清单，返回 { ok, path } 或 { ok: false, error }
async function fetchManifest(fetch, url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await withTimeoutFetch(fetch, url, timeoutMs);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const path = parsePath(await res.text());
    if (!path) return { ok: false, error: '清单无 path' };
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = { buildChannelProbeUrls, fetchManifest, parsePath, withTimeoutFetch, DEFAULT_CHUNK_BYTES, DEFAULT_TIMEOUT_MS };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "D:/claudeswork/RIM DESKTOP" && node --test test/speedtest.test.js`
Expected: PASS — 9 tests pass, 0 fail

- [ ] **Step 5: 提交**

```bash
cd "D:/claudeswork/RIM DESKTOP"
git add test/speedtest.test.js src/main/speedtest.js
git commit -m "feat: 测速模块 URL 构造与清单解析"
```

---

## Task 2: speedtest.js — measureThroughput + rankChannels（TDD）

**Files:**
- Modify: `test/speedtest.test.js`（追加）
- Modify: `src/main/speedtest.js`

- [ ] **Step 1: 追加失败测试** — 在 `test/speedtest.test.js` 末尾追加：

```js
const { measureThroughput, rankChannels } = require('../src/main/speedtest');

function streamBody(bytes) {
  return new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); }
  });
}

test('measureThroughput 计算吞吐', async () => {
  const fetch = async () => ({ ok: true, status: 200, body: streamBody(1024 * 1024) });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024 * 1024, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 1024 * 1024);
  assert.ok(r.mbps > 0);
});

test('measureThroughput 0 字节返回 ok:false', async () => {
  const fetch = async () => ({ ok: true, status: 200, body: streamBody(0) });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024, timeoutMs: 5000 });
  assert.equal(r.ok, false);
});

test('measureThroughput HTTP 非 2xx 返回 ok:false', async () => {
  const fetch = async () => ({ ok: false, status: 403 });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024, timeoutMs: 5000 });
  assert.equal(r.ok, false);
});

test('measureThroughput 超时返回 ok:false', async () => {
  const fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024, timeoutMs: 20 });
  assert.equal(r.ok, false);
});

test('rankChannels 按吞吐降序，失败沉底', () => {
  const channels = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
  const byLabel = { a: { ok: true, mbps: 5 }, b: { ok: false }, c: { ok: true, mbps: 9 } };
  assert.deepEqual(rankChannels(channels, byLabel).map(c => c.label), ['c', 'a', 'b']);
});

test('rankChannels 同速保原序', () => {
  const channels = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
  const byLabel = { a: { ok: true, mbps: 5 }, b: { ok: true, mbps: 5 }, c: { ok: false } };
  assert.deepEqual(rankChannels(channels, byLabel).map(c => c.label), ['a', 'b', 'c']);
});

test('rankChannels 全失败保原序', () => {
  const channels = [{ label: 'a' }, { label: 'b' }];
  const byLabel = { a: { ok: false }, b: { ok: false } };
  assert.deepEqual(rankChannels(channels, byLabel).map(c => c.label), ['a', 'b']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "D:/claudeswork/RIM DESKTOP" && node --test test/speedtest.test.js`
Expected: FAIL — `measureThroughput is not a function` / `rankChannels is not a function`

- [ ] **Step 3: 实现** — 在 `src/main/speedtest.js` 的 `module.exports` 前追加：

```js
// 对安装包 Range 下载前 chunkBytes 字节，测量吞吐。返回 { ok, mbps, bytes, ms } 或 { ok:false, error, bytes, ms }
async function measureThroughput(fetch, url, { chunkBytes = DEFAULT_CHUNK_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const start = Date.now();
  let received = 0;
  try {
    const res = await withTimeoutFetch(fetch, url, timeoutMs, { headers: { Range: 'bytes=0-' + (chunkBytes - 1) } });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, bytes: 0, ms: Date.now() - start };
    if (!res.body) return { ok: false, error: '无响应体', bytes: 0, ms: Date.now() - start };
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value ? value.length : 0;
      if (received >= chunkBytes) break;
    }
    if (received <= 0) return { ok: false, error: '0 字节', bytes: 0, ms: Date.now() - start };
    const ms = Date.now() - start;
    return { ok: true, mbps: (received / (1024 * 1024)) / (ms / 1000), bytes: received, ms };
  } catch (e) {
    const ms = Date.now() - start;
    return { ok: false, error: (e && e.message) || String(e), bytes: received, ms };
  }
}

// 按吞吐率重排通道：最快在前，失败通道沉底，同速保原序（Array#sort 稳定）
function rankChannels(channels, resultsByLabel) {
  const score = (label) => {
    const r = resultsByLabel[label];
    return r && r.ok ? r.mbps : -1;
  };
  return [...channels].sort((a, b) => score(b.label) - score(a.label));
}
```

并把 `module.exports` 改为：

```js
module.exports = { buildChannelProbeUrls, fetchManifest, parsePath, measureThroughput, rankChannels, withTimeoutFetch, DEFAULT_CHUNK_BYTES, DEFAULT_TIMEOUT_MS };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "D:/claudeswork/RIM DESKTOP" && node --test test/speedtest.test.js`
Expected: PASS — 16 tests pass, 0 fail

- [ ] **Step 5: 提交**

```bash
cd "D:/claudeswork/RIM DESKTOP"
git add test/speedtest.test.js src/main/speedtest.js
git commit -m "feat: 测速模块吞吐测量与通道排序"
```

---

## Task 3: config — update.speedTest 默认值（TDD）

**Files:**
- Modify: `test/config.test.js`
- Modify: `src/main/config.js`

- [ ] **Step 1: 追加失败测试** — 在 `test/config.test.js` 末尾追加：

```js
test('update.speedTest 默认开启', () => {
  assert.equal(DEFAULT_CONFIG.update.speedTest, true);
});

test('update.speedTest 可持久化关闭', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.update.speedTest = false;
  saveConfig(dir, cfg);
  const again = loadConfig(dir);
  assert.equal(again.update.speedTest, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "D:/claudeswork/RIM DESKTOP" && node --test test/config.test.js`
Expected: FAIL — `assert.equal(DEFAULT_CONFIG.update.speedTest, true)` 得 `undefined`

- [ ] **Step 3: 实现** — `src/main/config.js` 第 15 行改为：

```js
  update: { enabled: true, proxyChannels: ['https://ghproxy.net', 'https://gh-proxy.com'], speedTest: true },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "D:/claudeswork/RIM DESKTOP" && node --test test/config.test.js`
Expected: PASS — 全部通过（13 tests pass）

- [ ] **Step 5: 提交**

```bash
cd "D:/claudeswork/RIM DESKTOP"
git add test/config.test.js src/main/config.js
git commit -m "feat: config 新增 update.speedTest 默认开启"
```

---

## Task 4: updater.js 集成测速（TDD）

**Files:**
- Modify: `test/updater.test.js`（追加）
- Modify: `src/main/updater.js`

- [ ] **Step 1: 追加失败测试** — 在 `test/updater.test.js` 末尾追加：

```js
test('测速开启时先测速，按吞吐重排后再检查', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const seen = [];
  let buildCalls = 0;
  const speedTest = {
    buildChannelProbeUrls: () => { buildCalls++; return [{ label: 'p1', manifestUrl: 'm1', installBase: 'b1' }, { label: 'github', manifestUrl: 'm2', installBase: 'b2' }]; },
    fetchManifest: async () => ({ ok: true, path: 'x.exe' }),
    measureThroughput: async (fetch, url) => ({ ok: true, mbps: url.startsWith('b1') ? 1 : 9 }),
    rankChannels: (channels, byLabel) => [...channels].sort((a, b) => (byLabel[b.label].mbps || -1) - (byLabel[a.label].mbps || -1))
  };
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', speedTest, fetch: async () => {}, isSpeedTestEnabled: () => true, onStatus: s => seen.push(s) });
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.ok(buildCalls >= 1, '应调用 buildChannelProbeUrls');
  assert.ok(seen.some(s => s.code === 'speedtesting'), '应出现 speedtesting 状态');
  assert.equal(au.feedHistory[0].provider, 'github', 'github 最快应最先被尝试');
});

test('测速整体失败时按原顺序继续检查', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const speedTest = {
    buildChannelProbeUrls: () => [{ label: 'p1', manifestUrl: 'm1', installBase: 'b1' }],
    fetchManifest: async () => ({ ok: false, error: 'HTTP 429' }),
    measureThroughput: async () => ({ ok: false }),
    rankChannels: (c, b) => c
  };
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', speedTest, fetch: async () => {}, isSpeedTestEnabled: () => true });
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['generic'], '测速失败仍按原顺序 p1 在前');
});

test('isSpeedTestEnabled false 时跳过测速', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  let built = false;
  const speedTest = {
    buildChannelProbeUrls: () => { built = true; return []; },
    fetchManifest: async () => ({ ok: false }),
    measureThroughput: async () => ({ ok: false }),
    rankChannels: c => c
  };
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', speedTest, fetch: async () => {}, isSpeedTestEnabled: () => false });
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.equal(built, false, '关闭时不测速');
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['generic']);
});

test('未注入 speedTest 时不测速直接检查', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const updater = createUpdater({ autoUpdater: au, isSpeedTestEnabled: () => true }); // 无 speedTest/fetch
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['github']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "D:/claudeswork/RIM DESKTOP" && node --test test/updater.test.js`
Expected: FAIL — `feedHistory[0].provider` 是 `'generic'`（尚未测速重排）

- [ ] **Step 3: 实现** — 修改 `src/main/updater.js`：

(3a) 解构参数追加注入（第 6-13 行），改为：

```js
  const {
    autoUpdater,
    onStatus = () => {},
    onDownloaded = () => {},
    isEnabled = () => true,
    checkDelayMs = 3000,
    proxyChannels = [],                 // 加速前缀列表，如 ['https://gh.ddlc.top']
    publishRepo = 'NothingCooker/rimletter',
    speedTest = null,                   // 测速模块（src/main/speedtest.js）；null=禁用
    fetch = null,                       // 测速用 fetch；null=禁用
    arch = null,                        // process.arch，决定清单文件名
    isSpeedTestEnabled = () => false    // live 回调，读实时 config
  } = deps;
```

(3b) 声明 `speedTesting` 标志（第 17 行后）：

```js
  let checking = false; // 当前是否有 checkForUpdates 在飞行：error 事件据此区分检查/下载阶段
  let speedTesting = false; // 测速是否在飞行：防止 checkNow 重入
```

(3c) 新增 `shouldSpeedTest` 与 `speedTestChannels`（放在 `buildChannels` 之后、`init` 之前）：

```js
  function shouldSpeedTest() {
    return !!(speedTest && fetch && isSpeedTestEnabled());
  }

  // 对全部通道测速，返回按吞吐重排后的 channels；失败返回 null（保持原顺序）。
  // 永不 reject —— 内部捕获一切异常并 resolve null，保证更新检查不被阻断。
  function speedTestChannels() {
    let probeUrls;
    try {
      probeUrls = speedTest.buildChannelProbeUrls({ proxyChannels, publishRepo, arch });
    } catch (e) {
      return Promise.resolve(null);
    }
    if (!probeUrls.length) return Promise.resolve(null);
    setState({ code: 'speedtesting', current: 0, total: probeUrls.length });
    return Promise.all(probeUrls.map(p => speedTest.fetchManifest(fetch, p.manifestUrl, 5000)))
      .then(manifests => {
        const ok = manifests.find(m => m && m.ok);
        if (!ok) return null; // 清单都拉不到 → 跳过测速
        const path = ok.path;
        const total = probeUrls.length;
        let current = 0;
        const results = [];
        // 顺序测量避免带宽争抢导致测速失真，同时自然驱动「通道 x/n」进度
        return probeUrls.reduce((chain, p) => chain.then(() =>
          speedTest.measureThroughput(fetch, p.installBase + '/' + path, { chunkBytes: 1024 * 1024, timeoutMs: 5000 })
            .then(m => {
              current++;
              const r = { label: p.label, ...m };
              results.push(r);
              setState({ code: 'speedtesting', current, total, channel: p.label, mbps: m.ok ? m.mbps : undefined });
              return r;
            })
        ), Promise.resolve()).then(() => results);
      })
      .then(results => {
        if (!results || !results.length) return null;
        const byLabel = {};
        for (const r of results) byLabel[r.label] = r;
        return speedTest.rankChannels(channels, byLabel);
      })
      .catch(() => null);
  }
```

(3d) `checkNow` 改为：

```js
  function checkNow() {
    if (!isEnabled()) { setState({ code: 'disabled' }); return Promise.resolve(null); }
    if (checking || speedTesting) return Promise.resolve(null);
    channels = buildChannels();
    idx = 0;
    if (!shouldSpeedTest()) return attempt();
    speedTesting = true;
    return speedTestChannels().then(reordered => {
      speedTesting = false;
      if (reordered && reordered.length) channels = reordered;
      return attempt();
    });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "D:/claudeswork/RIM DESKTOP" && node --test test/updater.test.js`
Expected: PASS — 全部通过（原 14 + 新 4 = 18 tests pass）

- [ ] **Step 5: 跑全量测试 + 提交**

Run: `cd "D:/claudeswork/RIM DESKTOP" && npm test`
Expected: PASS — 所有测试通过（原有 122 + 新增 16 + 新增 4 + 新增 2 = 约 144）

```bash
cd "D:/claudeswork/RIM DESKTOP"
git add src/main/updater.js test/updater.test.js
git commit -m "feat: updater 集成多通道测速与通道重排"
```

---

## Task 5: main.js 接线

**Files:**
- Modify: `src/main/main.js`

- [ ] **Step 1: 顶部引入 speedtest** — `src/main/main.js` 第 16 行后加：

```js
const { createUpdater } = require('./updater');
const speedtest = require('./speedtest');
```

- [ ] **Step 2: initUpdater 注入依赖** — `src/main/main.js` 的 `initUpdater()`（第 137-153 行）改为：

```js
function initUpdater() {
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true; // dev 模式用 dev-app-update.yml
  updater = createUpdater({
    autoUpdater,
    isEnabled: () => !!(config.update && config.update.enabled),
    isSpeedTestEnabled: () => !!(config.update && config.update.speedTest),
    proxyChannels: (config.update && config.update.proxyChannels) || [],
    publishRepo: 'NothingCooker/rimletter',
    fetch: globalThis.fetch,
    arch: process.arch,
    speedTest: speedtest,
    onStatus: (st) => { if (log) log.info('更新状态', st.code, st.version || '', st.channel || '', st.error || ''); sendToSettings('update:status', st); },
    onDownloaded: () => triggerLetter({
      severity: 'NeutralEvent',
      title: 'RimLetter 新版本已下载',
      description: '重启应用后自动安装；也可在设置 → 常规 → 点「立即重启安装」。'
    })
  });
  updater.init();
  updater.scheduleInitialCheck();
}
```

- [ ] **Step 3: 语法冒烟** — 确认模块可加载（不启动 GUI）：

Run: `cd "D:/claudeswork/RIM DESKTOP" && node -e "require('./src/main/speedtest'); console.log('speedtest ok'); require('./src/main/updater'); console.log('updater ok');"`

Expected: 打印 `speedtest ok` 与 `updater ok`（main.js 本身依赖 electron，不做 node 直跑，仅语法由后续 `npm start` 冒烟）

- [ ] **Step 4: 提交**

```bash
cd "D:/claudeswork/RIM DESKTOP"
git add src/main/main.js
git commit -m "feat: main 接线测速注入"
```

---

## Task 6: 设置页 UI（仅文字）

**Files:**
- Modify: `src/renderer/settings.js`

- [ ] **Step 1: 新增「更新前测速」开关** — `settings.js` 的 `renderGeneral` 中「自动更新」行（第 80-82 行）与「更新状态」行（第 83-86 行）之间插入：

```js
    '<div class="rw-row"><span class="rw-lbl">更新前测速</span>' +
      '<span class="rw-cb' + (config.update.speedTest ? ' on' : '') + '" data-toggle="update.speedTest"></span>' +
      '<span class="rw-gray">' + (config.update.speedTest ? '开启' : '关闭') + '</span></div>' +
```

（现有 `[data-toggle]` 事件绑定在 renderGeneral 内，已覆盖新行——`getPath/setPath` 支持点路径 `update.speedTest`。）

- [ ] **Step 2: 更新 showUpdateStatus 文案** — `settings.js` 的 `showUpdateStatus` 的 `map`（第 116-126 行）改为：

```js
    const map = {
      idle: '未检查',
      speedtesting: '正在测速(通道 ' + (st.current || 0) + '/' + (st.total || 0) + ')…',
      checking: st.channel ? '正在通过「' + st.channel + '」检查更新…' : '正在检查更新…',
      uptodate: '已是最新版本',
      'update-available': '发现新版本 v' + (st.version || '?') + '，正在下载…',
      downloading: '正在下载…',
      downloaded: '新版本 v' + (st.version || '?') + ' 已下载，重启后安装',
      disabled: '自动更新已关闭',
      error: '检查失败：' + (st.error || '未知错误')
    };
```

- [ ] **Step 3: 全量测试 + 提交**

Run: `cd "D:/claudeswork/RIM DESKTOP" && npm test`
Expected: PASS — 全部通过

```bash
cd "D:/claudeswork/RIM DESKTOP"
git add src/renderer/settings.js
git commit -m "feat: 设置页测速可视化文案与开关"
```

---

## Task 7: 端到端冒烟

- [ ] **Step 1: 运行应用**

Run: `cd "D:/claudeswork/RIM DESKTOP" && npm start`
Expected: 应用启动，托盘出现；等待自动检查（3s 后）触发测速。

- [ ] **Step 2: 人工验证测速可视化**

打开设置（托盘单击）→ 常规设置：
1. 「更新前测速」开关默认开启，可切换（关闭后立即检查不再测速）
2. 点「立即检查」：更新状态行先显示「正在测速(通道 1/3)…」，逐通道推进，随后「正在通过「X」检查更新…」（X 为测速最快通道）
3. 关掉测速开关再点「立即检查」：直接「正在检查更新…」

- [ ] **Step 3: 检查日志**

Run: 查看 `%APPDATA%\rimletter\logs\rimletter.log`，应出现 `更新状态 speedtesting ...` 与 `更新状态 checking ...` 记录。

- [ ] **Step 4: 提交版本号 bump（如发版）**

```bash
cd "D:/claudeswork/RIM DESKTOP"
npm version 0.4.0
git add package.json package-lock.json
git commit -m "chore: bump v0.4.0"
```

---

## 自检对照（spec → plan）

- ✅ spec「测速方式 B：Range 1MB + 5s」→ Task 2 measureThroughput
- ✅ spec「触发 A：每次检查都测」→ Task 4 checkNow 每轮先测速
- ✅ spec「仅文字可视化」→ Task 6 showUpdateStatus 文案
- ✅ spec「update.speedTest 默认 true」→ Task 3 config
- ✅ spec「顺序测吞吐避免带宽争抢」→ Task 4 (3c) 注释
- ✅ spec「现有响应式回退保留」→ Task 4 未改动 attempt/onCheckFail/onDownloadFail
- ✅ spec「测速失败按原顺序」→ Task 4 测试「测速整体失败时按原顺序继续检查」
- ✅ spec「更新前测速开关」→ Task 6 Step 1
- ✅ spec「main.js 注入 fetch/arch/speedTest/isSpeedTestEnabled」→ Task 5
