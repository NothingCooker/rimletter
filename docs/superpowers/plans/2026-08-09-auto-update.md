# 自动更新功能 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 RimLetter 增加 electron-updater 自动更新：启动静默检查 GitHub Releases → 有新版则后台下载 → 用「信」通知 → 重启自动安装；设置页可关闭、可手动检查/立即重启安装。

**Architecture:** 新增纯封装模块 `src/main/updater.js`（依赖注入 autoUpdater，便于单测 mock），通过状态机事件把 electron-updater 事件转成上层可读状态；主进程 ready 后初始化并延时首查；preload 桥接 IPC 到设置页渲染「自动更新」开关 + 状态行 + 两个按钮。config 加 `update.enabled`（默认 true，deepMerge 兼容旧配置）。

**Tech Stack:** Node 内置 `node:test` 单测；`electron-updater`（运行时依赖，随 electron-builder 的 `publish: github` 发布元数据对接）；Electron 43。

**设计文档：** `docs/superpowers/specs/2026-08-09-auto-update-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/main/updater.js`（新建） | 封装 electron-updater 的状态机；不直接 require electron-updater，靠注入 |
| `test/updater.test.js`（新建） | updater 状态机单测（mock EventEmitter） |
| `src/main/config.js` | `DEFAULT_CONFIG` 加 `update: { enabled: true }` |
| `test/config.test.js` | 补 update 默认值 + 持久化测试 |
| `src/main/main.js` | 组装 updater、IPC handlers、下载完成发「信」、dev 模式 forceDevUpdateConfig |
| `src/renderer/preload.js` | 暴露 `getUpdateState/checkForUpdate/installUpdate/onUpdateStatus` |
| `src/renderer/settings.js` | 常规页加自动更新开关 + 状态行 + 立即检查/立即重启安装按钮 |
| `dev-app-update.yml`（新建） | dev 模式联调用（provider github） |
| `package.json` | 加 `electron-updater` 依赖；后续 bump 到 0.2.3 |

---

### Task 1: 安装 electron-updater 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装依赖（进 dependencies，运行时需打进包）**

```bash
cd "D:\claudeswork\RIM DESKTOP" && npm install electron-updater@^6
```

- [ ] **Step 2: 验证依赖已进 dependencies**

Run: `node -e "console.log(require('./package.json').dependencies)"`
Expected: 输出包含 `electron-updater: '^6...'`

- [ ] **Step 3: 提交**

```bash
git add package.json package-lock.json
git commit -m "chore: add electron-updater dependency"
```

---

### Task 2: 配置 update.enabled（TDD）

**Files:**
- Modify: `src/main/config.js`
- Modify: `test/config.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/config.test.js` 末尾追加：

```js
test('update.enabled 默认开启', () => {
  assert.equal(DEFAULT_CONFIG.update.enabled, true);
});

test('update.enabled 可持久化关闭', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.update.enabled = false;
  saveConfig(dir, cfg);
  const again = loadConfig(dir);
  assert.equal(again.update.enabled, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot read properties of undefined (reading 'enabled')`

- [ ] **Step 3: 实现**

在 `src/main/config.js` 的 `DEFAULT_CONFIG` 中，`sound` 行之后加：

```js
  sound: { enabled: true, volume: 0.7 },
  update: { enabled: true },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（35 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/config.js test/config.test.js
git commit -m "feat: config.update.enabled default on (auto-update toggle)"
```

---

### Task 3: updater 状态机模块（TDD）

**Files:**
- Create: `test/updater.test.js`
- Create: `src/main/updater.js`

- [ ] **Step 1: 写失败测试**

创建 `test/updater.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('../src/main/updater');

function mockAutoUpdater() {
  const au = new EventEmitter();
  au.checkForUpdates = () => { au.checkCalled = true; return Promise.resolve({}); };
  au.quitAndInstall = () => { au.quitCalled = true; };
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
  return au;
}

test('init 设置 autoDownload/autoInstallOnAppQuit 并挂接事件', () => {
  const au = mockAutoUpdater();
  const updater = createUpdater({ autoUpdater: au });
  updater.init();
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  assert.equal(au.listenerCount('update-downloaded'), 1);
});

test('disabled 时 checkNow 不调用 checkForUpdates 且状态为 disabled', async () => {
  const au = mockAutoUpdater();
  let status = null;
  const updater = createUpdater({ autoUpdater: au, isEnabled: () => false, onStatus: s => status = s });
  updater.init();
  const r = await updater.checkNow();
  assert.equal(au.checkCalled, undefined);
  assert.equal(status.code, 'disabled');
  assert.equal(r, null);
});

test('checkNow 置 checking，update-not-available 后置 uptodate', async () => {
  const au = mockAutoUpdater();
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, onStatus: s => seen.push(s) });
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.deepEqual(seen.map(s => s.code), ['checking', 'uptodate']);
});

test('update-available 记录版本号', () => {
  const au = mockAutoUpdater();
  let status = null;
  const updater = createUpdater({ autoUpdater: au, onStatus: s => status = s });
  updater.init();
  au.emit('update-available', { version: '0.2.3' });
  assert.equal(status.code, 'update-available');
  assert.equal(status.version, '0.2.3');
});

test('download-progress 置 downloading', () => {
  const au = mockAutoUpdater();
  let status = null;
  const updater = createUpdater({ autoUpdater: au, onStatus: s => status = s });
  updater.init();
  au.emit('download-progress', { percent: 50 });
  assert.equal(status.code, 'downloading');
});

test('update-downloaded 置 downloaded 并触发 onDownloaded', () => {
  const au = mockAutoUpdater();
  let status = null, got = null;
  const updater = createUpdater({ autoUpdater: au, onStatus: s => status = s, onDownloaded: info => got = info });
  updater.init();
  const info = { version: '0.2.3' };
  au.emit('update-downloaded', info);
  assert.equal(status.code, 'downloaded');
  assert.equal(got, info);
});

test('error 事件置 error 状态', () => {
  const au = mockAutoUpdater();
  let status = null;
  const updater = createUpdater({ autoUpdater: au, onStatus: s => status = s });
  updater.init();
  au.emit('error', new Error('网络不可用'));
  assert.equal(status.code, 'error');
  assert.ok(status.error.includes('网络不可用'));
});

test('未下载时 quitAndInstall 不调用，下载后调用', () => {
  const au = mockAutoUpdater();
  const updater = createUpdater({ autoUpdater: au });
  updater.init();
  updater.quitAndInstall();
  assert.equal(au.quitCalled, undefined);
  au.emit('update-downloaded', { version: '0.2.3' });
  updater.quitAndInstall();
  assert.equal(au.quitCalled, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/main/updater'`

- [ ] **Step 3: 实现**

创建 `src/main/updater.js`：

```js
// src/main/updater.js
// 封装 electron-updater 为状态机。不直接 require electron-updater，由上层注入，便于单测 mock。
function createUpdater(deps) {
  const {
    autoUpdater,
    onStatus = () => {},
    onDownloaded = () => {},
    isEnabled = () => true,
    checkDelayMs = 3000
  } = deps;

  let state = { code: 'idle' };
  let downloadedInfo = null;
  let checking = false;

  function setState(patch) { state = { ...state, ...patch }; onStatus(state); }
  function getState() { return { ...state }; }

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
    autoUpdater.on('error', (err) => setState({ code: 'error', error: (err && err.message) || String(err) }));
  }

  function checkNow() {
    if (!isEnabled()) { setState({ code: 'disabled' }); return Promise.resolve(null); }
    if (checking) return Promise.resolve(null);
    checking = true;
    setState({ code: 'checking' });
    return autoUpdater.checkForUpdates()
      .catch((err) => setState({ code: 'error', error: (err && err.message) || String(err) }))
      .finally(() => { checking = false; });
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

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（43 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/main/updater.js test/updater.test.js
git commit -m "feat: updater state machine (electron-updater wrapper)"
```

---

### Task 4: 主进程 + preload 集成

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/renderer/preload.js`

- [ ] **Step 1: main.js 引入与初始化**

在 `src/main/main.js` 顶部，`const { loadPlugins } = require('./plugins');` 之后加：

```js
const { createUpdater } = require('./updater');
const { autoUpdater } = require('electron-updater');
```

在 `let lastPluginResults = [];` 之后加：

```js
let updater = null;
```

在 `function send(channel, payload) {...}` 之后加：

```js
function sendToSettings(channel, payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
}
```

在 `function makePluginApi() {...}` 之后加：

```js
function initUpdater() {
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true; // dev 模式用 dev-app-update.yml
  updater = createUpdater({
    autoUpdater,
    isEnabled: () => !!(config.update && config.update.enabled),
    onStatus: (st) => sendToSettings('update:status', st),
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

- [ ] **Step 2: main.js 加 IPC handlers**

在 `ipcMain.on('overlay:mouseover', ...)` 之后加：

```js
ipcMain.handle('update:state', () => updater ? updater.getState() : { code: 'idle' });
ipcMain.handle('update:check', () => updater ? updater.checkNow() : null);
ipcMain.handle('update:install', () => { if (updater) updater.quitAndInstall(); return true; });
```

- [ ] **Step 3: main.js ready 时初始化**

在 `app.whenReady().then(() => {` 块内，`reloadEverything();` 之后加 `initUpdater();`。

- [ ] **Step 4: preload 暴露 API**

在 `src/renderer/preload.js` 的 `onConfigChange: ...` 之后加：

```js
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, st) => cb(st)),
```

- [ ] **Step 5: 冒烟验证**

Run: `npm test`
Expected: PASS（43 个测试，不受影响）

- [ ] **Step 6: 提交**

```bash
git add src/main/main.js src/renderer/preload.js
git commit -m "feat: wire updater into main process + preload API"
```

---

### Task 5: 设置页 UI

**Files:**
- Modify: `src/renderer/settings.js`

- [ ] **Step 1: 常规页加自动更新行**

在 `src/renderer/settings.js` 的 `renderGeneral()` 里，音量 slider 行结束的 `';` 之后、`bindSliders(el);` 之前，追加：

```js
    '<div class="rw-sep"></div>' +
    '<div class="rw-row"><span class="rw-lbl">自动更新</span>' +
      '<span class="rw-cb' + (config.update.enabled ? ' on' : '') + '" data-toggle="update.enabled"></span>' +
      '<span class="rw-gray">' + (config.update.enabled ? '开启' : '关闭') + '</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">更新状态</span>' +
      '<span class="rw-gray" id="update-status">…</span>' +
      '<button class="rw-btn" id="update-check-btn">立即检查</button>' +
      '<button class="rw-btn" id="update-install-btn" style="display:none">立即重启安装</button></div>';
```

- [ ] **Step 2: 加状态显示与按钮逻辑**

在 `renderGeneral()` 里 `el.querySelectorAll('[data-toggle]').forEach(...)` 块之后、`// 开机自启开关` 之前，插入：

```js
  // 自动更新状态与按钮
  const statusEl = document.getElementById('update-status');
  const installBtn = document.getElementById('update-install-btn');
  document.getElementById('update-check-btn').addEventListener('click', async () => {
    await window.rimletter.checkForUpdate();
    window.rimletter.getUpdateState().then(showUpdateStatus);
  });
  installBtn.addEventListener('click', () => window.rimletter.installUpdate());
  window.rimletter.getUpdateState().then(showUpdateStatus);
  window.rimletter.onUpdateStatus(showUpdateStatus);
  function showUpdateStatus(st) {
    if (!statusEl) return;
    const map = {
      idle: '未检查',
      checking: '正在检查更新…',
      uptodate: '已是最新版本',
      'update-available': '发现新版本 v' + (st.version || '?') + '，正在下载…',
      downloading: '正在下载…',
      downloaded: '新版本 v' + (st.version || '?') + ' 已下载，重启后安装',
      disabled: '自动更新已关闭',
      error: '检查失败：' + (st.error || '未知错误')
    };
    statusEl.textContent = map[st.code] || st.code;
    installBtn.style.display = (st.code === 'downloaded') ? '' : 'none';
  }
```

（`showUpdateStatus` 是函数声明，在 `renderGeneral` 作用域内被提升，先引用后声明没问题。）

- [ ] **Step 3: 视觉验证**

Run: `npm start`
操作：托盘 → 设置 → 常规页，确认出现「自动更新」开关（默认开）、「更新状态」行、「立即检查」按钮，观感与音效行一致；开关点击可切换「开启/关闭」并持久化（`%APPDATA%\rimletter\config.json` 里 `update.enabled` 变化）。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/settings.js
git commit -m "feat: settings UI for auto-update (toggle + status + buttons)"
```

---

### Task 6: dev 模式联调配置

**Files:**
- Create: `dev-app-update.yml`

- [ ] **Step 1: 创建 dev-app-update.yml**

创建 `dev-app-update.yml`（仓库根目录）：

```yaml
provider: github
owner: NothingCooker
repo: rimletter
```

（Task 4 Step 1 已让 dev 模式 `forceDevUpdateConfig = true`，此时 electron-updater 会读这个文件。）

- [ ] **Step 2: 提交**

```bash
git add dev-app-update.yml
git commit -m "chore: dev-app-update.yml for dev-mode update testing"
```

---

### Task 7: 全量测试

- [ ] **Step 1: 运行全部测试**

Run: `npm test`
Expected: PASS（43 个测试）

---

### Task 8: 发布前开发模式联调（手动，验证检测+下载管线）

**Files:**
- 临时改：`package.json`（测完恢复，不提交）

- [ ] **Step 1: 临时降低本地版本**

用编辑器把 `package.json` 的 `"version": "0.2.2"` 临时改为 `"0.2.1"`（仅本地，勿提交）。

- [ ] **Step 2: 启动应用观察更新检查**

Run: `npm start`
预期（主进程日志 / 应用行为）：
- 启动约 3s 后开始检查 GitHub Releases
- 应检测到 v0.2.2（> 0.2.1）→ 打印 `update-available`，随后 `download-progress` / `update-downloaded`（下载约百 MB，可能较慢；看到 update-available 即证明「网络 + latest.yml 解析 + 版本比较」链路通，下载完成事件证明下载管线通）
- 下载完成后应弹出一封中性灰蓝「RimLetter 新版本已下载」信
- 若网络失败：状态置 error，应用照常运行（验证静默降级）

- [ ] **Step 3: 恢复版本号**

```bash
cd "D:\claudeswork\RIM DESKTOP" && git checkout -- package.json
node -e "console.log(require('./package.json').version)"
```
Expected: `0.2.2`

---

### Task 9: 发布 v0.2.3

**Files:**
- Modify: `package.json`（bump 0.2.3）
- Modify: `PROJECT.md`（功能列表补自动更新）

- [ ] **Step 1: bump 版本并更新文档**

把 `package.json` version 改为 `0.2.3`；在 `PROJECT.md` 第 4 节功能特性里追加一行：`- 自动更新：启动静默检查 GitHub 新版，下载完成用「信」通知，重启自动安装；设置可关闭/立即检查/立即重启安装`。

- [ ] **Step 2: 提交并推送 master**

```bash
cd "D:\claudeswork\RIM DESKTOP"
git add package.json PROJECT.md
git commit -m "feat: auto-update via electron-updater; bump v0.2.3"
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 git push origin master
```

- [ ] **Step 3: 打 tag 并推送（触发 release.yml）**

```bash
git tag v0.2.3
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 git push origin v0.2.3
```

- [ ] **Step 4: 等待 CI 构建并查看草稿 Release**

```bash
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 "C:\Program Files\GitHub CLI\gh.exe" run list --repo NothingCooker/rimletter --workflow release.yml --limit 1
# 等 run 完成后：
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 "C:\Program Files\GitHub CLI\gh.exe" release view v0.2.3 --repo NothingCooker/rimletter
```
Expected: `draft: true`，含 `latest.yml` / `RimLetter-0.2.3-x64.exe` / `.blockmap`

- [ ] **Step 5: 发布草稿（写更新日志）**

```bash
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 "C:\Program Files\GitHub CLI\gh.exe" release edit v0.2.3 --repo NothingCooker/rimletter --draft=false --notes "## v0.2.3

### 新增
- 自动更新：启动后静默检查 GitHub Releases 新版本，下载完成后用「信」通知，重启应用自动安装
- 设置 → 常规：可关闭自动更新、点「立即检查」手动检查、点「立即重启安装」装已下载的版本
### 修复
- 设置窗口下拉菜单选项文字改为深色，解决白底白字看不清"
```

---

### Task 10: 发布后实测（完整升级链路）

**Files:** 无（用户机器上操作）

- [ ] **Step 1: 用户用已安装的旧版启动应用**

启动已装的旧版 RimLetter（< v0.2.3），预期：
- 约 3s 后自动检测到 v0.2.3 → 后台下载
- 下载完成弹中性灰蓝信「RimLetter 新版本已下载」
- 重启应用 → 自动安装 → 打开设置 → 关于页显示版本 0.2.3

- [ ] **Step 2: 若已装版本就是 0.2.3（本次装的新版）**

到设置 → 常规 → 点「立即检查」，状态应显示「已是最新版本」，验证手动检查与状态机正常。

---

## 自检记录

- **Spec 覆盖**：`update.enabled` 默认开 ✅（Task 2）；静默下载 + 信通知 + 重启安装 ✅（Task 3/4）；设置开关 + 手动检查/立即安装 ✅（Task 5）；错误静默降级 ✅（Task 3 `catch` + error 状态）；测试三步走 ✅（Task 2/3 单测、Task 8 发布前联调、Task 10 发布后实测）；发布 v0.2.3 ✅（Task 9）。
- **无占位符**：所有代码块完整、命令带预期输出。
- **类型一致**：状态码集合 `idle/checking/uptodate/update-available/downloading/downloaded/error/disabled` 在 updater.js、preload、settings.js 三处一致。
