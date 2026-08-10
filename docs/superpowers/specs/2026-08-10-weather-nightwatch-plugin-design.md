# plugin-weather + plugin-night-watch：环境事件信 与 深夜提醒 设计文档

> 日期：2026-08-10
> 状态：已确认，待实现
> 发行位置：官方插件仓库 `D:\claudeswork\official-plugin\plugin-weather\` 与 `D:\claudeswork\official-plugin\plugin-night-watch\`

## 1. 目标

两个独立的 RimLetter 官方插件，把「环境事件」与「作息提醒」装进 RimWorld 风味的信里：

1. **plugin-weather 环境事件信**：轮询天气，天气状况变化 / 气温骤变 / 每日简报 / 恶劣天气预警 四类事件来信，像游戏里的环境事件播报。
2. **plugin-night-watch 深夜提醒**：每晚固定时点来一封「夜深了」红信，提醒休息，不重复。

两个插件相互独立，各占 `plugin-<名>/` 子目录，沿用 plugin-claude 的结构：单文件 `.js` + `test/` 纯函数单测 + README。

## 2. 天气数据源调研结论（2026-08-10 实测）

| 数据源 | 免 key | 城市名查询 | 中文 | 实测可达 | 结论 |
|---|---|---|---|---|---|
| wttr.in | ✅ | ✅ | ❌（`?lang=zh` 实测无效，返回英文） | ✅ 直连 1.8s | **采用** |
| Open-Meteo | ✅ | ❌（只认经纬度） | — | ✅ 直连 2.7s | 备选 |
| 和风天气 QWeather | ❌ | ✅ | ✅ | — | 需 key，弃用 |

**采用 wttr.in**：单次请求 `https://wttr.in/<city>?format=j1` 同时返回当前天气（`current_condition[0]`：`temp_C`/`weatherDesc`/`humidity`/`windspeedKmph`）、今日最高最低（`weather[0].maxtempC/mintempC`）、当日 3 小时间隔的逐小时数据（`weather[0].hourly`）、解析到的城市（`nearest_area[0]`）。城市名查询最省事，覆盖全部 4 类触发。

> 中文描述接口 `?lang=zh` 实测不生效（`lang_zh` 仍返回英文）。天气词由插件自己映射成 RimWorld 风味中文，更可控，见 §3.2。

## 3. plugin-weather 设计

### 3.1 职责与数据流

插件加载 → `setInterval` 每 `checkIntervalMinutes` 轮询一次 → 拉取 wttr.in → 与内存中的上次状态比对 → 命中任一触发则 `api.letter()`。首次轮询只建基线不发信。

### 3.2 天气词映射（英文 weatherDesc → RimWorld 风味中文）

| weatherDesc（wttr.in） | 中文 | 恶劣集 |
|---|---|---|
| Sunny / Clear | 晴朗 | |
| Partly cloudy | 多云 | |
| Overcast / Cloudy | 阴 | |
| Mist | 薄雾 | |
| Fog | 浓雾 | ✅ |
| Light drizzle / Light rain | 小雨 | |
| Rain / Moderate rain | 降雨 | |
| Heavy rain | 暴雨 | ✅ |
| Sleet | 雨夹雪 | |
| Freezing rain | 冻雨 | ✅ |
| Light snow | 小雪 | |
| Snow | 降雪 | |
| Heavy snow | 大雪 | ✅ |
| Blizzard | 暴风雪 | ✅ |
| Thundery outbreaks / Thunderstorm | 雷暴 | ✅ |
| Hail | 冰雹 | ✅ |

未知词 → 原样保留英文。映射表为纯函数 `mapWeather(desc)`。

### 3.3 四类触发（纯函数 `evaluate(state, current, cfg)` → `{severity,title,description,sound} | null`）

`state` 为内存中上次轮询快照，`current` 为本次解析结果，`cfg` 为插件配置（已合并默认值）：

1. **状况变化**（`notifyConditionChange`）：`current.weather` !== `state.weather` → 来信。
   - 默认 NeutralEvent，标题「天气变化」，描述 `{旧中文} → {新中文}（当前 {temp}°C）`。
2. **温度骤变**（`notifyTempSwing`）：`|current.temp - state.temp| >= tempSwingThreshold` → 来信。
   - 默认 NegativeEvent，标题「气温骤{升/降}」，描述 `较上次检测{上升/下降} {Δ}°C（当前 {temp}°C）`。
3. **每日简报**（`notifyDailyBriefing`）：当前小时 === `briefingHour` 且 `lastBriefingDate` !== 今天 → 来信。
   - 默认 NeutralEvent，标题「今日天气」，描述 `{今日中文}，{max}°C / {min}°C`。
4. **恶劣预警**（`notifySevere`）：`current.weather` 命中恶劣集，或 `temp >= heatThreshold`（默认 35°C），或 `temp <= freezeThreshold`（默认 -5°C）→ 来信。
   - 默认 ThreatBig，标题「恶劣天气来袭」，描述 `{中文}（当前 {temp}°C）`。**每条 tick 只发一次**（`lastSevereNotified` 标记，恢复常态后重置，避免连续预警刷屏）。

任一类型对应开关为 false / 插件 `enabled=false` → 返回 null。来信恒带 `sound:'auto'`（沿用 plugin-claude 约定）。

### 3.4 配置表单（registerConfig）

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | bool | true | 总开关 |
| city | text | '' | 城市名或坐标（如 `Beijing` / `上海` / `39.9,116.4`），留空不轮询 |
| checkIntervalMinutes | slider 15–180 | 30 | 轮询间隔（分钟） |
| notifyConditionChange | bool | true | 状况变化来信 |
| conditionChangeSeverity | select | NeutralEvent | 状况信紧急度 |
| notifyTempSwing | bool | true | 温度骤变来信 |
| tempSwingThreshold | number | 5 | 温差阈值（°C） |
| tempSwingSeverity | select | NegativeEvent | 骤变信紧急度 |
| notifyDailyBriefing | bool | true | 每日简报来信 |
| briefingHour | number 0–23 | 7 | 简报时点（时） |
| briefingSeverity | select | NeutralEvent | 简报信紧急度 |
| notifySevere | bool | true | 恶劣天气来信 |
| heatThreshold | number | 35 | 高温预警阈值（°C） |
| freezeThreshold | number | -5 | 严寒预警阈值（°C） |
| severeSeverity | select | ThreatBig | 恶劣信紧急度 |

紧急度可选值：ThreatBig / ThreatSmall / NegativeEvent / NeutralEvent / PositiveEvent。

### 3.5 状态与防重

- 状态存**插件进程内存**（`stateRef`：上次 weather/temp/lastBriefingDate/lastSevereNotified）。应用重启后首轮只建基线不发信，可接受。
- 每日简报 / 恶劣预警的「今日已发」防重也存内存：重启后若已过简报时点会补发一封，可接受（应用常驻后台，重启罕见）。

### 3.6 禁用自检（防定时器泄漏）

`api.setInterval` 返回裸 `setInterval`，RimLetter `reloadEverything()` 不清除插件定时器——插件被禁用→重载后旧定时器会残留继续跑。因此每次轮询回调先读 `config.json` 的 `plugins.disabled`，命中则 `clearInterval` 自退并返回（沿用 plugin-claude 的禁用自检思路）。插件名由 `__filename` basename 推导。

### 3.7 错误处理

- 网络失败（离线/超时）：`logger.warn`，本轮跳过，下轮重试，不发信。
- 城市解析失败（wttr.in 返回无有效天气）：`logger.warn`，同上。
- 轮询间隔取配置后需重建定时器（`checkIntervalMinutes` 变更时）：用 `clearInterval + setInterval` 重建，避免旧间隔残留（`api.on('config')` 里处理）。

## 4. plugin-night-watch 设计

### 4.1 职责与数据流

定时器每 30 秒检查一次当前时间；`HH:MM` 命中配置时点（`remindHour:remindMinute`）且今日未发 → 来信并记 `lastSentDate`。

### 4.2 时点命中（纯函数 `shouldSend(state, now, cfg)` → boolean）

- `cfg.enabled` 为 true；
- `now.getHours() === cfg.remindHour && now.getMinutes() === cfg.remindMinute`（宽松判定：命中分钟即触发，避免秒级抖动漏发）；
- `state.lastSentDate` !== 今天的 `YYYY-MM-DD`。

三者满足才发。信：标题「夜深了」，描述 `{cfg.message}（现在是 {HH:MM}）`，严重度 `cfg.severity`（默认 ThreatBig），`sound:'auto'`。

### 4.3 配置表单

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | bool | true | 总开关 |
| remindHour | number 0–23 | 23 | 提醒时点（时） |
| remindMinute | number 0–59 | 30 | 提醒时点（分） |
| severity | select | ThreatBig | 信紧急度 |
| message | text | 夜深了，殖民者需要休息 | 信描述文案 |

### 4.4 状态持久化

`lastSentDate` 写小状态文件 `%APPDATA%\rimletter\plugin-night-watch.json`（`{ "lastSentDate": "2026-08-10" }`）。否则应用在 23:45 重启会再补发一封。路径计算复用 plugin-claude 的 `userDataDir()` 逻辑（优先 `process.env.APPDATA`，回退 `os.homedir()`，不用 electron）。

### 4.5 禁用自检

同 §3.6：每次 tick 先读 `plugins.disabled`，命中则 `clearInterval` 自退。

## 5. 共通约定

```
official-plugin/
├── plugin-weather/
│   ├── plugin-weather.js      # 单文件插件
│   ├── test/weather.test.js   # node:test 纯函数单测（mapWeather / evaluate / 时点命中等）
│   └── README.md              # 安装/配置/触发说明/故障排查
└── plugin-night-watch/
    ├── plugin-night-watch.js
    ├── test/nightwatch.test.js
    └── README.md
```

- 单文件 CommonJS，导出 `async ({ api, logger }) => {}`；`module.exports._test` 导出纯函数供单测（沿用 plugin-claude 模式）。
- 纯函数全部零依赖；测试用 `node:test` + `node:assert/strict`（沿用主仓库 `test/` 与 plugin-claude 先例）。
- README 注明支持 RimLetter v0.2.5+。
- 独立 git 仓库（official-plugin，main 分支）提交，遵守仓库 `plugin-<名字>/` 目录约定。

## 6. 实现前需验证的技术点

1. wttr.in 对城市名「上海」等中文输入的解析行为；城市不存在的返回形态（HTTP 状态 vs 空 `weather`）。
2. wttr.in `format=j1` 的 `weather[0]` 是否恒为「今天」（按 wttr.in 本地时区），简报日期防重以 wttr.in 返回的 date 还是本地日期为准。
3. `api.on('config')` 里重建定时器的最小可行实现（避免 config 变更时旧定时器残留）。
4. 插件内 `require('node:fs')` 等内置模块在主进程 CommonJS 环境可直接用（plugin-claude 已验证）。

## 7. 测试与验证

- **单测**：
  - weather：`mapWeather` 映射表；`evaluate` 四类触发（命中/开关关/禁用→null；温度骤变阈值边界；简报防重；恶劣防刷）。
  - night-watch：`shouldSend` 时点命中/未命中/今日已发/禁用；状态文件读写。
- **实测**：
  - 复制到 `%APPDATA%\rimletter\plugins\` 后正常加载、配置表单出现在 设置→插件管理。
  - weather：真实城市轮询一轮看基线；手动改天气词/温差看信滑入；简报时点调近看简报信。
  - night-watch：把 remindHour:Minute 调到下一两分钟内，等信滑入；重启应用验证不补发。
- **发行验证**：两插件文件复制到插件目录后正常加载，README 安装步骤可执行。

## 8. README 大纲（各自）

1. 简介（一句话 + 触发示例）
2. 安装：复制 `.js` 到插件目录 → 设置→插件管理 启用
3. 配置项说明（含紧急度对照表 / 天气词对照）
4. 卸载与清理
5. 故障排查（不来信 / 城市解析失败 / 网络）
6. 支持的 RimLetter 版本：v0.2.5+
