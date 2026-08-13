# 插件市场 + 自动更新加速通道 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 RimLetter 设置窗加「插件市场」（jsDelivr CDN 浏览/安装/卸载/更新官方插件），并把自动更新改为「加速通道优先、失败回退原生」。

**Architecture:** 新增 `src/main/market.js`（依赖注入 fetch/fs，可单测），改造 `src/main/updater.js` 为通道回退状态机（`setFeedURL` 切 feed，`checkForUpdates()` reject 时换下一通道），main.js 接线 IPC，渲染层加市场 UI；官方插件仓库根目录加 `plugins.json` 清单。

**Tech Stack:** Electron 43 / Node 24 / `node:test` / electron-updater 6.8.9。

**参考设计**：`docs/superpowers/specs/2026-08-13-plugin-marketplace-and-update-accelerator-design.md`

**关键 API 事实（已核验 node_modules/electron-updater/out/）：**
- `autoUpdater.setFeedURL(obj)` 支持 `{provider:'generic', url}` 与 `{provider:'github', owner, repo}`（AppUpdater.js:234）。
- GenericProvider 把 `url` 当 baseUrl：拉 `{url}/latest.yml`、下载文件拼 `{url}/{file.name}`（GenericProvider.js:12,20,47）。
- `checkForUpdates()` 失败时 **reject promise** 且 emit `'error'`（AppUpdater.js:268-276）。

---

### Task 1: config.js 新增 update.proxyChannels 与 market 默认值

**Files:**
- Modify: `src/main/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/config.test.js` 末尾追加：

```js
test('update.proxyChannels 默认含 gh.ddlc.top 与 ghproxy.net', () => {
  assert.deepEqual(DEFAULT_CONFIG.update.proxyChannels, ['https://gh.ddlc.top', 'https://ghproxy.net']);
});

test('market 默认指向官方插件仓库 main 分支', () => {
  assert.equal(DEFAULT_CONFIG.market.repo, 'NothingCooker/rimletter-official-plugins');
  assert.equal(DEFAULT_CONFIG.market.branch, 'main');
});

test('market 配置可持久化覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.market.repo = 'me/plugins';
  saveConfig(dir, cfg);
  const again = loadConfig(dir);
  assert.equal(again.market.repo, 'me/plugins');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx node --test test/config.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'proxyChannels')` 等。

- [ ] **Step 3: 改 DEFAULT_CONFIG**

`src/main/config.js` 的 `DEFAULT_CONFIG`：

```js
const DEFAULT_CONFIG = {
  pollIntervalMs: 2000,
  autoDismissMs: 20000,
  recoveryDismissMs: 10000,
  api: { enabled: true, port: 17301, token: 'auto', cors: false },
  appearance: { iconSize: 64 },
  sound: { enabled: true, volume: 0.25 },
  update: { enabled: true, proxyChannels: ['https://gh.ddlc.top', 'https://ghproxy.net'] },
  market: { repo: 'NothingCooker/rimletter-official-plugins', branch: 'main' },
  plugins: { disabled: ['example'] }, // example 为演示插件，默认禁用，可在设置中启用
  rules: [ /* 保持不变 */ ]
};
```

注意：**只改上面两行，rules 数组原样保留**。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx node --test test/config.test.js`
Expected: PASS（全部通过）

- [ ] **Step 5: 提交**

```bash
git add src/main/config.js test/config.test.js
git commit -m "feat: 配置新增 update.proxyChannels 与 market 默认值"
```

---

### Task 2: market.js 纯函数（isSafeId / buildChannelUrls / parseManifest）

**Files:**
- Create: `src/main/market.js`
- Test: `test/market.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/market.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isSafeId, buildChannelUrls, parseManifest } = require('../src/main/market');

test('isSafeId 接受字母数字下划线连字符', () => {
  assert.equal(isSafeId('weather'), true);
  assert.equal(isSafeId('a-b_c1'), true);
  assert.equal(isSafeId('ABC123'), true);
});

test('isSafeId 拒绝路径穿越与非法字符', () => {
  assert.equal(isSafeId('..'), false);
  assert.equal(isSafeId('a/b'), false);
  assert.equal(isSafeId('a b'), false);
  assert.equal(isSafeId('a.js'), false);
  assert.equal(isSafeId(''), false);
  assert.equal(isSafeId(null), false);
  assert.equal(isSafeId(123), false);
});

test('buildChannelUrls 生成 jsdelivr 与 raw 两种 URL', () => {
  const urls = buildChannelUrls('o/plugins', 'main', 'plugin-x/plugin-x.js');
  assert.equal(urls[0].name, 'jsdelivr');
  assert.equal(urls[0].url, 'https://cdn.jsdelivr.net/gh/o/plugins@main/plugin-x/plugin-x.js');
  assert.equal(urls[1].name, 'raw');
  assert.equal(urls[1].url, 'https://raw.githubusercontent.com/o/plugins/main/plugin-x/plugin-x.js');
});

test('parseManifest 解析合法清单并归一字段', () => {
  const text = JSON.stringify({
    version: 1,
    plugins: [{ id: 'weather', name: '天气', desc: '描述', author: 'A', file: 'plugin-weather/plugin-weather.js', version: '1.0.0' }]
  });
  const plugins = parseManifest(text);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, 'weather');
  assert.equal(plugins[0].file, 'plugin-weather/plugin-weather.js');
  assert.equal(plugins[0].name, '天气');
});

test('parseManifest 缺少 name 时回退用 id', () => {
  const text = JSON.stringify({ version: 1, plugins: [{ id: 'x', file: 'x/x.js' }] });
  const plugins = parseManifest(text);
  assert.equal(plugins[0].name, 'x');
});

test('parseManifest 非 JSON / 缺 plugins / 非法条目均抛错', () => {
  assert.throws(() => parseManifest('not json'), /JSON/);
  assert.throws(() => parseManifest('{"a":1}'), /plugins/);
  assert.throws(() => parseManifest('{"plugins":[]}'), /plugins/);
  assert.throws(() => parseManifest('{"plugins":[{"id":"a/b","file":"x"}]}'), /非法/);
  assert.throws(() => parseManifest('{"plugins":[{"id":"ok","file":""}]}'), /非法/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx node --test test/market.test.js`
Expected: FAIL — `Cannot find module '../src/main/market'`

- [ ] **Step 3: 实现纯函数**

创建 `src/main/market.js`（**本 Task 只写纯函数部分，Task 3 追加 createMarket**）：

```js
// src/main/market.js
// 插件市场：从官方插件仓库（经 jsDelivr CDN / raw.githubusercontent 回退）拉取清单并安装插件。
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const TIMEOUT_MS = 15000;
const DEFAULT_REPO = 'NothingCooker/rimletter-official-plugins';
const DEFAULT_BRANCH = 'main';

function isSafeId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// 返回 [{name, url}]，按顺序优先 jsDelivr，回退 raw.githubusercontent
function buildChannelUrls(repo, branch, filePath) {
  return [
    { name: 'jsdelivr', url: 'https://cdn.jsdelivr.net/gh/' + repo + '@' + branch + '/' + filePath },
    { name: 'raw', url: 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + filePath }
  ];
}

// 校验并归一清单文本 → [{id, name, desc, author, file, version}]
function parseManifest(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('清单不是合法 JSON'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.plugins) || data.plugins.length === 0) {
    throw new Error('清单缺少非空 plugins 数组');
  }
  return data.plugins.map(p => {
    if (!p || typeof p.id !== 'string' || !isSafeId(p.id) || typeof p.file !== 'string' || !p.file) {
      throw new Error('清单条目非法: ' + (p && p.id));
    }
    return {
      id: p.id,
      name: String(p.name || p.id),
      desc: String(p.desc || ''),
      author: String(p.author || ''),
      file: p.file,
      version: String(p.version || '')
    };
  });
}

module.exports = { isSafeId, buildChannelUrls, parseManifest, ID_RE, TIMEOUT_MS, DEFAULT_REPO, DEFAULT_BRANCH };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx node --test test/market.test.js`
Expected: PASS（全部 8 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/market.js test/market.test.js
git commit -m "feat: market 纯函数（id 校验/通道 URL/清单解析）"
```

---

### Task 3: market.js createMarket（list / install / uninstall / updateAll）

**Files:**
- Modify: `src/main/market.js`
- Test: `test/market.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/market.test.js` 追加（**替换文件末尾的 module 引用行**，顶部改为）：

```js
const { isSafeId, buildChannelUrls, parseManifest, createMarket } = require('../src/main/market');
```

追加测试：

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeMarket({ repo = 'o/plugins', branch = 'main', fetchImpl, pluginsDir }) {
  const getConfig = () => ({ market: { repo, branch }, plugins: { disabled: ['old'] } });
  let changed = 0;
  const market = createMarket({
    getConfig,
    configDir: path.dirname(pluginsDir),
    fetch: fetchImpl,
    onChanged: () => { changed++; }
  });
  return { market, changed: () => changed };
}

// 按 URL 精确路由的 fetch mock：route[url] = {ok, text} 或 {error}
function routeFetch(route) {
  return async (url) => {
    const r = route[url];
    if (!r) throw new Error('fetch not stubbed: ' + url);
    if (r.error) throw r.error;
    return { ok: r.ok !== false, status: r.status || 200, text: async () => r.text };
  };
}

const MANIFEST = JSON.stringify({ version: 1, plugins: [
  { id: 'weather', name: '天气', desc: 'd', author: 'A', file: 'plugin-weather/plugin-weather.js', version: '1.0.0' }
]});

test('list 经 jsdelivr 拉取清单并标已安装', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'weather.js'), 'module.exports=()=>{}');
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fetchImpl = routeFetch({ [urls[0].url]: { text: MANIFEST } });
  const { market } = makeMarket({ fetchImpl, pluginsDir: path.join(dir, 'plugins') });
  const list = await market.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'weather');
  assert.equal(list[0].installed, true);
  assert.equal(list[0].channel, 'jsdelivr');
});

test('list 的 jsdelivr 失败时回退 raw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fetchImpl = routeFetch({
    [urls[0].url]: { error: new Error('jsdelivr down') },
    [urls[1].url]: { text: MANIFEST }
  });
  const { market } = makeMarket({ fetchImpl, pluginsDir: path.join(dir, 'plugins') });
  const list = await market.list();
  assert.equal(list[0].channel, 'raw');
});

test('install 下载 .js 落位并启用 + 触发 onChanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fileUrls = buildChannelUrls('o/plugins', 'main', 'plugin-weather/plugin-weather.js');
  const fetchImpl = routeFetch({
    [urls[0].url]: { text: MANIFEST },
    [fileUrls[0].url]: { text: 'module.exports=async()=>{};' }
  });
  const { market, changed } = makeMarket({ fetchImpl, pluginsDir });
  const res = await market.install('weather');
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(pluginsDir, 'weather.js'), 'utf-8'), 'module.exports=async()=>{};');
  assert.equal(changed(), 1);
  assert.ok(!fs.existsSync(path.join(pluginsDir, '.tmp-weather.js')), '临时文件已清理');
});

test('install 非法 id 直接拒绝，且不触发 onChanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const { market, changed } = makeMarket({ fetchImpl: async () => { throw new Error('不应调用'); }, pluginsDir: path.join(dir, 'plugins') });
  await assert.rejects(() => market.install('../evil'), /非法插件 id/);
  assert.equal(changed(), 0);
});

test('install 市场不存在的 id 拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fetchImpl = routeFetch({ [urls[0].url]: { text: MANIFEST } });
  const { market } = makeMarket({ fetchImpl, pluginsDir: path.join(dir, 'plugins') });
  await assert.rejects(() => market.install('nope'), /市场不存在/);
});

test('uninstall 删除文件并触发 onChanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'weather.js'), 'x');
  const { market, changed } = makeMarket({ fetchImpl: async () => { throw new Error('uninstall 不应下载'); }, pluginsDir });
  await market.uninstall('weather');
  assert.ok(!fs.existsSync(path.join(pluginsDir, 'weather.js')));
  assert.equal(changed(), 1);
});

test('updateAll 重装所有已安装插件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'weather.js'), 'old');
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fileUrls = buildChannelUrls('o/plugins', 'main', 'plugin-weather/plugin-weather.js');
  const fetchImpl = routeFetch({
    [urls[0].url]: { text: MANIFEST },
    [fileUrls[0].url]: { text: 'new-content' }
  });
  const { market } = makeMarket({ fetchImpl, pluginsDir });
  const results = await market.updateAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(fs.readFileSync(path.join(pluginsDir, 'weather.js'), 'utf-8'), 'new-content');
});

test('install 下载失败时无残留临时文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fileUrls = buildChannelUrls('o/plugins', 'main', 'plugin-weather/plugin-weather.js');
  const fetchImpl = routeFetch({
    [urls[0].url]: { text: MANIFEST },
    [urls[1].url]: { text: MANIFEST },
    [fileUrls[0].url]: { error: new Error('down') },
    [fileUrls[1].url]: { error: new Error('down') }
  });
  const { market } = makeMarket({ fetchImpl, pluginsDir });
  await assert.rejects(() => market.install('weather'), /下载失败/);
  assert.ok(!fs.existsSync(path.join(pluginsDir, '.tmp-weather.js')));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx node --test test/market.test.js`
Expected: FAIL — `createMarket is not a function`（新测试全红，Task 2 的 8 个仍过）

- [ ] **Step 3: 实现 createMarket**

`src/main/market.js` 末尾追加（module.exports 改为导出 createMarket）：

```js
function createMarket({ getConfig, configDir, fetch, onChanged = () => {} }) {
  const pluginsDir = () => path.join(configDir, 'plugins');
  const repo = () => (getConfig().market && getConfig().market.repo) || DEFAULT_REPO;
  const branch = () => (getConfig().market && getConfig().market.branch) || DEFAULT_BRANCH;

  // 依次尝试通道，全部失败抛错
  async function fetchText(filePath) {
    let lastErr = null;
    for (const ch of buildChannelUrls(repo(), branch(), filePath)) {
      try {
        const res = await fetch(ch.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return { channel: ch.name, text: await res.text() };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error('下载失败: ' + filePath + (lastErr ? ' (' + lastErr.message + ')' : ''));
  }

  function getInstalledIds() {
    const dir = pluginsDir();
    if (!fs.existsSync(dir)) return new Set();
    return new Set(fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, '')));
  }

  function enablePlugin(id) {
    const disabled = (getConfig().plugins && getConfig().plugins.disabled) || [];
    if (disabled.includes(id)) getConfig().plugins.disabled = disabled.filter(n => n !== id);
  }

  async function list() {
    const installed = getInstalledIds();
    const { channel, text } = await fetchText('plugins.json');
    return parseManifest(text).map(p => ({ ...p, installed: installed.has(p.id), channel }));
  }

  // 下载到临时文件后原子改名，避免半截文件；失败时清理临时文件
  async function downloadToFile(id, file) {
    const dir = pluginsDir();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.tmp-' + id + '.js');
    try {
      const { text } = await fetchText(file);
      fs.writeFileSync(tmp, text, 'utf-8');
      fs.renameSync(tmp, path.join(dir, id + '.js'));
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  async function install(id) {
    if (!isSafeId(id)) throw new Error('非法插件 id: ' + id);
    const plugins = await list();
    const entry = plugins.find(p => p.id === id);
    if (!entry) throw new Error('市场不存在插件: ' + id);
    await downloadToFile(id, entry.file);
    enablePlugin(id);
    onChanged();
    return { ok: true };
  }

  async function uninstall(id) {
    if (!isSafeId(id)) throw new Error('非法插件 id: ' + id);
    const target = path.join(pluginsDir(), id + '.js');
    if (fs.existsSync(target)) fs.unlinkSync(target);
    onChanged();
    return { ok: true };
  }

  async function updateAll() {
    const plugins = await list();
    const results = [];
    for (const p of plugins) {
      if (!p.installed) continue;
      try { await install(p.id); results.push({ id: p.id, ok: true }); }
      catch (e) { results.push({ id: p.id, ok: false, error: String(e.message || e) }); }
    }
    return results;
  }

  return { list, install, uninstall, updateAll };
}

module.exports = { isSafeId, buildChannelUrls, parseManifest, createMarket };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx node --test test/market.test.js`
Expected: PASS（16 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/main/market.js test/market.test.js
git commit -m "feat: 插件市场 createMarket（列表/安装/卸载/批量更新）"
```

---

### Task 4: updater.js 加速通道回退状态机

**Files:**
- Modify: `src/main/updater.js`
- Test: `test/updater.test.js`

- [ ] **Step 1: 更新 mock 并写失败测试**

`test/updater.test.js` 顶部，`mockAutoUpdater` 改为支持 `failFirst` 与 `setFeedURL` 记录：

```js
function mockAutoUpdater({ failFirst = 0 } = {}) {
  const au = new EventEmitter();
  let calls = 0;
  au.checkForUpdates = () => {
    calls++;
    au.checkCalled = true;
    if (calls <= failFirst) return Promise.reject(new Error('网络不可用'));
    return Promise.resolve({});
  };
  au.quitAndInstall = () => { au.quitCalled = true; };
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
  au.setFeedURL = (opts) => { (au.feedHistory = au.feedHistory || []).push(opts); };
  au.failFirst = failFirst;
  return au;
}
```

在文件末尾追加：

```js
test('首通道失败自动换下一通道并成功', async () => {
  const au = mockAutoUpdater({ failFirst: 1 });
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1', 'https://p2'], publishRepo: 'o/r', onStatus: s => seen.push(s) });
  updater.init();
  const p = updater.checkNow();
  // 等一个宏任务，让通道回退的微任务链先走完（回退到 p2、进入 checking 态）
  await new Promise(r => setTimeout(r, 0));
  au.emit('update-not-available');
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['generic', 'generic']);
  assert.deepEqual(au.feedHistory.map(f => f.url), [
    'https://p1/https://github.com/o/r/releases/latest/download',
    'https://p2/https://github.com/o/r/releases/latest/download'
  ]);
  assert.equal(seen[seen.length - 1].code, 'uptodate');
});

test('全部通道失败置 error，最后一个是原生 github', async () => {
  const au = mockAutoUpdater({ failFirst: 3 });
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1', 'https://p2'], publishRepo: 'o/r', onStatus: s => seen.push(s) });
  updater.init();
  const p = updater.checkNow();
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['generic', 'generic', 'github']);
  assert.equal(seen[seen.length - 1].code, 'error');
  assert.ok(seen[seen.length - 1].error.includes('网络不可用'));
});

test('无 proxyChannels 时只走原生 github feed', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const updater = createUpdater({ autoUpdater: au, publishRepo: 'o/r' });
  updater.init();
  await updater.checkNow();
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['github']);
});

test('下载阶段错误不换通道', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', onStatus: s => seen.push(s) });
  updater.init();
  await updater.checkNow(); // 检查成功
  const historyLen = au.feedHistory.length;
  au.emit('error', new Error('下载中断'));
  assert.equal(au.feedHistory.length, historyLen, '错误事件不触发换通道');
  assert.equal(seen[seen.length - 1].code, 'error');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx node --test test/updater.test.js`
Expected: 新增 4 个 FAIL（旧测试因 `setFeedURL` 未 mock 也报错，属预期）

- [ ] **Step 3: 实现通道回退**

整体替换 `src/main/updater.js`：

```js
// src/main/updater.js
// 封装 electron-updater 为状态机 + 加速通道回退。
// 不直接 require electron-updater，由上层注入，便于单测 mock。
function createUpdater(deps) {
  const {
    autoUpdater,
    onStatus = () => {},
    onDownloaded = () => {},
    isEnabled = () => true,
    checkDelayMs = 3000,
    proxyChannels = [],                 // 加速前缀列表，如 ['https://gh.ddlc.top']
    publishRepo = 'NothingCooker/rimletter'
  } = deps;

  let state = { code: 'idle' };
  let downloadedInfo = null;
  let checking = false;

  function setState(patch) { state = { ...state, ...patch }; onStatus(state); }
  function getState() { return { ...state }; }

  // 通道列表：每个加速前缀一个 generic feed，末尾追加原生 github feed
  function buildChannels() {
    const parts = publishRepo.split('/');
    const owner = parts[0], repo = parts[1];
    const channels = proxyChannels.map(base => ({
      label: base.replace(/^https?:\/\//, ''),
      apply: () => autoUpdater.setFeedURL({
        provider: 'generic',
        url: base + '/https://github.com/' + owner + '/' + repo + '/releases/latest/download'
      })
    }));
    channels.push({
      label: 'github',
      apply: () => autoUpdater.setFeedURL({ provider: 'github', owner, repo })
    });
    return channels;
  }

  function init() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // 退出应用时自动装已下载的更新
    autoUpdater.on('checking-for-update', () => setState({ code: 'checking' }));
    autoUpdater.on('update-available', (info) => setState({ code: 'update-available', version: info && info.version }));
    autoUpdater.on('update-not-available', () => setState({ code: 'uptodate' }));
    autoUpdater.on('download-progress', () => setState({ code: 'downloading' }));
    autoUpdater.on('update-downloaded', (info) => {
      downloadedInfo = info;
      setState({ code: 'downloaded', version: info && info.version });
      onDownloaded(info);
    });
    autoUpdater.on('error', (err) => {
      // 检查阶段（checking=true）错误由 checkNow 的通道回退处理；
      // 下载阶段（checking=false）错误直接报错，不换通道。
      if (!checking) setState({ code: 'error', error: (err && err.message) || String(err) });
    });
  }

  function checkNow() {
    if (!isEnabled()) { setState({ code: 'disabled' }); return Promise.resolve(null); }
    if (checking) return Promise.resolve(null);
    checking = true;
    const channels = buildChannels();
    let idx = 0;
    function attempt() {
      const ch = channels[idx];
      try { ch.apply(); } catch (e) { /* setFeedURL 异常也视为该通道失败，继续回退 */ }
      setState({ code: 'checking', channel: ch.label });
      return autoUpdater.checkForUpdates()
        .then(() => { /* 成功：事件监听会置最终状态 */ })
        .catch((err) => {
          if (idx < channels.length - 1) { idx++; return attempt(); }
          setState({ code: 'error', error: (err && err.message) || String(err) });
        });
    }
    return attempt().finally(() => { checking = false; });
  }

  function scheduleInitialCheck() {
    setTimeout(() => { if (isEnabled()) checkNow(); }, checkDelayMs);
  }

  function quitAndInstall() {
    if (downloadedInfo) autoUpdater.quitAndInstall();
  }

  return { init, checkNow, scheduleInitialCheck, quitAndInstall, getState };
}

module.exports = { createUpdater };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx node --test test/updater.test.js`
Expected: 全部 PASS（旧 9 个 + 新 4 个）

- [ ] **Step 5: 提交**

```bash
git add src/main/updater.js test/updater.test.js
git commit -m "feat: 自动更新加速通道回退（setFeedURL 切 feed，失败换通道）"
```

---

### Task 5: main.js 接线市场与更新通道

**Files:**
- Modify: `src/main/main.js`

- [ ] **Step 1: 引入 market 模块并创建实例**

顶部 require 区，`const { loadPlugins, assertSchema, normalizeConfig, getPluginConfig } = require('./plugins');` 下方加：

```js
const { createMarket } = require('./market');
```

模块级变量区（`let updater = null;` 附近）加：

```js
let market = null;
```

- [ ] **Step 2: 创建 market 实例**

`app.whenReady().then(...)` 内，`config = loadConfig(configDir);` 之后加：

```js
  market = createMarket({
    getConfig: () => config,              // 必须返回 live config 对象（非深拷贝），enablePlugin 会原地改它
    setConfig: (cfg) => saveConfig(configDir, cfg),  // install 启用后立即持久化
    configDir,
    fetch: globalThis.fetch,
    onChanged: () => { reloadEverything(); }        // 装/卸后重载插件
  });
```

- [ ] **Step 3: initUpdater 传入通道配置**

`initUpdater()` 中 `createUpdater({...})` 的入参加两个字段：

```js
    proxyChannels: (config.update && config.update.proxyChannels) || [],
    publishRepo: 'NothingCooker/rimletter'
```

（在 `isEnabled` 行后插入）

- [ ] **Step 4: 新增 IPC 处理器**

`ipcMain.handle('plugins:dir', ...)` 之后加：

```js
ipcMain.handle('market:list', () => market ? market.list() : { error: 'market 未初始化' });
ipcMain.handle('market:install', (e, id) => market ? market.install(id) : { ok: false, error: 'market 未初始化' });
ipcMain.handle('market:uninstall', (e, id) => market ? market.uninstall(id) : { ok: false, error: 'market 未初始化' });
ipcMain.handle('market:updateAll', () => market ? market.updateAll() : { error: 'market 未初始化' });
```

- [ ] **Step 5: 验证无语法错误并跑全量测试**

Run: `npx node --test`
Expected: 全部 PASS（含 market/updater/config 新测试）

- [ ] **Step 6: 冒烟启动（可选，手动）**

Run: `npm start`
Expected: 托盘出现，设置窗可打开；本 Task 无 UI 变化，运行不崩即可。关闭应用。

- [ ] **Step 7: 提交**

```bash
git add src/main/main.js
git commit -m "feat: 接线插件市场 IPC 与更新加速通道配置"
```

---

### Task 6: preload 桥接 + 设置窗插件市场 UI

**Files:**
- Modify: `src/renderer/preload.js`
- Modify: `src/renderer/settings.js`

- [ ] **Step 1: preload 暴露市场接口**

`src/renderer/preload.js`，`installUpdate` 行后加：

```js
  listMarket: () => ipcRenderer.invoke('market:list'),
  installPlugin: (id) => ipcRenderer.invoke('market:install', id),
  uninstallPlugin: (id) => ipcRenderer.invoke('market:uninstall', id),
  updateAllPlugins: () => ipcRenderer.invoke('market:updateAll'),
```

- [ ] **Step 2: 插件管理页加市场区块**

`src/renderer/settings.js` 的 `renderPlugins()` 函数，在 `el.innerHTML = ...` 赋值处，把开头改为插入市场容器：

```js
async function renderPlugins() {
  const el = document.getElementById('pane-plugins');
  el.innerHTML =
    '<div style="margin-bottom:8px">' +
    '<button class="rw-btn" id="plug-reload">重新加载插件</button> ' +
    '<button class="rw-btn" id="plug-dir">打开插件目录</button> ' +
    '<button class="rw-btn" id="plug-docs">插件开发文档</button></div>' +
    '<div id="plug-docs-box" style="display:none;margin-bottom:10px"></div>' +
    '<div class="rw-sep"></div>' +
    '<div style="font-size:13px;color:#fff;font-weight:600;margin:8px 0">插件市场</div>' +
    '<div style="margin-bottom:8px">' +
    '<button class="rw-btn" id="mkt-refresh">刷新市场</button> ' +
    '<button class="rw-btn" id="mkt-update-all">更新全部</button></div>' +
    '<div id="mkt-list" style="font-size:12px;color:#c8d0da">加载中…</div>' +
    '<div style="margin:8px 0;font-size:11px;color:#7f8a96">⚠ 插件将获得本机完全执行权限，仅从官方仓库安装可信插件。</div>' +
    '<div class="rw-sep"></div>' +
    '<div style="font-size:13px;color:#fff;font-weight:600;margin:8px 0">已安装插件</div>' +
    '<div id="plug-list" style="font-size:12px;color:#c8d0da">加载中…</div>';

  // ...原有 reload/dir/docs 按钮绑定保持...

  // 市场刷新/更新全部按钮在 renderPlugins 里绑定（renderMarket 可能提前 return 导致漏绑）
  document.getElementById('mkt-refresh').addEventListener('click', renderMarket);
  document.getElementById('mkt-update-all').addEventListener('click', async () => {
    const btn = document.getElementById('mkt-update-all');
    btn.textContent = '更新中…';
    try { await window.rimletter.updateAllPlugins(); renderPlugins(); }
    catch (e) { alert('更新失败：' + (e.message || e)); btn.textContent = '更新全部'; }
  });

  renderMarket();
  renderLocalPlugins();
}
```

- [ ] **Step 3: 拆分本地插件渲染并绑定**

把 `renderPlugins()` 中**从 `const plugs = await window.rimletter.listPlugins();` 到函数末尾**的代码，抽成独立函数 `renderLocalPlugins()`（内容原样，仅把局部变量 `plugs`/`list` 声明移到新函数开头）。`renderPlugins()` 只保留按钮绑定 + 调 `renderMarket()` 与 `renderLocalPlugins()`。

在 `renderPlugins` 定义后加市场渲染函数：

```js
async function renderMarket() {
  const box = document.getElementById('mkt-list');
  let data;
  try {
    data = await window.rimletter.listMarket();
  } catch (e) {
    box.innerHTML = '<span style="color:#ff8888">市场加载失败：' + esc(e.message || e) + '</span>';
    return;
  }
  if (!data || !Array.isArray(data)) {
    box.innerHTML = '<span style="color:#ff8888">' + esc((data && data.error) || '市场不可用') + '</span>';
    return;
  }
  if (!data.length) {
    box.innerHTML = '<span style="color:#7f8a96">官方仓库暂无插件。</span>';
    return;
  }
  box.innerHTML = '<table class="rw-rule">' +
    '<tr><th>插件</th><th>说明</th><th>状态</th><th style="width:180px">操作</th></tr>' +
    data.map(p =>
      '<tr><td><b>' + esc(p.name) + '</b></td>' +
      '<td>' + esc(p.desc) + '</td>' +
      '<td>' + (p.installed ? '<span style="color:#8fce8f">已安装</span>' : '<span style="color:#7f8a96">未安装</span>') + '</td>' +
      '<td>' +
        (p.installed
          ? '<button class="rw-btn small" data-mkt-update="' + esc(p.id) + '">更新</button> ' +
            '<button class="rw-btn small" data-mkt-uninstall="' + esc(p.id) + '">卸载</button>'
          : '<button class="rw-btn small" data-mkt-install="' + esc(p.id) + '">安装</button>') +
      '</td></tr>').join('') + '</table>';

  box.querySelectorAll('[data-mkt-install]').forEach(b => b.addEventListener('click', async () => {
    b.textContent = '…';
    try { await window.rimletter.installPlugin(b.dataset.mktInstall); renderPlugins(); }
    catch (e) { b.textContent = '失败'; alert('安装失败：' + (e.message || e)); }
  }));
  box.querySelectorAll('[data-mkt-update]').forEach(b => b.addEventListener('click', async () => {
    b.textContent = '…';
    try { await window.rimletter.installPlugin(b.dataset.mktUpdate); renderPlugins(); }
    catch (e) { b.textContent = '失败'; alert('更新失败：' + (e.message || e)); }
  }));
  box.querySelectorAll('[data-mkt-uninstall]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('卸载插件「' + b.dataset.mktUninstall + '」？将删除其 .js 文件。')) return;
    try { await window.rimletter.uninstallPlugin(b.dataset.mktUninstall); renderPlugins(); }
    catch (e) { alert('卸载失败：' + (e.message || e)); }
  }));
}
```

注意：`renderMarket` 依赖 `esc`、`rw-sep`、`rw-rule`、`rw-btn` 等既有工具/样式，均已存在，勿重复定义。

- [ ] **Step 4: 验证（手动）**

Run: `npm start` → 托盘 → 设置 → 插件管理
Expected: 顶部出现「插件市场」区块；「刷新市场」能拉出 weather/night-watch/claude；安装后状态变「已安装」且下方「已安装插件」表出现该插件；卸载/更新可用。

- [ ] **Step 5: 跑全量测试 + 提交**

Run: `npx node --test`（Expected: 全过）
```bash
git add src/renderer/preload.js src/renderer/settings.js
git commit -m "feat: 设置窗插件市场 UI（jsDelivr 列表/安装/卸载/更新）"
```

---

### Task 7: 官方插件仓库添加 plugins.json

**Files:**
- Create: `D:\claudeswork\official-plugin\plugins.json`（独立仓库）

- [ ] **Step 1: 创建清单**

在 `D:\claudeswork\official-plugin\` 根目录创建 `plugins.json`：

```json
{
  "version": 1,
  "plugins": [
    { "id": "weather", "name": "天气信", "desc": "天气变化/气温骤变/每日简报/恶劣天气预警", "author": "NothingCooker", "file": "plugin-weather/plugin-weather.js", "version": "1.0.0" },
    { "id": "night-watch", "name": "深夜提醒", "desc": "每晚固定时点一封「夜深了」红信", "author": "NothingCooker", "file": "plugin-night-watch/plugin-night-watch.js", "version": "1.0.0" },
    { "id": "claude", "name": "Claude Code 对接", "desc": "授权/报错/回答完成来信", "author": "NothingCooker", "file": "plugin-claude/plugin-claude.js", "version": "1.0.0" }
  ]
}
```

- [ ] **Step 2: 校验路径存在**

Run: `ls D:/claudeswork/official-plugin/plugin-weather/plugin-weather.js D:/claudeswork/official-plugin/plugin-night-watch/plugin-night-watch.js D:/claudeswork/official-plugin/plugin-claude/plugin-claude.js`
Expected: 三个文件均存在（清单 file 字段与真实路径一致）

- [ ] **Step 3: 本地验证 jsDelivr 可达**

Run: `node -e "fetch('https://cdn.jsdelivr.net/gh/NothingCooker/rimletter-official-plugins@main/plugins.json').then(r=>r.text()).then(t=>console.log(t.slice(0,80))).catch(e=>console.log('ERR',e.message))"`
Expected: 输出 JSON 开头；若 404 说明仓库还没 push（Step 4 后重试）

- [ ] **Step 4: 提交并推送官方仓库**

```bash
cd D:/claudeswork/official-plugin
git add plugins.json
git commit -m "feat: 插件市场清单 plugins.json"
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 git push origin main
```

（代理见 PROJECT.md §11；若仓库已配置远程，`git push` 即可。）

- [ ] **Step 5: 再验证 jsDelivr**

重跑 Step 3 命令，Expected: 输出完整 JSON。

---

### Task 8: 全量验证

**Files:**
- 无改动

- [ ] **Step 1: 全量单测**

Run: `npx node --test`
Expected: 全部 PASS（74 + 新增 = 约 94 个）

- [ ] **Step 2: 应用冒烟**

Run: `npm start`
Expected:
- 托盘出现，设置窗可开
- 插件管理页市场区能拉到 3 个官方插件并安装 weather → 出现「已安装」+ 启用
- 常规页「自动更新」开启时，手动「立即检查」在加速通道失败时能落到原生通道（或成功）

- [ ] **Step 3: 更新 CLAUDE.md 实现状态**

在 `src/main/main.js` 对应模块列表（`api.js` 附近）补一行：
`src/main/market.js      插件市场（jsDelivr 清单 + 安装/卸载/更新）`

并在 CLAUDE.md 实现状态区加一行 `v0.2.11` 记录（等发布时再 bump 版本）。

- [ ] **Step 4: 提交文档改动**

```bash
git add CLAUDE.md
git commit -m "docs: 记录插件市场模块"
```

---

## 执行顺序提醒

任务按 1→8 顺序执行，每任务独立提交。Task 7 依赖官方仓库（需 push），可在 Task 6 后并行做。任何一步测试不通过不要继续下一步，先修复。
