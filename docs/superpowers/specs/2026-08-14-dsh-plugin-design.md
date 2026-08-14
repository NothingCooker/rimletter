# plugin-dsh：DeepSeek Harness（dsh）对接插件 设计文档

> 日期：2026-08-14
> 状态：已确认，待实现
> 发行位置：官方插件仓库 `D:\claudeswork\official-plugin\plugin-dsh\`

## 1. 目标

让 RimLetter 在 dsh（DeepSeek Harness，`dsh web`）发生三类事件时从屏幕右缘滑入「信」：

| 事件 | dsh 事件流 | 默认紧急度 | 默认标题 |
|---|---|---|---|
| dsh 需要用户授权 | mux `approval/requested` | ThreatSmall | 「dsh 需要你的授权」 |
| dsh 报错 | mux `turn/end`(kind=error) + host `host/agent-error` | NegativeEvent | 「dsh 报错」 |
| dsh 回答完成 | mux `turn/end`(kind=completed)（防抖） | PositiveEvent | 「dsh 完成回答」 |

## 2. 背景与关键事实（dsh 事件流，2026-08 源码验证）

dsh 是 DeepSeek AI 的开源 agent harness，基于 Cordis，`dsh web` 起 Web UI（默认 `http://127.0.0.1:3080`）。其 Web 前端与 host 之间的实时事件通道，对本地进程**免鉴权**开放（loopback trust fence）：

- `GET /api/events.mux` — 全会话聚合 SSE 流：`session/event`（携带 turn/start、turn/end、tool/call 等原始 session 事件）、`approval/requested`/`approval/resolved`、`question/requested`、`stream/error` 等。
- `GET /api/events.host` — host 级 SSE 流：`host/session-status`（running 翻转）、`host/agent-error`（无 turn 定位的实时失败）、`host/session-added/removed` 等。
- 帧包络：`data: {"type":"server-request","rpcId":"<uuid>","method":"<帧类型>","payload":{...}}`，每帧一行 `data:`；打开时发一行 `: connected` 注释行。
- 连接即回放各会话仍挂起的 `approval/requested` 帧（重连后可恢复「等待授权」状态）。
- 免鉴权依据：`packages/client/connection/src/api-request-trust.ts`，Host 头为 loopback 即通过；无 Origin 也通过。默认绑定 `127.0.0.1:3080`（`dsh web` 拒绝 `--host 0.0.0.0`）。
- **turn/end 原因种类**：`completed` / `aborted` / `blocked` / `error`（携带 `error: LlmFailure`）/ `max-tokens` / `interrupted`。
- **turn/end 不携带 `last_assistant_message`**（区别于 Claude Code 的 Stop 钩子），故完成信描述用固定文案，不取消息摘要。
- dsh 的钩子桥（`dsh-hooks-claude-code`/`-codex`）**不支持** `PermissionRequest`/`StopFailure`/`Notification` 等事件，故 Claude 插件的钩子路径不适用于 dsh；SSE 事件流是 dsh 原生对外实时通道。

## 3. 已确认的设计决策（用户拍板）

1. **对接方式 = SSE 直连（方案 A）**：插件作为 sidecar 连 dsh 的 mux + host 两条 SSE 流，单组件、不改 dsh 配置、免鉴权。用户已确认平时以 `dsh web` 运行。
2. **事件集 = 授权信 + 完成信 + 报错信**；开始/提问信不做。
3. **发信恒带 `sound:'auto'`**（沿用 plugin-claude 约定，各紧急度游戏原声；全局静音/音量由 RimLetter 设置控制）。
4. **纯通知**：不做「从信里应答授权」（RimLetter 信无按钮，与 plugin-claude 一致）。

## 4. 交付物与位置

```
D:\claudeswork\official-plugin\plugin-dsh\
├── plugin-dsh.js    # 单文件插件（纯 sidecar）
├── test\dsh.test.js # node:test 单测（纯函数 mapFrame 等）
└── README.md        # 安装/前提/配置/故障排查
```

独立 git 仓库（official-plugin，main 分支）提交，遵守目录约定 `plugin-<名字>/`；更新根目录 `plugins.json` 上架插件市场。

## 5. 架构：SSE 直连 sidecar

与 plugin-claude 不同：Claude 插件「收事件」（钩子转发进监听器），dsh 插件「连事件流」（直接读 dsh 的 SSE）。因此**没有钩子模式、没有监听器、没有状态文件**——RimLetter `require()` 加载即插即用。

```
dsh web (127.0.0.1:3080)  ──SSE──▶  plugin-dsh.js  ──api.letter()──▶  RimLetter
```

## 6. 连接生命周期

- **首次连接**：RimLetter 加载插件后对 mux + host 各发起一次 `fetch(url, { signal })`，逐行读取 SSE `data:` 帧。失败（dsh 未运行 / 端口未开）→ 不崩溃，进入重试。
- **未连接重试**：每 5s 重连一次，直到连上。
- **断开重连**：SSE 正常结束或异常（`stream/error`、网络断）→ 指数退避重连：5s → 10s → 20s → 30s 封顶，连上后重置为 5s。
- **配置变更**：`api.on('config')` 时，若 host/port 变化则关闭现有连接并按新地址重连；enabled=false 则关闭连接并停止一切发信。
- **重连后状态恢复**：mux 流打开时 dsh 会回放仍挂起的 `approval/requested` 帧，因此 dsh 侧「等待授权」在插件重连后仍能补发。

## 7. 事件映射（纯函数 `mapFrame(cfg, frame)` → `{severity,title,description,sound} | null`）

帧输入为解析后的 SSE 帧对象 `{type:'server-request', method, payload}`；`cfg` 为插件配置（已合并默认值）。

| method | payload | 条件 | 信 |
|---|---|---|---|
| `approval/requested` | `{sessionId, approvalId, toolName, reason?}` | `cfg.notifyApproval` | 授权信：标题「dsh 需要你的授权」；描述 `等待你授权执行工具：<toolName>`，reason 存在则追加 `（<reason>）` |
| `session/event` | `{sessionId, event:{type:'turn/end', data:{turn, reason}}}` | `cfg.notifyDone` 且 `reason.kind==='completed'` | 完成信：标题「dsh 完成回答」；描述「dsh 完成一次回答」；受 `doneDebounceMs` 防抖 |
| `session/event` | 同上 | `cfg.notifyError` 且 `reason.kind==='error'` | 报错信：标题「dsh 报错」；描述取 `reason.error.message` 或 `reason.error.code` 前 ~120 字摘要 |
| `host/agent-error` | `{sessionId, message}` | `cfg.notifyError` | 报错信：标题「dsh 报错」；描述取 `message` 前 ~120 字摘要 |
| 其他 | — | — | `null` |

规则：

- 任一 `notifyXxx=false` 或 `cfg.enabled=false` → 返回 null。
- turn/end 的 `aborted`/`blocked`/`max-tokens`/`interrupted` 等其他 kind → 返回 null（不发信）。
- 完成信防抖：距上一次完成信 < `doneDebounceMs` → 返回 null（防抖状态存插件进程内存）。
- `stream/error` 帧 → 不映射为信，由连接层 `logger.warn`。
- 来信恒带 `sound:'auto'`。

## 8. registerConfig

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | bool | true | 总开关 |
| host | text | 127.0.0.1 | dsh web 地址 |
| port | number | 3080 | dsh web 端口 |
| notifyApproval | bool | true | 授权信开关 |
| notifyDone | bool | true | 完成信开关 |
| notifyError | bool | true | 报错信开关 |
| approvalSeverity | select | ThreatSmall | 授权信紧急度 |
| doneSeverity | select | PositiveEvent | 完成信紧急度 |
| errorSeverity | select | NegativeEvent | 报错信紧急度 |
| doneDebounceMs | slider 0–60000 | 8000 | 完成信最小间隔 |

紧急度可选值：ThreatBig / ThreatSmall / NegativeEvent / NeutralEvent / PositiveEvent。

## 9. 错误处理汇总

- dsh 未运行 / 端口未开 → fetch 失败，静默进重试，不崩溃。
- SSE 中途断开 / `stream/error` → `logger.warn` 一行，指数退避重连。
- host/port 配置非法（如非数字端口）→ 用默认值兜底，`logger.warn`。
- 帧 JSON 解析失败 → 跳过该帧（`logger.warn` 一行），不影响连接。
- 插件加载失败 → plugins.js 既有捕获逻辑，`logger.error`。

## 10. 测试与验证

- **单测**：`test/dsh.test.js`，node:test 零依赖（沿用主仓库 `test/` 与官方插件先例）。覆盖 `mapFrame` 纯函数：
  - `approval/requested` → 授权信，正确紧急度/标题/描述（含 reason）。
  - `session/event` turn/end completed → 完成信；error → 报错信（描述取 message/code 摘要）。
  - `host/agent-error` → 报错信。
  - `enabled=false` / `notifyXxx=false` → null。
  - turn/end 其他 kind（aborted 等）→ null。
  - completed 防抖（两次间隔 < 阈值 → 第二次 null）。
- **实测**：
  - 跑 `dsh web`，插件加载后确认两条 SSE 连接建立；向 dsh 发一次任务触发 turn 开始/结束，看完成信。
  - 在 dsh 里触发一次授权（如工具需要确认），看授权信。
  - 构造一次报错，看报错信。
  - 关闭 dsh web，确认插件静默重试、不崩溃；重启 dsh 后恢复。
- **发行验证**：插件文件复制到 `%APPDATA%\rimletter\plugins\` 后正常加载，配置表单出现在 设置→插件管理。

## 11. README 大纲

1. 简介（一张动图/描述）
2. 前提：先运行 `dsh web`（`http://127.0.0.1:3080`）
3. 安装：复制 `plugin-dsh.js` 到插件目录 → 设置→插件管理 启用
4. 配置项说明（含紧急度对照表）
5. 卸载与清理
6. 故障排查（dsh 未运行自动重连 / 收不到信 / 端口被占）
7. 支持的 RimLetter 版本：v0.2.5+

## 12. 实现前需验证的技术点

1. mux/host SSE 的 `data:` 帧解析方式（Node 20+ `fetch` 返回 body 为 ReadableStream，逐行读需按 `\n\n` 分帧或逐块 split；确认主流 Node 版本可用 `ReadableStream` + 手动 split）。
2. Node 内置 `fetch`/`AbortSignal.timeout` 在 RimLetter 主进程（Electron，Node 20/24）可用性（plugin-claude 已用 `fetch`，确认可行）。
3. mux 流回放挂起 `approval/requested` 的确切行为（连接打开后首帧即为回放帧，防抖/去重逻辑不受影响）。
4. 插件内用 `require('node:fetch')` 之外的方案（直接全局 `fetch`），避免新增依赖。
