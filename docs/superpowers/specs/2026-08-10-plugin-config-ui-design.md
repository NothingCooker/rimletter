# RimLetter 插件配置界面设计文档

- 日期：2026-08-10
- 状态：已确认（声明式表单 + 插件页签内展开 + 5 种字段类型）
- 依赖：现有插件系统（`src/main/plugins.js` + `makePluginApi`）+ 设置窗口插件管理页签

## 目标

让插件可以**声明自己的配置表单**，用户在设置窗口的「插件管理」页签里可视化配置插件；配置持久化到 config.json，并实时通知插件。插件开发无需写 HTML。

## 已确认决策

| 项 | 决定 |
|---|---|
| 机制 | **声明式表单**（不引入 iframe / 自定义 HTML） |
| 位置 | 「插件管理」页签内展开（复用规则编辑器 `rw-editor` 展开模式） |
| 字段类型 | `text` / `number` / `bool` / `select` / `slider` 共 5 种 |
| 存储 | `config.json` 新增 `pluginConfig: { [插件名]: { key: value } }` |
| 命名空间 | 插件只能读写自己名字下的键 |
| 提交方式 | 表单底部「保存」统一提交（slider 拖动实时显示数值、点保存才生效） |

## 字段 Schema

每个字段统一结构：`{ key, label, type, default, ...类型专属 }`

| type | 渲染控件 | 额外属性 | 说明 |
|---|---|---|---|
| `text` | `rw-input` 文本框 | `placeholder?` | 任意字符串（API Key、路径、文案） |
| `number` | `rw-input` 数字输入 | `min?` `max?` `step?` | 带范围约束的数字 |
| `bool` | `rw-cb` 复选框 | — | 开关 |
| `select` | `rw-select` 下拉 | `options: [{value,label}]` | 枚举单选 |
| `slider` | `rw-slider` 滑杆 + 实时数值 | `min` `max` `step?` `unit?` | 有范围的连续值 |

示例：

```js
api.registerConfig({
  title: '深夜提醒设置',                    // 可选，默认插件名
  fields: [
    { key: 'hour',    label: '提醒小时', type: 'number', default: 23, min: 0, max: 23 },
    { key: 'enabled', label: '启用提醒', type: 'bool',   default: true },
    { key: 'mode',    label: '提醒方式', type: 'select',
      options: [{ value: 'letter', label: '播报信' }, { value: 'tray', label: '托盘提示' }],
      default: 'letter' },
    { key: 'note',    label: '附加说明', type: 'text', default: '', placeholder: '选填' },
    { key: 'cpuLimit', label: 'CPU 阈值', type: 'slider', default: 85, min: 0, max: 100, step: 1, unit: '%' }
  ]
});
```

## 插件 API 扩展

注入每个插件的 `api` 新增三个能力：

1. **`api.registerConfig(schema)`** — 声明配置表单（在 `load` 里调用一次）。校验失败抛错（被加载器捕获，错误显示在插件列表，不崩溃应用）。
2. **`api.getConfig()`** — 返回当前插件配置：schema 默认值 ∪ `config.pluginConfig[插件名]` 合并后的对象，只含 schema 声明的键（过滤脏数据）。同步返回。
3. **`api.on('config', handler)`** — 配置变更回调，handler 收到新的配置对象。把现有空实现 `on() {}` 升级为真正的事件总线（`config` 事件实际触发；`alert`/`recovered`/`rule` 事件暂不实现，保持注册但不触发）。

**api 绑定插件名**：`loadPlugins` 的 `apiFactory` 需接收 `name` 参数返回该插件的专属 api（`main.js` 现传 `() => pluginApi` 忽略名字，需改为 `(name) => makePluginApiFor(name)`）。

## 配置存储

- `DEFAULT_CONFIG` 新增 `pluginConfig: {}`（`deepMerge` 天然支持嵌套）。
- 值只存 schema 声明的键；`setConfig` 时用 `normalizeConfig(schema, values)` 做类型归一（number/slider → Number 并 clamp 到 min/max、bool → Boolean、text → String、select → 校验在 options 内，非法回退 default），缺键填 default。
- 纯逻辑 `normalizeConfig` 放 `src/main/plugins.js` 导出（可单测）。

## 主进程流转（src/main/main.js）

- `reloadEverything()` 重置 `registry` 时新增两项：`pluginConfigs: {}`、`pluginConfigHandlers: {}`。
- `makePluginApiFor(name)` 返回名字绑定的 api：
  - `registerConfig(schema)` → 校验 → 存 `registry.pluginConfigs[name]`
  - `getConfig()` → 调 `getPluginConfig(name)`（见下）
  - `on(evt, cb)` → 存 `registry.pluginConfigHandlers[name][evt]`；`config` 变更时调用对应 handlers
  - `registerRule(r)` → 改为**按 id upsert**（同 id 覆盖，不再 push 重复），使插件可在 `on('config')` 里安全重注册规则
- 工具函数：
  - `getPluginConfig(name)` → schema 默认值 ∪ 存储值合并（返回 null 若插件无 schema）
  - `setPluginConfig(name, values)` → `normalizeConfig` → 写 `config.pluginConfig[name]` → `saveConfig` → 触发该插件 `on('config')` handlers（逐个 try/catch，单插件报错不影响主体）→ `send('config:changed', config)` → 返回 `{ok, values}`
- IPC：
  - `plugins:list` 扩展：每项附加 `configSchema`（无则 null）与 `configValues`（`getPluginConfig` 结果）
  - 新增 `plugins:setConfig(name, values)` → 调 `setPluginConfig`，无 schema 返回 `{ok:false, error}`

## 渲染层（src/renderer/settings.js）

- 插件列表每行：有 `configSchema` 的插件多一个「配置」按钮 → 点击在列表下方 `#plug-config` 容器展开表单（复用 `rw-editor` 展开模式 + `rw-row`/`rw-lbl`/`rw-input`/`rw-select`/`rw-cb`/`rw-slider`）。
- 表单由 schema 渲染：
  - `text` → `rw-input`（带 placeholder）
  - `number` → `rw-input type=number`（min/max/step）
  - `bool` → `rw-cb` 开关
  - `select` → `rw-select` + options
  - `slider` → `rw-slider`（thumb 按当前值定位）+ 右侧实时数值标签（带 unit）
- 表单值保存在本地 `pluginFormValues` 对象（由 `configValues` 初始化）。滑块拖动更新本地值 + 标签，不立即持久化。
- 底部「保存」→ `plugins:setConfig(name, values)` → 成功收起表单并刷新列表；「取消」收起。
- 滑块绑定：现有 `bindSliders(scope)` 只绑全局 `config` 且拖动即 `persistConfig()`，插件表单需要**本地 values 对象 + 保存才提交**，故新增一个插件表单专用的滑块绑定（复用 `rw-slider` 标记与 mousedown 拖动逻辑，写入本地对象）。
- 插件提供的 `title`/`label`/选项 label 全部 `esc()` 转义；`contextIsolation` 保持开启，无 HTML 注入面。

## 示例插件更新（plugins/example.js）

- 演示 `registerConfig` + `getConfig` + `on('config')`：把深夜提醒做成可配置（小时、启停、文案、紧急度）。
- 用 `on('config')` 在配置变化时按新值重注册规则（利用 `registerRule` 的 id 去重，不会累积）。

## 测试

扩展 `test/plugins.test.js`（必要时新开 `test/pluginconfig.test.js`）：
- `registerConfig` 记录 schema；`getConfig` 返回默认值合并结果
- `normalizeConfig`：各类型归一（number clamp、bool、select 非法值回退、缺键填默认、剔除 schema 外键）
- `setPluginConfig` 持久化到 config 对象并触发 `on('config')` 回调（handler 抛错不影响其他）
- `registerRule` 同 id upsert 去重
- 既有 50 个测试保持全绿（`npm test`）

## 验证方案

1. `npm test` 全绿。
2. `npm start` → 设置 → 插件管理：example 插件行出现「配置」按钮。
3. 点击展开表单，5 种字段类型控件渲染正确（滑块实时数值、bool 开关、select 下拉）。
4. 修改某字段 → 保存 → config.json 的 `pluginConfig.example` 更新；重启应用后配置保留。
5. 插件 `on('config')` 回调触发，深夜提醒规则阈值随配置变化（在插件管理里能看到规则联动）。
6. 恶意/异常 schema 的插件加载失败，错误显示在列表，应用不崩溃。

## 不做（YAGNI）

- iframe / 自定义 HTML 配置界面
- `color`、`list`/`object` 嵌套字段类型
- 每插件独立子页签
- `on('alert'/'recovered'/'rule')` 事件实现（现有空实现，不在本任务范围）
