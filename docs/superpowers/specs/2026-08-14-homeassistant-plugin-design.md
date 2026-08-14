# Home Assistant 集成插件（测试版）设计文档

> 日期：2026-08-14
> 状态：已确认（用户拍板）
> 目标版本：核心 v0.6.0（含 `api.host`）；HA 插件首发（Beta，欢迎反馈 bug）
> 范围：**接收 HA 通知**（rest_command 推送→信）+ **HA 实体进规则引擎**；不做上报

## 背景

RimLetter 目前只能监控本机 CPU/内存/磁盘/GPU。用户希望接入 Home Assistant（家庭自动化平台）：

1. **接收通知**：HA 自动化把通知推给 RimLetter，滑入屏幕右侧显示成环世界风格的信。
2. **实体监控**：HA 传感器实体接入现有规则引擎，达到阈值触发告警信。

HA 部署形态不确定（可能同机、也可能局域网另一台设备），**两种都要支持**。

## 用户确认的关键决策

| 决策 | 结论 |
|---|---|
| 接收通知机制 | HA rest_command 推送（非轮询 persistent_notification） |
| HA 实体→规则 | 进规则编辑器（复用现有规则引擎），不做插件内阈值 |
| 上报本机数据到 HA | 不做（本期砍掉） |
| 入站方案 | 复用现有 `/letter`；核心只加 `api.host` 可配绑定地址（用户接受局域网暴露管理 API 的风险） |
| 插件形态 | 官方插件仓库（`NothingCooker/rimletter-official-plugins`），走插件市场安装 |
| 版本标注 | HA 插件标注「测试版 / Beta」，欢迎反馈 bug |

## 架构

### ① 核心改动：`api.host` 可配绑定地址

- `DEFAULT_CONFIG.api` 新增 `host: '127.0.0.1'`（默认值不变，现有行为与安全面完全一致；deepMerge 自然合并，无需迁移逻辑）
- `src/main/api.js`：`start(p)` 改为 `start(p, host = '127.0.0.1')`，`server.listen(p, host, cb)`
- `src/main/main.js`：`apiServer.start(config.api.port, config.api.host)`
- **设置页**：常规 tab 新增「API 绑定地址」文本输入行（默认 `127.0.0.1`），旁注：改为 `0.0.0.0` 时局域网内其它设备可带 token 访问管理 API（token 为明文 HTTP）；**重启生效**
- 用途：HA 在局域网另一台设备时，用户改 `api.host=0.0.0.0`，HA 用 RimLetter PC 的局域网 IP 调 `/letter`

**附带防御（小改动）**：`src/main/letters.js` 的 `formatLetter` 对未知 severity 回退 `NeutralEvent`（当前 `LETTERDEFS[severity]` 未命中会抛错，HA payload 传错 severity 时接口返回 400）。加回退后，错误的 severity 也优雅降级，不报错。

### ② HA 插件（官方仓库 `NothingCooker/rimletter-official-plugins`）

**插件定位**：`registerConfig` 声明配置表单 + `registerSensor` 注册实体传感器 + `registerAction` 提供按钮。**纯函数拆分**便于单测。

#### 配置字段（schema，字段类型均属现有 text/number/bool/button）

| key | 类型 | 标签 | 默认 | 说明 |
|---|---|---|---|---|
| `haUrl` | text | HA 地址 | `http://127.0.0.1:8123` | 同机或局域网 IP |
| `token` | text | HA 长期令牌 | 空 | Long-Lived Access Token，设置→长期访问令牌生成 |
| `watchEntities` | text | 监控实体 | 空 | 逗号分隔的实体 ID，如 `sensor.temperature,sensor.humidity` |
| `pollIntervalSec` | number | 刷新间隔(秒) | 15 | min 5，max 300 |
| `verifySsl` | bool | 校验 SSL | true | HA 用自签 https 时关闭 |
| `rimLetterUrl` | text | RimLetter 推送地址 | `http://127.0.0.1:17301` | 生成 rest_command YAML 用 |
| `rimLetterToken` | text | RimLetter API token | 空 | 留空则 YAML 用 `!secret` 占位 |
| `test_connection` | button | 测试连接 | — | `GET /api/` 显示 HA 版本 + `GET /api/states` 显示实体数 |
| `copy_rest_command` | button | 复制 rest_command YAML | — | 用 `rimLetterUrl`/`rimLetterToken` 生成可直接粘贴 HA 的模板 |

#### 接收通知：复用 `/letter` + rest_command 模板

- 不新增入站端口，HA 自动化经 rest_command POST 到 `{rimLetterUrl}/letter`，头带 `x-rimletter-token`（同机 `127.0.0.1`；局域网需 `api.host=0.0.0.0` + 防火墙放行）
- 插件提供 `buildRestCommandYaml({ url, token })` 纯函数生成模板：

```yaml
# HA 侧：加进 configuration.yaml 的 rest_command 段后重启，再在自动化里调用：
#   rest_command.rimletter_notify(title='...', message='...', severity='ThreatSmall')
rest_command:
  rimletter_notify:
    url: "http://127.0.0.1:17301/letter"
    method: POST
    content_type: "application/json"
    headers:
      x-rimletter-token: "<token>   # 填 rimLetterToken 配置值；留空则生成 !secret rimletter_token
    payload: >-
      {"severity": "{{ severity | default('NeutralEvent') }}",
       "title": "{{ title }}",
       "description": "{{ message | default('') }}"}
```

- 文档提醒：`severity` 必须为五种之一（`ThreatBig/ThreatSmall/NegativeEvent/NeutralEvent/PositiveEvent`），传错接口 400（配合 ① 的 formatLetter 回退，不会崩）

#### HA 实体 → 传感器

- **轮询缓存**：插件自己 `setInterval(pollIntervalSec*1000)` 拉取，不阻塞 monitor 的 2s 轮询。`read()` 只读缓存、不发 HTTP
  - 拉取：`GET {haUrl}/api/states`，头 `Authorization: Bearer {token}`，按 `watchEntities` 集合过滤
  - `verifySsl=false` 时禁用 TLS 证书校验（实现选 undici dispatcher `{ connect: { rejectUnauthorized: false } }` 或 `https.request`，单测注入 mock fetch 覆盖）
  - 缓存项：`entityId → { value, ts }`；拉取失败保留旧缓存；**超过 3×pollIntervalSec 无成功刷新则视为断连，传感器返回 undefined**
- **注册传感器**：每个实体一个 `registerSensor('ha_' + sanitize(entityId), async () => ({ value }))`（只回 `value`，不带 `unit` —— 避免设置页把 `unit` 误列为可配指标）
  - `sanitize`：保留 `[A-Za-z0-9_]`、其余转 `_` 并小写；如 `sensor.living_room_temperature` → `ha_living_room_temperature`（`ha_` 前缀与内置 cpu/mem/disk/gpu 不冲突）
- **数值转换** `entityToValue(st)`（纯函数）：
  - `state === 'on'` → 1；`'off'` → 0
  - `state` 为数字 → 原值
  - 数字字符串 → `Number`（非有限 → undefined）
  - 其它 → undefined
- **与规则引擎衔接**：设置→规则编辑器直接选 `ha_xxx` 传感器、`value` 指标，配阈值/紧急度/持续/回落 —— 完全复用现有引擎
  - **断连语义**（依赖 `rules.js` 现状）：传感器返回 undefined → `extractValues` 得空数组 → 未告警时静默、已告警时**保持告警不误判恢复**（空数据 ≠ 已恢复）。HA 恢复且数值回落才发恢复信 —— 安全、不刷屏
- HA 拉取失败：该轮跳过、日志**节流**（同一错误 60s 最多记一次），不刷日志

### ③ 纯函数拆分（可单测）

| 函数 | 职责 |
|---|---|
| `sanitize(entityId)` | 实体 ID → 传感器名后缀 |
| `entityToValue(stateObj)` | HA state 对象 → 数值 |
| `buildRestCommandYaml({ url, token })` | 生成 rest_command YAML 模板 |
| `fetchHaStates({ fetch, haUrl, token, verifySsl })` | 拉全量 states 并按 watchEntities 过滤；`fetch` 注入 |

## 错误处理

- HA 地址错 / token 无效 / 证书自签：拉取失败 → 保留旧缓存 → 规则按断连语义处理；日志节流
- `verifySsl=false` 的禁用校验只对该插件的 HA 请求生效，不影响核心其它网络
- `rimLetterUrl` 配错：rest_command 推送不到 → HA 侧报错，插件 README 排查指引（检查 api.host、防火墙、token）
- formatLetter 未知 severity 回退 NeutralEvent（核心防御）

## 测试计划

- 核心 `test/`：
  - `api.test.js` 补充：`start(0, '127.0.0.1')` 可启动并健康检查通过；host 参数传入 `listen`（0.0.0.0 绑定不在单测验证连通性，只验证启动不抛错）
  - `letters.test.js` 补充：未知 severity → 回退 NeutralEvent（tintFile/sound 用 NeutralEvent 定义）
  - 现有测试保持通过
- 插件侧（官方仓库）：注入 mock fetch，单测 `sanitize` / `entityToValue` / `buildRestCommandYaml` / `fetchHaStates`（过滤、失败返回、token 头、verifySsl 分支）

## 测试版标注与反馈

- 插件名/配置表单标题：**「Home Assistant 集成（测试版）」**
- 插件 README 顶部醒目标注：**测试版，功能与边界仍在验证，欢迎反馈 bug**
- 反馈渠道：GitHub Issues —— `https://github.com/NothingCooker/rimletter-official-plugins/issues`（README + plugins.json 市场 description 均写）
- 核心 release notes 提及新插件为测试版

## 非目标（YAGNI）

- 不做上报本机数据到 HA（方向 3，本期砍掉）
- 不做 HA WebSocket/SSE 实时订阅（用轮询即可）
- 不做 MQTT
- 不做核心 webhook 能力（本期复用 `/letter`；webhook 列入后续「推送平台插件」时再评估）
- 不做 HA 实体复杂属性映射（v1 只用 `entity.state`；需取属性值的场景用 HA 侧 template sensor 转成带状态的新实体）
