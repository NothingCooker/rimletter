# plugin-weather-plus：天气 Plus（中国大陆精准版）设计文档

> 日期：2026-08-17
> 状态：已实现
> 发行位置：官方插件仓库 `D:\claudeswork\official-plugin\plugin-weather-plus\`，市场 id `weather-plus`

## 1. 目标

RimLetter 官方插件「天气 Plus」：对中国大陆天气**更精准**的天气信。数据源改用**和风天气 QWeather**（中国气象局 CMA 数据），替代 `plugin-weather`（wttr.in / Open-Meteo 全球模型，大陆精度一般、无官方预警、无空气质量）。免费，接受 API Key。

## 2. 数据源调研结论（2026-08-17 实测）

| 数据源 | 免 key | 中文城市名解析 | 官方预警 | AQI | 大陆精度 | 结论 |
|---|---|---|---|---|---|---|
| wttr.in | ✅ | ✅（易错解） | ❌ | ❌ | 一般（全球模型） | 旧插件在用 |
| Open-Meteo | ✅ | ❌（只认经纬度） | ❌ | ❌ | 一般 | — |
| **QWeather 和风天气** | **✅ 免费（每月前 5 万次）** | ✅ | ✅ | ✅ | **最高（CMA 数据）** | **采用** |

- 免费额度（2025-03-01 新定价）：天气预报 / GeoAPI / 分钟预报 / 预警 / 天气指数 / 空气质量同属「天气和环境」组，**0–5 万次/月 CNY 0**。本插件默认 30 分钟轮询 ≈ 200 次/天 ≈ 6 千次/月，远低于限额。
- **⚠️ 公有域名已停服**（2025-06-15 公告）：`devapi.qweather.com` 2026-01-01 停、`api.qweather.com` / `geoapi.qweather.com` 2026-06-01 停。实测返回 403/404。**必须使用账号专属 API Host**（控制台 → 设置，形如 `abc.def.qweatherapi.com`），GeoAPI 路径为 `<API Host>/geo/v2/city/lookup`（原 `/v2/` 改为 `/geo/v2/`）。
- 鉴权：请求头 `X-QW-Api-Key`（传统 API Key 认证；JWT 为 2027 年后方向，本插件不用）。
- 业务成功码是字符串 `'200'`（HTTP 200 ≠ 业务成功），必须在解析层校验 `json.code`。

## 3. 接口与数据流

```
tick（api.setInterval，默认 30 分钟）
  ├─ 禁用自检（config.json plugins.disabled → clearInterval 自退）
  ├─ 配置检查（API Key / API Host 缺失 → 每轮仅提醒一次）
  ├─ getLocation：城市 → LocationID
  │    ├─ 缓存命中（本地文件，按 city+adm 键）→ 直接使用
  │    └─ 未命中 → GeoAPI lookup（中文名/经纬度）→ 缓存
  ├─ 四路并行 fetchAll：
  │    /v7/weather/now   实时（必需，失败整轮跳过）
  │    /v7/weather/3d    今日最高/最低（容错）
  │    /v7/warning/now   气象台预警（容错，非中国城市无数据）
  │    /v7/air/now       空气质量 AQI（容错）
  └─ evaluate(prevState, current, now, cfg) → letters[] → api.letter 逐个发
```

城市写法三种，`classifyLocation` 判定：
- **LocationID**（纯数字 ≥6 位如 `101010100`，或全大写字母数字 ≥8 位如 `WMIBW3XH5UF6`）→ 直通，零网络
- **经纬度**（含逗号 `39.9,116.4`）→ GeoAPI 解析为最近城市
- **城市名**（中文/拼音）→ GeoAPI 解析（`range=cn`），可选 `adm` 省级行政区消歧（朝阳 vs 朝阳区）

## 4. 六类触发（纯函数 `evaluate`，全部可独立开关 + 可配紧急度）

| # | 触发 | 默认紧急度 | 说明 |
|---|---|---|---|
| 1 | 天气状况变化 | NeutralEvent | QWeather 中文实况文字变化（晴/多云/小雨…），描述 `旧 → 新（当前 T°C）` |
| 2 | 气温骤变 | NegativeEvent | `\|Δtemp\| ≥ 温差阈值`（默认 5°C），描述含升降向与 Δ |
| 3 | 每日简报 | NeutralEvent | 首个 ≥ 简报时点（默认 7 点）的轮询发一封；描述 = 天气 + 最高/最低 + AQI + 生效预警数；按本地日期防重 |
| 4 | 气象台预警 | 按颜色映射 | **红→ThreatBig、橙→ThreatSmall、黄→NegativeEvent、蓝→NeutralEvent**，无颜色回退配置值；按签发 id 去重（持久化，重启不重复），新签发（新 id）再来信 |
| 5 | 高温/严寒 | ThreatBig | `temp ≥ 高温阈值`（35）或 `≤ 严寒阈值`（-5），锁存式防刷 |
| 6 | 空气质量超标 | NegativeEvent | `AQI ≥ 阈值`（默认 150，轻度污染及以上），锁存式防刷 |

首次轮询只建基线不发信；**生效中的气象台预警例外**（安装即告知，按 id 去重）。锁存：触发一次后回落至阈值以下才重置，避免阈值附近抖动刷屏（沿用 plugin-weather 的 lastSevereNotified 思路）。

## 5. 配置表单（registerConfig，24 字段）

`enabled` / `apiKey` / `apiHost` / `city` / `adm`（可选消歧）/ `checkIntervalMinutes`（15–180，默认 30）/ 状况信（开关+紧急度）/ 骤变信（开关+温差阈值+紧急度）/ 简报信（开关+时点+紧急度）/ 预警信（开关+回退紧急度）/ 高温严寒（开关+双阈值+紧急度）/ 空气信（开关+AQI阈值+紧急度）/ `test` 按钮（registerAction，旧版无 API 时守卫不加）。

## 6. 传感器（规则引擎集成）

注册 `weather-plus`：`temp` / `feelsLike` / `humidity` / `windSpeed` / `precip` / `aqi` / `warningCount`。
**读数来自插件轮询缓存**（`state.last`），传感器 read 不发起网络请求——否则规则引擎 2s 轮询会把免费配额打爆（每天 4 万+ 次）。传感器只被「已启用且引用它的规则」轮询（monitor 按需读取），无规则引用时零开销。

## 7. 状态与持久化

- `%APPDATA%\rimletter\plugin-weather-plus.json`：`{ locationCache: {city, adm, location, name}, warningSeen: [] }`
  - locationCache：GeoAPI 结果缓存（重启免重复请求）
  - warningSeen：已通知预警 id（上限 100，重启不重复预警）
- 评估状态（weather/temp/latches/简报日期）存插件进程内存（`global.__rimletterWeatherPlus` 注册表，跨重载保留）；重启后首轮重建基线（可接受，沿用 plugin-weather 先例）

## 8. 错误处理

- 网络失败：logger.warn，本轮跳过下轮重试，不发信
- 业务码非 200：同上；`401/403`（Key 无效/无权）→ 每会话只发一封「天气 Plus 配置错误」中性信提示检查
- 缺 API Key / API Host / 城市：跳过轮询 + 日志；缺 Key/Host 每会话只提醒一次
- 预警/空气接口失败（海外城市等）：`fetchQwSafe` 容错降级，不影响实时天气主链路
- 轮询间隔非法值回退 30 分钟（防 NaN 疯狂轮询）

## 9. 测试（30 用例，node:test + node:assert/strict）

- 解析：parseNow/parseDaily/parseWarnings/parseAir/buildCurrent（业务码非 200、结构不符、字段归一）
- 城市：classifyLocation（id/经纬度/名称/空）、normalizeHost（剥协议/路径）、resolveLocation（LocationID 零网络、GeoAPI 取首条、失败抛错）
- 网络：fetchQw（URL 构造 + X-QW-Api-Key 头、HTTP 非 200 抛错）、fetchQwSafe（失败返 null）、fetchAll（四路并行）
- 触发：六类各自命中/边界/防刷/去重、预警颜色映射、简报防重与 AQI/预警数附注、禁用不发信、首次建基线、warningSeen 上限

## 10. 验证

- ✅ `node --test test/weather-plus.test.js` 30/30 通过
- ✅ stub api 冒烟加载：注册 24 字段配置表单 + test 动作 + weather-plus 传感器，缺 Key 时优雅降级不崩溃
- ⏳ 真机验证（需用户提供免费 Key/API Host）：测试按钮 → 轮询 → 各类型来信

## 11. 发行

- `plugin-weather-plus/`（js + test + README）入官方插件仓库，plugins.json 新增 `weather-plus` 条目（v1.0.0）
- README 注明：需免费 API Key + API Host（2026 起公有域名停服）、支持 RimLetter v0.2.6+
- 与 `plugin-weather`（wttr.in 免 Key）并存：天气 Plus 追求大陆精度，旧插件作免 Key 备选
