# RimLetter「边缘信使」设计文档

- 日期：2026-08-09
- 状态：已确认（含规则管理，待实现）
- 参考游戏：《边缘世界》RimWorld（D:\SteamLibrary\steamapps\common\RimWorld）

## 目标

做一个桌面功能性摆件：**复刻《边缘世界》屏幕右侧的信息播报（Letter 信件系统）**，在硬件占用过高（CPU/内存/磁盘/GPU）时，信从屏幕右缘滑入播报提醒。平时完全隐身，告警才出现。

## 已确认的决策

| 项 | 决定 |
|---|---|
| 技术栈 | Electron（本机 Node v24 / npm 11） |
| 窗口形态 | **全屏透明悬浮层**：透明、无边框、置顶、不进任务栏、鼠标穿透（仅信区域可交互） |
| 呈现 | 平时安静，告警才出现 |
| 监控 | CPU / 内存 / 磁盘 / GPU + **可扩展规则表** |
| 信视觉 | `LetterUnopened` 纹理按紧急度染色（选项 A），图标 64×50 左右 |
| 信文字 | **标题居中于图标中心、允许向两侧溢出**（游戏源码原版行为） |
| 素材 | 全部使用游戏解包原始 UI 纹理 |
| 设置窗口 | 完全参考环世界 UI（深灰蓝窗口 + 米色按钮 + 原版控件） |
| 设置内容 | 常规设置 + **自定义规则/阈值管理**（增删改） |
| 托盘 | 有托盘图标，**单击打开设置**，右键菜单（设置/退出） |
| 音效 | 设置中可自定义：总开关 + 音量 + 每级紧急度可换音效 |
| 外部接口 | 本地 HTTP API（其他程序调用触发播报/管规则）+ 插件系统（手写 JS 逻辑） |

## 游戏参考（反编译自 Assembly-CSharp.dll + Defs）

### LetterStack（播报堆叠）
- 信按钮钉在屏幕右上角：`x = screenWidth - 38 - 12`，垂直堆叠，间距 12
- 超出可容纳高度后折叠为 **Bundle 聚合信**（"+N"）
- 底部界限 `LettersBottomY = 350`

### Letter.DrawButtonAt（单条播报行为）
- **滑入**：到达后 1 秒内从上方 `200px` 外坠落到位，同时透明度 0→1 淡入（`num2 = Time.time - arrivalTime`）
- **径向闪光**：每 `flashInterval` 秒，从信位置扩散一道彩色闪光：大小 `screenWidth × 0.6`，颜色 `flashColor`，亮度 `Pulser.PulseBrightness × 0.55`
- **弹跳**：`bounce=true`（威胁级）时每 5 秒横向抛物线弹跳一次，偏移 `screenWidth × 0.06`
- **文字**：以信图标中心为锚点（`vector2.x = icon.centerX`），文字矩形 = `(centerX - 文字宽/2, 中心Y)`，即**标题居中于图标、向两侧溢出**；`GrayTextBG` 灰底衬在文字后
- **交互**：右键关闭（有 click 音效）、左键打开详情、悬停显示 330px 详情框（`GetMouseoverText`）

### LetterDef 紧急度配色（Defs/Misc/LetterDefs/StandardLetters.xml）
| 紧急度 | 主色 | 闪光色 | 闪间隔 | 弹跳 |
|---|---|---|---|---|
| ThreatBig 重大威胁 | (204,115,115) | (255,85,85) | 6 | ✓ |
| ThreatSmall 威胁 | (204,155,125) | (255,155,95) | 16 | ✓ |
| NegativeEvent 负面 | (204,196,135) | (210,198,106) | 40 | ✗ |
| NeutralEvent 中性 | (175,176,185) | (160,170,180) | 90 | ✗ |
| PositiveEvent 正面 | (120,176,216) | (106,179,231) | 90 | ✗ |

### 窗口/UI 配色（反编译 Widgets.cs）
- 窗口填充 `(21,25,29)`，边框 `(97,108,122)`（注意：窗口不是米色，是深灰蓝）
- 菜单区填充 `(42,43,44)`，边框 `(135,135,135)`
- 选项未选中 `(0.21,0.21,0.21)`，选中 `(0.32,0.28,0.21)`

## 架构

```
┌─────────────────────────────────────────────┐
│  Electron 主进程                              │
│  ├─ main.js      全屏透明窗口 + 托盘 + IPC    │
│  ├─ monitor.js   硬件轮询（systeminformation）│
│  ├─ rules.js     阈值规则引擎（可插拔）        │
│  └─ config.json  用户配置（userData）          │
└──────────────┬──────────────────────────────┘
               │ IPC (告警事件)
┌──────────────▼──────────────────────────────┐
│  渲染层（全屏透明覆盖层）                      │
│  ├─ 信堆栈 + 染色图标 + 居中溢出标题           │
│  ├─ 滑入坠落 / 全屏径向闪光 / 威胁弹跳         │
│  ├─ 悬停详情 / 左键打开 / 右键关闭             │
│  └─ 设置窗口（环世界 UI）                      │
└─────────────────────────────────────────────┘
```

监控与阈值判断放主进程（渲染层隐身时仍持续运行）；渲染层只画播报。

## 规则引擎

一条规则 = `传感器 + 指标 + 比较符 + 阈值 + 持续时长 + 紧急度 + 标题 + 描述 + 音效 + 启用`

```json
{
  "id": "builtin-cpu",
  "sensor": "cpu", "metric": "load",
  "operator": ">", "threshold": 85,
  "durationMs": 5000,
  "severity": "ThreatBig",
  "label": "CPU 占用过高",
  "description": "CPU 已持续 85% 以上超过 5 秒",
  "sound": "LetterArrive_BadUrgentBig",
  "enabled": true
}
```

内置规则（默认值，可编辑）：
| 传感器 | 条件 | 紧急度 |
|---|---|---|
| CPU 占用 | > 85% 持续 5s | ThreatBig |
| GPU 温度 | > 85°C 持续 5s | ThreatSmall |
| GPU 占用 | > 95% | ThreatSmall |
| 内存占用 | > 90% 持续 10s | NegativeEvent |
| 磁盘剩余（各盘） | < 10GB | NeutralEvent |
| 任一指标回落 | 恢复至阈值下 | PositiveEvent（恢复正常） |

状态机（每条规则）：`idle → alerting → recovered`。同源去重（不刷屏）；恢复时发一封"恢复正常"蓝信。持续时长判定避免瞬时尖峰误报。

传感器可扩展：新增传感器类型后，规则下拉自动出现新选项（预留网络/电池/进程）。

## 播报视觉规格

- 信图标：`LetterUnopened` 按紧急度染色，显示尺寸 ~64×50（可配置）
- 位置：右上角（`x = 屏宽 - 图标宽 - 30`），垂直堆叠间距 ~30，超 6 封折叠为聚合信
- 滑入：1s 内从上方 200px 坠落 + 淡入
- 全屏径向闪光：每 flashInterval 秒从信位置扩散，大小 `屏宽 × 0.6`，flashColor
- 弹跳：威胁级每 5s 横向抛物线弹跳
- 标题：居中于图标中心，向两侧溢出，`GrayTextBG` 灰底
- 悬停：300~330px 详情框（当前值/阈值/已持续）
- 左键打开详情、右键关闭（click 音效）
- 自动消失：默认 20s 无交互淡出；恢复类信 10s（可配置）

## 设置窗口（环世界 UI）

三个页签：
1. **⚙ 常规设置**：各传感器开关+阈值、轮询间隔滑块、自动消失时长滑块、音效（开关/音量/每级音效选择）
2. **📜 告警规则**：规则列表（启停/编辑/删除）、＋添加规则（传感器/指标/比较符/阈值/持续时长/紧急度/标题/描述/音效）、恢复默认
3. **🧩 插件管理**：已装插件列表（名称/描述/版本/启用开关/错误状态）、按钮（重新加载插件 / 打开插件目录 / 新建插件模板）、每插件错误信息展示

底部：测试播报 / 恢复默认 / 确定。

UI 元素全部用解包纹理：`ButtonBG(+Click/Mouseover)` 米色按钮、`GrayTextBG` 文字底、`CheckOn/Off/Partial` 复选框、`RadioButOn/Off` 单选、`SliderRail/SliderHandle` 滑块、`FloatMenuOptionBG`、窗口配色 (21,25,29)/(97,108,122)。

入口：托盘单击打开设置窗口。

## 素材提取管线

`scripts/extract_assets.py`（Python + UnityPy，一次性）：
- 从游戏 `.assets` 按名称清单提取纹理 → `assets/raw/`（PNG）
- 已提取 78 张：LetterUnopened、按钮、复选框、滑块、单选、闪光特效、警告图标、语义图标（备用）
- 音效：尝试从资源包提取 `LetterArrive*`（NVorbis/ogg）→ `assets/sounds/`；失败则静音降级

## 音效

- 默认用游戏原声（若提取成功）；Chromium 支持 .ogg 播放
- 设置中每级紧急度可选：游戏默认 / 关闭 / 本地音频文件
- 音量滑块（0~100%）

## 外部接口与插件扩展

两个扩展点，方便其他程序调用 + 允许手写代码逻辑。

### 1. 本地 HTTP API（给其他程序调用）
主进程起一个仅绑定 `127.0.0.1` 的 HTTP 服务（端口可配置，默认 `17301`）。请求需带 token（`X-RimLetter-Token`，token 在 config.json 里生成/可改）。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 存活检查（返回版本号） |
| POST | `/letter` | **触发一封播报**：`{severity, title, description, sound?}` |
| GET | `/state` | 当前各传感器实时值 + 活动告警 |
| GET | `/rules` | 读取全部规则 |
| POST | `/rules` | 新增规则 |
| PUT | `/rules/:id` | 修改规则 |
| DELETE | `/rules/:id` | 删除规则 |
| POST | `/reload` | 重载 config + 插件 |

示例（任何程序）：
```bash
curl -X POST http://127.0.0.1:17301/letter \
  -H "X-RimLetter-Token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"severity":"ThreatSmall","title":"构建完成","description":"CI 构建产物已生成"}'
```

### 2. 插件系统（允许手写代码逻辑）
`plugins/` 目录，每个插件一个 `.js` 文件（CommonJS）。主进程加载，注入受限但够用的 API；插件错误被捕获并上报，不崩溃应用。

```js
// plugins/my-plugin.js
module.exports = async ({ api, logger }) => {
  // 注册自定义传感器（指标会出现在规则引擎的下拉里）
  api.registerSensor('myApp', async () => ({ value: 42 }))

  // 注册一条规则（与内置规则同构）
  api.registerRule({
    sensor: 'myApp', metric: 'value', operator: '>',
    threshold: 40, durationMs: 3000,
    severity: 'NegativeEvent', label: '我的应用超载', description: '...'
  })

  // 直接触发一封播报
  api.letter({ severity: 'PositiveEvent', title: '你好', description: '插件主动播报' })

  // 订阅事件 / 读取状态 / 定时任务
  api.on('alert', a => logger.info('告警：' + a.label))
  const s = await api.getState()
  api.setInterval(async () => { /* 自定义轮询逻辑 */ }, 2000)
}
```

**插件 API**（注入到每个插件）：
- `api.registerSensor(name, fn)` — 注册自定义传感器（fn 异步返回 `{value}` 或 `{value, unit}`）
- `api.registerRule(rule)` — 注册规则（结构同内置规则）
- `api.letter({severity, title, description, sound})` — 主动触发播报
- `api.on(event, handler)` — 事件订阅（`alert` / `recovered` / `rule`）
- `api.getState()` — 读取当前全部传感器值
- `api.setInterval(fn, ms)` — 安全定时器（应用退出自动清理）
- `logger` — 日志（带插件名前缀，进主日志文件）

插件加载时机：启动时 + `POST /reload`。插件崩溃只影响该插件自身，RimLetter 主体不退出。

### 3. 为什么这样设计
- **HTTP API**：任何语言/任何程序（脚本、CI、监控系统、自动化工具）都能触发播报，无需 Electron 依赖
- **插件系统**：硬监控之外的"手写逻辑"（读进程、跑脚本、轮询自定义源）都有落点，且与规则引擎天然打通（注册的传感器能进规则下拉）
- 两者都走主进程，与渲染层解耦；渲染层只负责画信

## 验证方案

1. `npm start` → 全屏透明窗口正常、鼠标穿透正常
2. 设置窗「测试播报」逐一触发 5 种紧急度信：染色/滑入/闪光/弹跳/文字居中
3. 临时把阈值调低触发真实告警 → 去重 + 恢复播报
4. 悬停/左键/右键交互、自动消失
5. 规则管理：增删改规则、持久化到 config.json、重启生效
6. GPU 温度读不到时优雅降级不报错
7. 托盘：单击开设置、右键菜单
8. 外部 API：curl 触发 `/letter` 播报正常、token 鉴权生效、`/state` 返回实时值、规则 CRUD 生效
9. 插件：放置一个示例插件，注册自定义传感器+规则+主动播报，验证 `registerRule` 的规则出现在设置窗口、插件报错不影响主体

## 项目记录

完成后在工作目录写 `CLAUDE.md` 记录本项目上下文、游戏参考发现、约定（用户明确要求）。
