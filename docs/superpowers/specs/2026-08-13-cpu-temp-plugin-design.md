# CPU 测温官方插件 + 插件传感器链路修复（v0.3.1）

> 日期：2026-08-13 · 状态：已批准设计 · 关联：[[2026-08-13-plugin-marketplace-and-update-accelerator-design]]

## 1. 背景与目标

新增「CPU 温度监控」功能，作为**官方插件**发布到插件市场（`NothingCooker/rimletter-official-plugins`）。

用户已拍板两个决策：
1. **温度数据源 = 仅 LibreHardwareMonitor（LHM）**。Windows 桌面机无系统原生 CPU 温度接口（已实测 `Get-CimInstance MSAcpi_ThermalZoneTemperature` 返回「不支持」），必须借助外部工具；不做 ACPI 回退，逻辑最简。
2. **修主程序 + 发 v0.3.1**。检测到 v0.3.0 插件传感器链路是坏的，需修复后再发插件，否则插件规则永不触发。

## 2. 已确认的事实（探索阶段实证）

| 事实 | 证据 |
|---|---|
| 插件 `registerSensor` 的传感器**不会被 monitor 轮询** | `sensors.js` 的 `snapshot()` 内部 `map` 硬编码仅含 cpu/mem/disk/gpu；插件传感器被 `getSensors()` 合并到返回对象但 `snapshot()` 读不到。实测 `snapshot(['clock'])` 返回 `{}` |
| 规则编辑器下拉**硬编码** cpu/mem/disk/gpu | `settings.js` 的 `SENSOR_METRICS` 只含 4 个内置传感器；插件传感器不显示，也无法手建自定义规则 |
| `/state` API 与 `api.getState()` 不含插件传感器 | 两者都调 `getSensors().snapshot()`（无 keys → `BASE_SENSORS`），插件传感器被丢弃 |
| 本机 ACPI 热区查询不可用 | `Get-CimInstance MSAcpi_ThermalZoneTemperature` → 「不支持」（桌面机典型） |
| LHM Web API 的 `data.json` 结构已从源码确认 | 嵌套 Children 树；CPU 硬件节点 `ImageURL === "images_icon/cpu.png"`、`HardwareId` 如 `/intelcpu/0`；温度传感器 `Type === "Temperature"`，带 `RawValue`（invariant culture 数值，无需解析区域小数点）、`Value`（格式化字符串含单位） |
| 插件 API 已具备全部所需能力 | `registerSensor` / `registerRule` / `registerConfig`（含 button）/ `registerAction` / `getConfig` / `on('config')`；**无需扩展插件 API** |
| preload 已暴露 `getState()` | 渲染层规则下拉增强可直接复用，无需新增 IPC |

## 3. 主程序修复（v0.3.1）

### 3.1 sensors.js — snapshot 派发内置 + 插件传感器

`createSensors({ si, execFile, extraSensors })`：
- `extraSensors` 为可选函数，返回 `{ name → { read } }` 映射（主程序传 `() => registry.sensors`）。
- `snapshot(keys)` 把内置传感器与 `extraSensors()` 合并成派发表；未知传感器（map 缺键）安全返回 `undefined`。
- `keys == null`（全量路径：设置页 / `/state` / `api.getState()`）也包含插件传感器。
- 保持纯函数、依赖注入，可单测。

### 3.2 main.js — 接线（一行）

`createSensors({ si, execFile: execFileAsync, extraSensors: () => registry.sensors })`。

### 3.3 settings.js — 规则编辑器下拉含插件传感器

- 打开规则编辑器时（或设置页加载时）调 `rimletter.getState()`，取其返回的传感器键。
- 内置 4 个之外的键 = 插件传感器，追加进「传感器」下拉。
- 指标选项从该传感器快照对象的**数值标量键**推断（排除数组如 `cores`）；无数值数据时仍显示传感器名但无指标（规则引擎安全跳过）。
- 若某插件传感器当前未取到数据，`Object.keys` 仍会列出其键（如 `temp`/`maxCore`），即使值 undefined——下拉仍有指标可选。

### 3.4 测试

`test/` 新增：
- `createSensors({..., extraSensors})`：插件传感器被轮询（snapshot 返回其值）。
- 未知传感器 → `undefined`，不抛错。
- 全量路径（无 keys）含插件传感器。
- 现有 101 个测试不回归。

## 4. 官方插件 `plugin-cpu-temp`（独立仓库）

### 4.1 文件结构

```
plugin-cpu-temp/
├── plugin-cpu-temp.js     # 插件主体（导出 async ({api,logger}) => {}）
├── README.md              # 安装/配置/LHM 指引/故障排查
└── test/
    └── cpu-temp.test.js   # node:test 单测（fixture 驱动 parseLhm）
```

`plugins.json` 追加：
```json
{ "id": "cpu-temp", "name": "CPU 温度信", "desc": "CPU 温度/最高核心过高来信（需运行 LibreHardwareMonitor）", "author": "NothingCooker", "file": "plugin-cpu-temp/plugin-cpu-temp.js", "version": "1.0.0" }
```

### 4.2 数据源与解析

- 轮询 `http://127.0.0.1:{port}/data.json`（默认 8085），`fetch` + `AbortSignal.timeout(3000)`，失败不抛到规则引擎。
- `parseLhm(json)`（纯函数，可测）：
  1. 递归遍历 Children 树。
  2. 定位 CPU 硬件节点：`ImageURL === "images_icon/cpu.png"`（主判据）或 `HardwareId` 含 `cpu`。
  3. 收集该节点下 `Type === "Temperature"` 的传感器，用 `RawValue`（number 且有限），缺失时回退解析 `Value` 字符串（剥单位、兼容逗号小数点）。
  4. 映射：
     - `temp` — 传感器名含 `Package` / `Tctl` / `Tdie` 的值；无则取第一个温度传感器。
     - `maxCore` — 名字匹配 `/^Core #\d+/` 的传感器最大值。
     - `cores` — 上述逐核数组。
     - `count` — 找到的温度传感器总数（供「测试」按钮排查）。
  5. 结构不符 / LHM 未运行 → 返回 `null`。
- 实现期需用**真实 data.json fixture** 校准（用户跑一次 LHM 导出，或抓 LHM 仓库/社区样例）；「测试读取温度」按钮可实时验证。

### 4.3 传感器与规则

- `api.registerSensor('cpu-temp', read)`：read 返回 `{ temp, maxCore, cores }`；取不到时各项 `undefined`（规则引擎 `extractValues` 跳过，不误报）。首次连接失败 `logger.warn` 一条。
- 默认规则（`api.registerRule`，按 id 去重，随配置变化重注册）：
  | id | sensor | metric | 比较 | 阈值 | durationMs | severity | label |
  |---|---|---|---|---|---|---|---|
  | `plugin-cpu-temp-high` | cpu-temp | temp | > | 85 | 5000 | ThreatSmall | CPU 温度过高 |
  | `plugin-cpu-temp-core` | cpu-temp | maxCore | > | 90 | 5000 | ThreatSmall | CPU 核心过热 |
- 规则 `enabled` 由配置表单的来信开关控制。

### 4.4 配置表单

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | bool | true | 插件总开关 |
| port | number | 8085 | LHM Remote Web Server 端口 |
| notifyTemp | bool | true | CPU 封装温度来信 |
| tempThreshold | number | 85 | 封装温度阈值 °C（min 40 max 110） |
| tempSeverity | select | ThreatSmall | 封装温度信紧急度 |
| notifyCore | bool | true | 最高核心来信 |
| coreThreshold | number | 90 | 最高核心阈值 °C（min 40 max 110） |
| coreSeverity | select | ThreatSmall | 核心信紧急度 |
| durationSec | number | 5 | 持续时长（秒），对齐内置规则 |
| test | button | — | 「测试读取温度」→ 回显当前 temp/maxCore/传感器数/连接来源，排查 LHM 未运行 |

`api.on('config', next => 重注册规则)`。

### 4.5 README 要点

- **需 RimLetter v0.3.1+**（插件传感器链路修复所在版本）。
- LHM 安装：GitHub 下载 LibreHardwareMonitor 便携版 → 解压运行 → Options → 勾选 **Remote web server**（默认端口 8085）→ **需常驻后台**，退出 RimLetter 仍要开（与 nvidia-smi 类似，属外部依赖）。
- 配置表 + 紧急度说明。
- 故障排查：不来信 → ① 插件已启用 ② LHM 是否在跑 ③ 「测试读取温度」按钮看是否连上；端口被占可改。
- 数据源与免责：LHM 是开源免费软件。

## 5. 发布

1. **主仓库**：bump `0.3.1` → commit（**不加 Co-Authored-By**）→ push → `git tag v0.3.1` → push tag（CI 构建）→ `gh release edit v0.3.1 --repo NothingCooker/rimletter --draft=false --notes "..."`（gh 需带 HTTPS_PROXY）。
2. **official-plugins 仓库**：新增 `plugin-cpu-temp/`、更新 `plugins.json` → commit → push（jsDelivr 自动刷新，市场可装）。
3. 主仓库 README/CLAUDE.md 补一句新官方插件说明。

## 6. 不在范围内（YAGNI）

- ACPI 回退数据源（用户已拍板仅 LHM）。
- 无需扩展插件 API / 新增 IPC。
- 不做 CPU 温度历史曲线 / 日志。
- 不触碰 GPU 传感器逻辑（既有 nvidia-smi 路径不动）。
