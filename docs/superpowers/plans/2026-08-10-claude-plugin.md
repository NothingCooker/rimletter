# plugin-claude 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在官方插件仓库实现 `plugin-claude`——Claude Code 三事件（需要授权/报错/回答结束）经插件自建本地监听器转为 RimLetter 屏幕来信。

**Architecture:** 单文件 `plugin-claude.js` 双模式：被 RimLetter `require` 时是插件（开 127.0.0.1 监听器、注册配置、自动装钩子）；被 Claude Code 钩子用 `node "<路径>"` 运行时是转发器（读 stdin 事件 → 转发给监听器 → 退出 0）。映射/防抖/发信全在插件进程内用 `api.letter()` 完成，不依赖 RimLetter API 开关。

**Tech Stack:** Node.js（CommonJS，主进程插件环境）、`node:http`/`node:crypto`/`node:fs`、`node:test`（零依赖单测）。Claude Code hooks（`PermissionRequest`/`StopFailure`/`Stop`）写入用户级 `~/.claude/settings.json`。

**交付位置（独立 git 仓库）：** `D:\claudeswork\official-plugin\plugin-claude\`

**设计文档：** `docs/superpowers/specs/2026-08-10-claude-plugin-design.md`

---

## 关键事实（实现前必须知道）

- **Claude Code 钩子**（2026-08 文档）：`PermissionRequest`（需要授权，输入含 `tool_name`）、`StopFailure`（报错，输入含 `error`/`error_details`/`last_assistant_message`，matcher 为错误类型，`"*"` 匹配全部）、`Stop`（每次回答结束，输入含 `last_assistant_message`/`stop_hook_active`）。
- 钩子经 **stdin 一行 JSON** 传入事件；**stdout（exit 0）控制流程**。本插件永远输出空、退出 0，绝不阻塞 Claude，因此不会触发 Stop 死循环。
- Windows 上钩子经 **Git Bash (MSYS)** 执行：命令路径必须**正斜杠** + 双引号，`$` 会被 bash 展开。
- `~/.claude/settings.json` 当前 schema（`hooks` 为事件名→matcher-group 数组；matcher-group 规范形态 `{ hooks: [{ type: "command", command, timeout? }] }`，也接受扁平 `{ matcher, command, timeout }`）。**用户的 settings.json 现有 `env` 含敏感 token，合并时必须保留所有现有字段，只增量加 `hooks`。**
- `formatLetter` 对 sound 只有「空/'auto'→紧急度默认音效」「其他字符串→直接用」两种行为，**没有静音哨兵**；来信恒传 `sound:'auto'`。
- 插件运行于主进程 CommonJS，可直接 `require('node:http')` 等内置模块。
- 本机 `node` v24，`node --test` 可直接运行，无需 package.json。

---

### Task 1: 写单测（纯函数，先红后绿）

**Files:**
- Create: `D:\claudeswork\official-plugin\plugin-claude\test\claude.test.js`

- [ ] **Step 1: 创建测试文件**

写 `D:\claudeswork\official-plugin\plugin-claude\test\claude.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../plugin-claude.js');

const { mapEvent, dispatch, summarize, hookCommand, ensureHooks } = _test;

const DEFAULT_CFG = {
  enabled: true,
  autoInstallHooks: true,
  notifyPermission: true,
  notifyError: true,
  notifyDone: true,
  permissionSeverity: 'ThreatSmall',
  errorSeverity: 'NegativeEvent',
  doneSeverity: 'PositiveEvent',
  doneDebounceMs: 8000
};

test('mapEvent: PermissionRequest → 授权信', () => {
  const ev = { hook_event_name: 'PermissionRequest', tool_name: 'Bash' };
  const l = mapEvent(DEFAULT_CFG, ev);
  assert.equal(l.severity, 'ThreatSmall');
  assert.equal(l.title, 'Claude 需要你的授权');
  assert.match(l.description, /Bash/);
  assert.equal(l.sound, 'auto');
});

test('mapEvent: StopFailure → 报错信', () => {
  const ev = { hook_event_name: 'StopFailure', error: 'server_error', error_details: '5xx\n  from api' };
  const l = mapEvent(DEFAULT_CFG, ev);
  assert.equal(l.severity, 'NegativeEvent');
  assert.equal(l.title, 'Claude 报错了');
  assert.ok(l.description.startsWith('5xx from api'));
});

test('mapEvent: Stop → 完成信', () => {
  const ev = { hook_event_name: 'Stop', last_assistant_message: '  done\n  already ' };
  const l = mapEvent(DEFAULT_CFG, ev);
  assert.equal(l.severity, 'PositiveEvent');
  assert.equal(l.title, 'Claude 已完成回答');
  assert.equal(l.description, 'done already');
});

test('mapEvent: enabled=false → null', () => {
  assert.equal(mapEvent({ ...DEFAULT_CFG, enabled: false }, { hook_event_name: 'Stop' }), null);
});

test('mapEvent: notifyPermission=false → null', () => {
  assert.equal(mapEvent({ ...DEFAULT_CFG, notifyPermission: false }, { hook_event_name: 'PermissionRequest' }), null);
});

test('mapEvent: 未知事件 → null', () => {
  assert.equal(mapEvent(DEFAULT_CFG, { hook_event_name: 'UserPromptSubmit' }), null);
});

test('summarize: 折叠空白并截断', () => {
  assert.equal(summarize('  a\n  b  c ', 5), 'a b c');
  assert.equal(summarize('hello world', 3), 'hel');
});

test('dispatch: 正常发信并返回 true', () => {
  const sent = [];
  const last = { last: 0 };
  const ok = dispatch(DEFAULT_CFG, { letter: l => sent.push(l) }, last, { hook_event_name: 'Stop', last_assistant_message: 'hi' });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
});

test('dispatch: Stop 在防抖窗口内被跳过', () => {
  const sent = [];
  const last = { last: Date.now() };
  const ok = dispatch(DEFAULT_CFG, { letter: l => sent.push(l) }, last, { hook_event_name: 'Stop' });
  assert.equal(ok, false);
  assert.equal(sent.length, 0);
});

test('hookCommand: Windows 路径转正斜杠', () => {
  const cmd = hookCommand('C:\\Users\\x\\AppData\\Roaming\\rimletter\\plugins\\plugin-claude.js');
  assert.equal(cmd, 'node "C:/Users/x/AppData/Roaming/rimletter/plugins/plugin-claude.js"');
});

test('ensureHooks: 新增三条钩子、保留原字段、幂等', () => {
  const s = { theme: 'dark' };
  const sp = 'C:/a b/plugin.js';
  const c1 = ensureHooks(s, sp, ['PermissionRequest', 'StopFailure', 'Stop']);
  assert.equal(c1, true);
  assert.equal(s.theme, 'dark');
  assert.equal(s.hooks.PermissionRequest.length, 1);
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].type, 'command');
  assert.equal(s.hooks.StopFailure[0].hooks[0].matcher, '*');
  assert.equal(s.hooks.Stop.length, 1);
  const c2 = ensureHooks(s, sp, ['PermissionRequest', 'StopFailure', 'Stop']);
  assert.equal(c2, false);
});
```

- [ ] **Step 2: 运行测试，确认红**

Run: `cd "D:/claudeswork/official-plugin" && node --test plugin-claude/test/`

Expected: FAIL — `Cannot find module '../plugin-claude.js'`（文件还不存在）。

---

### Task 2: 实现 `plugin-claude.js`

**Files:**
- Create: `D:\claudeswork\official-plugin\plugin-claude\plugin-claude.js`
- Test: `D:\claudeswork\official-plugin\plugin-claude\test\claude.test.js`

- [ ] **Step 1: 写完整实现**

写 `D:\claudeswork\official-plugin\plugin-claude\plugin-claude.js`：

```js
// plugin-claude.js — Claude Code 对接插件（RimLetter）
// 双模式：
//   · 被 RimLetter require 加载 → 插件模式：本地监听器 + 配置 + 自动装钩子
//   · 被 Claude Code 钩子 `node "<此文件>"` 运行 → 钩子模式：转发 stdin 事件到监听器
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
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
const HOOK_EVENTS = ['PermissionRequest', 'StopFailure', 'Stop'];
const DEFAULT_PORT = 17342;

// ---------- 纯函数 ----------

function userDataDir() {
  // 与 config.json 同目录（%APPDATA%\rimletter）；不用 electron 以便钩子模式直接运行
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'rimletter')
    : path.join(os.homedir(), '.rimletter');
}
function stateFilePath() { return path.join(userDataDir(), 'plugin-claude.json'); }
function claudeSettingsPath() { return path.join(os.homedir(), '.claude', 'settings.json'); }

function summarize(text, max = 120) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

// 把钩子事件映射成信；cfg 为插件配置（已合并默认值）；命中返回 {severity,title,description,sound}，否则 null
function mapEvent(cfg, event) {
  if (!cfg.enabled) return null;
  const type = event.hook_event_name;
  let severity, title, description;
  if (type === 'PermissionRequest') {
    if (!cfg.notifyPermission) return null;
    severity = cfg.permissionSeverity;
    title = 'Claude 需要你的授权';
    description = event.tool_name ? '等待你授权执行工具：' + event.tool_name : 'Claude 正在等待你的授权';
  } else if (type === 'StopFailure') {
    if (!cfg.notifyError) return null;
    severity = cfg.errorSeverity;
    title = 'Claude 报错了';
    description = summarize(event.error_details || event.error, 120) || 'Claude 运行出错';
  } else if (type === 'Stop') {
    if (!cfg.notifyDone) return null;
    severity = cfg.doneSeverity;
    title = 'Claude 已完成回答';
    description = summarize(event.last_assistant_message, 120) || 'Claude 完成了一次回答';
  } else {
    return null;
  }
  return { severity, title, description, sound: 'auto' };
}

// 发信分派：Stop 防抖在此做（插件进程常驻内存）；返回是否真的发了信
function dispatch(cfg, api, lastDoneRef, event) {
  if (event.hook_event_name === 'Stop') {
    const now = Date.now();
    if (now - lastDoneRef.last < cfg.doneDebounceMs) return false;
    lastDoneRef.last = now;
  }
  const letter = mapEvent(cfg, event);
  if (!letter) return false;
  api.letter(letter);
  return true;
}

// 钩子命令：node "<脚本绝对路径（正斜杠）>"
function hookCommand(scriptPath) {
  return 'node "' + path.resolve(scriptPath).replace(/\\/g, '/') + '"';
}

// 把 3 个钩子事件合并进 settings 对象；按命令字符串去重，不删用户已有内容；返回是否改动
function ensureHooks(settings, scriptPath, events) {
  const cmd = hookCommand(scriptPath);
  const hooks = settings.hooks || (settings.hooks = {});
  let changed = false;
  for (const ev of events) {
    const entry = { type: 'command', command: cmd };
    if (ev === 'StopFailure') entry.matcher = '*'; // 匹配所有错误类型
    const list = hooks[ev] || (hooks[ev] = []);
    const exists = list.some(g =>
      (g && g.hooks && g.hooks.some(h => h && h.command === cmd)) ||
      (g && g.command === cmd)
    );
    if (!exists) { list.push({ hooks: [entry] }); changed = true; }
  }
  return changed;
}

// 写入 ~/.claude/settings.json（自动装钩子）；返回 { ok, reason }
function installHooks(scriptPath) {
  const file = claudeSettingsPath();
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { /* 文件不存在按空处理 */ }
  let settings = {};
  if (raw.trim()) {
    try { settings = JSON.parse(raw); }
    catch (e) {
      try { fs.copyFileSync(file, file + '.bak-' + Date.now()); } catch { /* 备份失败忽略 */ }
      return { ok: false, reason: 'settings.json 不是合法 JSON，已备份、跳过自动安装' };
    }
  }
  if (!settings || typeof settings !== 'object') settings = {};
  const changed = ensureHooks(settings, scriptPath, HOOK_EVENTS);
  if (!changed) return { ok: true, reason: '钩子已存在，无需改动' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true, reason: '已写入 ~/.claude/settings.json' };
}

// ---------- 监听器 ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// 启动 127.0.0.1 监听器；端口被占则 +1 重试（上限 20 次）；resolve { server, port, lastDoneRef }
function startListener(initialPort, secret, cfgRef, api, logger) {
  const lastDoneRef = { last: 0 };
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.headers['x-rimletter-claude-secret'] !== secret) { res.writeHead(401); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'POST' || url.pathname !== '/event') { res.writeHead(404); res.end(); return; }
      let event;
      try { event = await readBody(req); } catch { res.writeHead(400); res.end(); return; }
      dispatch(cfgRef.current, api, lastDoneRef, event);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    let port = initialPort;
    const attempt = () => {
      server.once('error', err => {
        if (err.code === 'EADDRINUSE' && port < initialPort + 20) { port++; attempt(); }
        else reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolve({ server, port, lastDoneRef }));
    };
    attempt();
  });
}

// ---------- 钩子模式 ----------

async function hookMain() {
  let input = '';
  try {
    for await (const chunk of process.stdin) input += chunk;
  } catch { process.exit(0); }
  let event = null;
  try { event = JSON.parse(input); } catch { process.exit(0); }
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFilePath(), 'utf-8')); } catch { process.exit(0); } // RimLetter 未运行 → 静默
  try {
    await fetch('http://127.0.0.1:' + state.port + '/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-RimLetter-Claude-Secret': String(state.secret) },
      body: JSON.stringify(event)
    });
  } catch (e) {
    process.stderr.write('[plugin-claude] 转发失败: ' + (e.message || e) + '\n');
  }
  process.exit(0); // 永远退出 0，绝不阻塞 Claude
}

// ---------- 模式分发 ----------

if (require.main === module) {
  // 钩子模式：node 直接运行此文件
  hookMain();
} else {
  // 插件模式：RimLetter require 加载
  module.exports = async ({ api, logger }) => {
    api.registerConfig({
      title: 'Claude Code 对接',
      fields: [
        { key: 'enabled', label: '启用插件', type: 'bool', default: true },
        { key: 'autoInstallHooks', label: '自动安装 Claude 钩子', type: 'bool', default: true },
        { key: 'notifyPermission', label: '授权时发信', type: 'bool', default: true },
        { key: 'notifyError', label: '报错时发信', type: 'bool', default: true },
        { key: 'notifyDone', label: '回答完成发信', type: 'bool', default: true },
        { key: 'permissionSeverity', label: '授权信紧急度', type: 'select', options: SEVERITIES, default: 'ThreatSmall' },
        { key: 'errorSeverity', label: '报错信紧急度', type: 'select', options: SEVERITIES, default: 'NegativeEvent' },
        { key: 'doneSeverity', label: '完成信紧急度', type: 'select', options: SEVERITIES, default: 'PositiveEvent' },
        { key: 'doneDebounceMs', label: '完成信最小间隔', type: 'slider', default: 8000, min: 0, max: 60000, step: 1000, unit: '毫秒' }
      ]
    });

    const cfgRef = { current: api.getConfig() };
    api.on('config', next => { cfgRef.current = next; });

    const secret = crypto.randomBytes(16).toString('hex');
    let server, port;
    try {
      const r = await startListener(DEFAULT_PORT, secret, cfgRef, api, logger);
      server = r.server; port = r.port;
    } catch (e) {
      logger.error('监听器启动失败: ' + (e.message || e));
      return;
    }

    const stateFile = stateFilePath();
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ port, secret }, null, 2));

    if (cfgRef.current.autoInstallHooks) {
      const r = installHooks(__filename);
      logger.info(r.reason);
      if (!r.ok) logger.warn(r.reason);
    }
    logger.info('Claude 监听器已启动 port=' + port);
  };
}

// 供单测导出
module.exports._test = { mapEvent, dispatch, summarize, hookCommand, ensureHooks, installHooks, userDataDir, stateFilePath };
```

- [ ] **Step 2: 运行测试，确认绿**

Run: `cd "D:/claudeswork/official-plugin" && node --test plugin-claude/test/`

Expected: 全部 13 个测试通过（`tests 13 pass`）。

- [ ] **Step 3: 提交**

```bash
cd "D:/claudeswork/official-plugin"
git add plugin-claude/
git commit -m "feat: plugin-claude — Claude Code 三事件转 RimLetter 来信（监听器+钩子+防抖）"
```

---

### Task 3: README 文档

**Files:**
- Create: `D:\claudeswork\official-plugin\plugin-claude\README.md`

- [ ] **Step 1: 写 README**

写 `D:\claudeswork\official-plugin\plugin-claude\README.md`：

````markdown
# plugin-claude — Claude Code 对接插件

RimLetter 与 Claude Code 联动：Claude 需要你授权、报错、或完成一次回答时，屏幕右缘滑入一封 RimWorld 风格的信。

## 效果

| 事件（Claude Code 钩子） | 信标题 | 默认紧急度 |
|---|---|---|
| 需要授权（PermissionRequest） | Claude 需要你的授权 | ThreatSmall |
| 报错（StopFailure） | Claude 报错了 | NegativeEvent |
| 回答结束（Stop，防抖 8s） | Claude 已完成回答 | PositiveEvent |

## 安装

1. 把 `plugin-claude.js` 复制到 `%APPDATA%\rimletter\plugins\`（设置 → 插件管理 →「打开插件目录」直达）。
2. 设置 → 插件管理 → 启用 `plugin-claude`。
3. 插件启动时会自动把 3 条 Claude Code 钩子合并进 `~/.claude/settings.json`（保留原有内容）。可关掉配置里的「自动安装 Claude 钩子」改用手动方式。

## 手动装钩子

不想要自动安装时，在 `~/.claude/settings.json` 的 `hooks` 下加（`<你的用户名>` 换成实际路径）：

```json
"hooks": {
  "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/<你的用户名>/AppData/Roaming/rimletter/plugins/plugin-claude.js\"" }] }],
  "StopFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/Users/<你的用户名>/AppData/Roaming/rimletter/plugins/plugin-claude.js\"" }] }],
  "Stop": [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/<你的用户名>/AppData/Roaming/rimletter/plugins/plugin-claude.js\"" }] }]
}
```

## 配置项（设置 → 插件管理 → plugin-claude → 配置）

| 字段 | 说明 | 默认 |
|---|---|---|
| 启用插件 | 总开关 | 开 |
| 自动安装 Claude 钩子 | 启动时合并钩子到 ~/.claude/settings.json | 开 |
| 授权时发信 / 报错时发信 / 回答完成发信 | 三类事件独立开关 | 全开 |
| 授权信/报错信/完成信紧急度 | ThreatBig / ThreatSmall / NegativeEvent / NeutralEvent / PositiveEvent | ThreatSmall / NegativeEvent / PositiveEvent |
| 完成信最小间隔 | 两次完成信的最短间隔（毫秒） | 8000 |

> 音效恒为各紧急度默认游戏原声；全局静音/音量在 RimLetter 设置里调。

## 工作方式（简要）

- 插件启动 → 在 `127.0.0.1` 开监听端口（17342 起，被占自动 +1）→ 状态写入 `%APPDATA%\rimletter\plugin-claude.json`（端口+随机密钥）。
- 钩子进程（每次事件独立 `node` 进程）读该状态文件，把事件 POST 到监听器后退出 0，绝不阻塞 Claude。
- 插件映射事件→信并 `api.letter()` 播报；回答完成信受防抖限制。

## 卸载

1. 设置 → 插件管理 → 禁用 `plugin-claude`。
2. 需要彻底移除时：删 `~/.claude/settings.json` 里的上述 3 条钩子，删 `%APPDATA%\rimletter\plugin-claude.json` 状态文件。
   （插件禁用后监听器不在，遗留钩子会静默失效、无副作用。）

## 故障排查

- **信不来**：确认 RimLetter 在运行、插件已启用；用 `curl -X POST http://127.0.0.1:17342/event -H "X-RimLetter-Claude-Secret: <密钥>" -d '{"hook_event_name":"Stop","last_assistant_message":"测试"}'` 测监听器（密钥在状态文件里）。
- **钩子不触发**：检查 `~/.claude/settings.json` 里命令路径是否正斜杠、用户名是否正确；改完重启 Claude Code。
- **端口被占**：插件会自动 +1，状态文件里能看到实际端口。

## 支持版本

- RimLetter v0.2.5+
````

- [ ] **Step 2: 提交**

```bash
cd "D:/claudeswork/official-plugin"
git add plugin-claude/README.md
git commit -m "docs: plugin-claude README（安装/配置/钩子/排查）"
```

---

### Task 4: 安装到 RimLetter 并 curl 实测

- [ ] **Step 1: 复制插件到真实插件目录**

```bash
cp "D:/claudeswork/official-plugin/plugin-claude/plugin-claude.js" "$APPDATA/rimletter/plugins/plugin-claude.js"
```

- [ ] **Step 2: 确认 RimLetter 在运行并加载插件**

RimLetter 需正在运行。若未运行：`cd "D:/claudeswork/RIM DESKTOP" && npm start`。然后在设置 → 插件管理确认 `plugin-claude` 已加载（若无，点「重载插件」或重启应用）。

- [ ] **Step 3: 验证状态文件与钩子已自动写入**

- 读 `%APPDATA%\rimletter\plugin-claude.json`，记下 `port` 和 `secret`。
- 读 `~/.claude/settings.json`，确认 `hooks` 下新增了 PermissionRequest / StopFailure / Stop 三条，且原 `env` 等字段完整保留。

- [ ] **Step 4: curl 模拟三类事件**

（`<port>`、`<secret>` 用 Step 3 实际值；Windows 下用 node 发送避免 GBK 乱码）

```bash
node -e "fetch('http://127.0.0.1:<port>/event',{method:'POST',headers:{'Content-Type':'application/json','X-RimLetter-Claude-Secret':'<secret>'},body:JSON.stringify({hook_event_name:'PermissionRequest',tool_name:'Bash'})}).then(r=>console.log(r.status))"
node -e "fetch('http://127.0.0.1:<port>/event',{method:'POST',headers:{'Content-Type':'application/json','X-RimLetter-Claude-Secret':'<secret>'},body:JSON.stringify({hook_event_name:'StopFailure',error:'server_error'})}).then(r=>console.log(r.status))"
node -e "fetch('http://127.0.0.1:<port>/event',{method:'POST',headers:{'Content-Type':'application/json','X-RimLetter-Claude-Secret':'<secret>'},body:JSON.stringify({hook_event_name:'Stop',last_assistant_message:'任务完成'})}).then(r=>console.log(r.status))"
```

Expected: 三行均输出 `200`，屏幕依次滑入 3 封不同紧急度的信。再连发两次 Stop，第二次因防抖应在 8s 内不出信。

---

### Task 5: 真实 Claude Code 钩子验证 + 收尾

- [ ] **Step 1: 真实事件验证**

当前这个 Claude Code 会话已装上 Stop 钩子——**本次回复结束时屏幕应滑入「Claude 已完成回答」信**。同时触发一次需要授权的操作（如一个未经允许的 Bash 命令），确认「Claude 需要你的授权」信滑入。

- [ ] **Step 2: 插件禁用无副作用验证**

设置 → 插件管理 → 禁用 `plugin-claude` → 再发一次 curl 事件：监听器已关，应无信（钩子转发静默失败）。

- [ ] **Step 3: 重新启用**

设置 → 插件管理 → 重新启用，确认监听器恢复、状态文件重写。

- [ ] **Step 4: 提交收尾并推送（需确认）**

```bash
cd "D:/claudeswork/official-plugin"
git add -A
git status   # 确认无残留
```

推送（official-plugin 仓库需带代理，同主仓库）：
```bash
cd "D:/claudeswork/official-plugin"
HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 git push
```

> 推送前向用户确认。

---

## Self-Review 对照

- **spec §3.1 每次回答结束发信 + 防抖** → Task 1/2 的 `dispatch` + `doneDebounceMs`（默认 8000）。
- **spec §3.2 自动+手动钩子** → `installHooks`/`ensureHooks`（Task 2）+ README 手动片段（Task 3）。
- **spec §3.3 插件自建监听器** → `startListener` + `hookMain` 转发（Task 2）。
- **spec §6.3 配置项** → registerConfig 九字段与默认值一一对应。
- **spec §6.4 映射** → `mapEvent` 三类事件 + `sound:'auto'`；防抖在 `dispatch`。
- **spec §8.1 settings.json 合并保留原字段** → `installHooks` 读整文件、只增量 `hooks`（测试 `ensureHooks` 断言 `theme` 保留）。
- **spec §9 错误处理** → 端口递增重试、settings.json 备份跳过、钩子模式吞异常退出 0。
- **spec §10 测试** → `mapEvent`/`dispatch`/`summarize`/`hookCommand`/`ensureHooks` 单测（Task 1）；curl + 真实钩子实测（Task 4/5）。
- **spec §11 README 大纲** → Task 3 覆盖全部小节。
