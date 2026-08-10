# plugin-claude：Claude Code 对接插件 设计文档

> 日期：2026-08-10
> 状态：已确认，待实现
> 发行位置：官方插件仓库 `D:\claudeswork\official-plugin\plugin-claude\`

## 1. 目标

让 RimLetter 在 Claude Code 发生三类事件时从屏幕右缘滑入「信」：

| 事件 | Claude Code 钩子 | 默认紧急度 | 默认标题 |
|---|---|---|---|
| Claude 需要用户授权 | `PermissionRequest` | ThreatSmall | 「Claude 需要你的授权」 |
| Claude 报错 | `StopFailure` | NegativeEvent | 「Claude 报错了」 |
| Claude 回答结束 | `Stop`（防抖） | PositiveEvent | 「Claude 已完成回答」 |

## 2. 背景与关键事实（Claude Code 钩子，2026-08 实测文档）

- `PermissionRequest`：工具需要授权时**可靠**触发；输入含 `tool_name`、`tool_input`。比 `Notification.permission_prompt` 可靠（后者 CLI 有 ~25% 触发率 bug、VS Code 扩展不触发）。
- `StopFailure`：报错时触发；`error` 为错误类别（`rate_limit`/`server_error`/`authentication_failed`/…），另含 `error_details`、`last_assistant_message`。
- `Stop`：**每次回答结束**都触发；输入含 `last_assistant_message`、`stop_hook_active`。不阻塞时不会造成死循环（本设计钩子从不返回阻塞输出、不写 `continue`，故 `stop_hook_active` 可忽略）。
- 钩子在 Windows 上经 Git Bash (MSYS) 执行；命令路径用正斜杠 + 双引号，`$` 会被 bash 展开。
- 钩子数据经 stdin 一行 JSON 传入；stdout（exit 0）用于控制流，本设计一律输出空、退出 0。
- 钩子可在用户级 `~/.claude/settings.json` 注册，全局生效。

## 3. 已确认的设计决策（用户拍板）

1. **任务完成 = 每次回答结束都发信**（`Stop` 钩子），带防抖避免连续对话刷屏。
2. **钩子安装 = 自动 + 手动都提供**：插件加载时可自动合并到 `~/.claude/settings.json`，README 同时提供手动粘贴片段。
3. **事件通道 = 插件自建本地监听器**（方案 A）：
   - 插件进程内跑 `http.createServer` 监听 `127.0.0.1`，映射/防抖/发信全部在插件内用 `api.letter()` 完成。
   - Claude 钩子进程只做「读 stdin 原始事件 → 转发给监听器 → 退出 0」的薄转发。
   - 不依赖 RimLetter 设置里的「API 开关」。

## 4. 交付物与位置

```
D:\claudeswork\official-plugin\plugin-claude\
├── plugin-claude.js    # 单文件插件（双模式）
├── test\claude.test.js # node:test 单测（纯函数 mapEvent 等）
└── README.md           # 安装/配置/手动钩子/故障排查
```

独立 git 仓库（official-plugin，main 分支）提交，遵守仓库目录约定 `plugin-<名字>/`。

## 5. 单文件双模式

用 `require.main === module` 区分运行身份：

- **插件模式**（RimLetter 通过 `require()` 加载）：启动监听器、注册配置、自动装钩子。
- **钩子模式**（Claude 用 `node "<绝对路径>"` 直接运行）：读 stdin → 转发 → 退出 0。

## 6. 插件模式职责

### 6.1 监听器
- `http.createServer`，绑定 `127.0.0.1`，端口自 17342 起，被占用则 +1。
- 校验请求头 `X-RimLetter-Claude-Secret` 与状态文件密钥一致，不一致返回 401。
- 路由：`POST /event` 接收钩子转发的原始事件 JSON。
- 事件经 `mapEvent(config, event)` 映射，命中则 `api.letter(...)`。

### 6.2 状态文件
`%APPDATA%\rimletter\plugin-claude.json`：

```json
{ "port": 17342, "secret": "<crypto.randomBytes(16).toString('hex')>" }
```

- 每次插件加载重写（端口可能因占用而递增）。
- **钩子命令不内嵌端口**：钩子模式每次运行现读状态文件拿当前端口，因此端口变化无需改钩子命令。
- 路径计算：优先 `process.env.APPDATA`，回退 `os.homedir()`；与 config.json 同目录（`%APPDATA%\rimletter`）。钩子模式用同一逻辑，避免依赖 electron。

### 6.3 registerConfig

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | bool | true | 总开关 |
| autoInstallHooks | bool | true | 自动合并钩子到 ~/.claude/settings.json |
| notifyPermission | bool | true | 授权信开关 |
| notifyError | bool | true | 报错信开关 |
| notifyDone | bool | true | 完成信开关 |
| permissionSeverity | select | ThreatSmall | 授权信紧急度 |
| errorSeverity | select | NegativeEvent | 报错信紧急度 |
| doneSeverity | select | PositiveEvent | 完成信紧急度 |
| doneDebounceMs | slider 0–60000 | 8000 | 完成信最小间隔 |

紧急度可选值：ThreatBig / ThreatSmall / NegativeEvent / NeutralEvent / PositiveEvent。

> 说明：不做 per-letter 音效选项。`formatLetter` 对 sound 只有「空/'auto' → 紧急度默认音效」与「其他字符串 → 直接用」两种行为，没有静音哨兵；来信恒传 `sound:'auto'`（各紧急度游戏原声），全局静音/音量由 RimLetter 设置控制。

### 6.4 事件映射（纯函数 `mapEvent(config, event)` → `{severity,title,description,sound} | null`）

- `PermissionRequest`：
  - 标题「Claude 需要你的授权」
  - 描述含工具名：`等待你授权执行工具：<tool_name>`
- `StopFailure`：
  - 标题「Claude 报错了」
  - 描述取 `error_details` 或 `error` 的前 ~120 字摘要
- `Stop`：
  - 标题「Claude 已完成回答」
  - 描述取 `last_assistant_message` 前 ~120 字摘要（去空白折叠）
  - 受 `doneDebounceMs` 防抖：距上一次完成信 < 阈值则返回 null（防抖状态存插件进程内存，跨钩子进程天然成立）

来信恒带 `sound:'auto'`。

任一类型对应 `notifyXxx=false` 或 `enabled=false` → 返回 null。

## 7. 钩子模式职责

1. 读 stdin 一行 JSON（`hook_event_name` 等）。
2. 读状态文件；不存在（RimLetter 未运行）→ 静默退出 0。
3. 带密钥头 POST 原始事件到 `http://127.0.0.1:<port>/event`。
4. 任何异常 → stderr 一行日志 → 退出 0（绝不阻塞 Claude、绝不触发 Stop 死循环）。

## 8. 钩子安装（自动 + 手动）

### 8.1 自动安装
- 插件加载时（`autoInstallHooks=true`）：读 `~/.claude/settings.json`，解析 JSON，确保以下钩子条目存在（按命令字符串去重，不删除用户已有钩子）：

```json
{
  "hooks": {
    "PermissionRequest": [{ "type": "command", "command": "node \"C:/Users/<用户>/AppData/Roaming/rimletter/plugins/plugin-claude.js\"" }],
    "StopFailure": [{ "type": "command", "matcher": "*", "command": "node \".../plugin-claude.js\"" }],
    "Stop": [{ "type": "command", "command": "node \".../plugin-claude.js\"" }]
  }
}
```

- 命令用插件自身 `__filename` 转正斜杠。
- 写前先读原文件，写时合并（保留用户其他 hooks 与 settings 字段）。
- settings.json 非法 JSON → 备份为 `settings.json.bak-<时间戳>`，跳过自动安装，`logger.warn`。
- 停用/卸载：插件不加载 → 监听器不在 → 钩子转发静默失败，无副作用；README 说明如需彻底移除可手动删条目或删备份。
- **实现补充（禁用自检）**：RimLetter 重载时禁用插件不会执行卸载钩子，旧监听器会驻留到应用重启。因此监听器每次收到事件先读 `config.json` 的 `plugins.disabled`，被禁用则 410 拒收并关闭端口；钩子模式转发前也自检，禁用则静默退出 0（不产生 stderr 噪音）。插件名由 `__filename` basename 推导，与配置里的禁用项一致。

### 8.2 手动安装
README 提供上述 JSON 片段 + 说明，用户自行粘贴到 `~/.claude/settings.json` 的 `hooks` 下。

## 9. 错误处理汇总

- 端口被占 → 递增重试（上限 ~20）；状态文件更新；钩子命令不含端口无需更新。
- settings.json 无法解析 → 备份并跳过，不崩溃。
- 插件加载失败 → plugins.js 既有捕获逻辑，`logger.error`。
- 钩子模式所有异常吞掉，退出 0。
- 监听器收到非法请求（缺密钥/坏 JSON）→ 401/400，不影响后续。

## 10. 测试与验证

- **单测**：`mapEvent` 纯函数（三类事件→正确紧急度/标题；`enabled=false`/`notifyXxx=false`→null；防抖阈值→null）。node:test，零依赖（沿用主仓库 `test/` 先例）。
- **实测**：
  - 用 `curl`/node 向监听器 POST 模拟三类事件，看信滑入。
  - 本机真实 Claude Code 触发一次授权、一次报错、一次回答结束，确认三封信。
- **发行验证**：插件文件复制到 `%APPDATA%\rimletter\plugins\` 后正常加载、配置表单出现在 设置→插件管理。

## 11. README 大纲

1. 简介（一张动图/描述）
2. 安装：复制 `plugin-claude.js` 到插件目录 → 设置→插件管理 启用
3. 钩子接入：自动（默认开）或 手动粘贴片段
4. 配置项说明（含紧急度对照表）
5. 卸载与清理
6. 故障排查（钩子不触发 / 不开信 / 端口被占）
7. 支持的 RimLetter 版本：v0.2.5+

## 12. 实现前需验证的技术点

1. `~/.claude/settings.json` 当前钩子 schema 的规范形态（嵌套 `hooks` 数组 vs 扁平）。
2. `StopFailure` 是否必须显式 `matcher`（如 `"*"`）才能匹配所有错误。
3. Windows git-bash 下 `node "C:/path/带空格/script.js"` 命令串的引号与 `$` 转义。
4. 插件内 `require('crypto')`/`require('http')` 等 Node 内置模块可直接用（主进程 CommonJS）。
