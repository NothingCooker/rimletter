# 插件市场 + 自动更新加速通道 设计

日期：2026-08-13
状态：已确认

## 1. 目标

1. **插件市场**：在设置窗「插件管理」页签内浏览官方插件仓库的插件，一键安装 / 卸载 / 更新，取代手动复制 `.js` 到插件目录的流程。
2. **访问加速**：插件市场走 **jsDelivr CDN**（首选）→ `raw.githubusercontent.com`（回退）；自动更新先走 **gh-proxy 前缀加速通道**（`gh.ddlc.top` → `ghproxy.net`），全部失败再走原生 GitHub。

加速通道来源：README 已注明 `gh.ddlc.top` 为公益镜像、失效时替换为 `ghproxy.net`。用户确认：插件市场用 jsDelivr，自动更新用 gh-proxy 前缀（组合方案）。

## 2. 数据与配置

### 2.1 config.json 新增

`src/main/config.js` 的 `DEFAULT_CONFIG`：

```js
update: { enabled: true, proxyChannels: ['https://gh.ddlc.top', 'https://ghproxy.net'] },
market: { repo: 'NothingCooker/rimletter-official-plugins', branch: 'main' }
```

- `update.proxyChannels`：自动更新加速前缀列表，按顺序尝试，最后回退原生。可在设置 / 直接改 config.json 调整。
- `market.repo` / `market.branch`：插件市场来源，默认官方插件仓库。

### 2.2 官方插件仓库新增 `plugins.json`

仓库根目录清单（jsDelivr 可直接拉取）：

```json
{
  "version": 1,
  "plugins": [
    { "id": "weather", "name": "天气信", "desc": "天气变化/气温骤变/每日简报/恶劣预警", "author": "NothingCooker", "file": "plugin-weather/plugin-weather.js", "version": "1.0.0" },
    { "id": "night-watch", "name": "深夜提醒", "desc": "每晚固定时点一封「夜深了」红信", "author": "NothingCooker", "file": "plugin-night-watch/plugin-night-watch.js", "version": "1.0.0" },
    { "id": "claude", "name": "Claude Code 对接", "desc": "授权/报错/回答完成来信", "author": "NothingCooker", "file": "plugin-claude/plugin-claude.js", "version": "1.0.0" }
  ]
}
```

- 安装后文件名 = `<id>.js`，落位 `%APPDATA%\rimletter\plugins\`，与现有本地插件命名一致。
- `version` 为插件版本，当前用于显示；安装判定只看文件是否存在，更新 = 重新下载覆盖（jsDelivr 始终返回 main 分支最新）。

## 3. 主进程实现

### 3.1 新增 `src/main/market.js`

依赖注入风格（同 sensors 注入 `si`、updater 注入 `autoUpdater`），便于单测：

```js
createMarket({ config, configDir, fetch, onChanged })
```

| 函数 | 说明 |
|---|---|
| `list()` | 按通道顺序拉取清单（jsDelivr → raw 回退），合并「已安装」标记返回 `[{ id, name, desc, author, version, installed, error }]` |
| `install(id)` | 校验 id 合法性 → 下载 `.js` 到 `pluginsDir/.tmp-<id>.js` → 原子改名 `<id>.js` → 启用（从 `plugins.disabled` 移除）→ 触发 `onChanged`（重载插件） |
| `uninstall(id)` | 删除已安装文件 → 触发 `onChanged` |
| `updateAll()` | 遍历已安装且市场存在的插件，逐个 `install` |

纯函数（导出可单测）：
- `buildChannelUrls(repo, branch, filePath)` → jsDelivr 与 raw 两种完整 URL。
  - jsDelivr：`https://cdn.jsdelivr.net/gh/<repo>@<branch>/<filePath>`
  - raw：`https://raw.githubusercontent.com/<repo>/<branch>/<filePath>`
- `parseManifest(text)` → 校验结构（`version` + 非空 `plugins` 数组，每项含合法 `id`/`file`），非法抛错。
- `isSafeId(id)` → 必须匹配 `^[a-zA-Z0-9_-]+$`，防路径穿越。

下载用 Node 全局 `fetch`（主进程 Node ≥ 18），`AbortController` 超时（默认 15s）。清单与文件下载都走「jsDelivr 失败 → raw 回退」。

### 3.2 改造 `src/main/updater.js`——通道回退状态机

`createUpdater` 增加依赖：`proxyChannels`（加速前缀列表，来自 `config.update.proxyChannels`）、`publishRepo`（`NothingCooker/rimletter`）。

`checkNow()` 逻辑：

```
channels = proxyChannels 映射为 generic feed + 一个 native(github) feed
channelIdx = 0
attemptCheck():
  当前通道 setFeedURL：
    - 加速：autoUpdater.setFeedURL({ provider: 'generic', url: <前缀>/https://github.com/<owner>/<repo>/releases/latest/download })
    - 原生：autoUpdater.setFeedURL({ provider: 'github', owner, repo })
  setState({ code: 'checking', channel })
  return autoUpdater.checkForUpdates()
    .catch(err => channelIdx 未到末尾 → attemptCheck() 下一通道
                否则 setState({ code: 'error', error }))
```

- 成功事件流（`update-available` / `update-not-available`）沿用现有监听，无需改动；`checking` 标志在 finally 复位。
- `update-available` 后的下载走同一 feed（generic provider 基于 feed URL 拼文件地址）。
- **下载阶段错误不换通道**：下载发生在 `update-available` 之后，`checking` 已为 false，错误事件直接置 error 状态，不回退重试。避免下载一半跳通道。
- 状态新增可选字段 `channel`（当前通道标识），设置窗可显示「通过加速通道检查」。

### 3.3 main.js 接线

- `reloadEverything` 之外新建 `market` 实例（`config` 变化后 `list` 读最新配置）。
- IPC 新增：
  - `market:list` → `market.list()`
  - `market:install`(id) → `market.install(id)`
  - `market:uninstall`(id) → `market.uninstall(id)`
  - `market:updateAll` → `market.updateAll()`
- 安装 / 卸载后调用 `reloadEverything()`（market 内部通过 `onChanged` 回调）。
- `update:state` / `update:check` 沿用；`createUpdater` 传入 `proxyChannels` 与 repo。

## 4. 渲染层

### 4.1 preload.js

新增 `listMarket()`、`installPlugin(id)`、`uninstallPlugin(id)`、`updateAllPlugins()`。

### 4.2 settings.js「插件管理」页签

顶部新增「插件市场」区块（置于现有本地插件表格之前）：

- 按钮：刷新市场 / 更新全部
- 列表行：名称 + 描述 + 状态（可安装 / 已安装 / 失败原因），行内按钮：安装 / 卸载 / 更新
- 文案提示：「插件将获得本机完全执行权限，仅从官方仓库安装可信插件」
- 状态色沿用现有约定（绿=已安装、红=错误、灰=未安装）
- 加载失败显示错误，不影响本地插件表格

## 5. 测试

- `test/market.test.js`：
  - URL 构建（jsDelivr / raw）
  - 清单解析 / 非法清单抛错
  - 安装：下载成功落位、id 非法拒绝、临时文件清理
  - 卸载：删除文件
  - 通道回退：jsDelivr reject → raw 成功
- `test/updater.test.js` 扩展：
  - mock `autoUpdater.setFeedURL` + `checkForUpdates` 可配置 reject/成功
  - 首通道失败自动换下一通道并成功
  - 全部失败 → error 状态
  - 下载阶段错误不换通道
- `test/config.test.js`：新默认值存在

## 6. 安全

- `id` 白名单校验（`^[a-zA-Z0-9_-]+$`），防路径穿越写入插件目录。
- 插件来源锁定官方仓库（jsDelivr / raw URL 均由 `market.repo` 固定拼装，不接收任意 URL）。
- UI 明示执行权限风险。
- 当前不引入完整性校验（jsDelivr 服务 latest 分支版本，无稳定哈希可比对）；风险可控，后续如需可加签名。

## 7. 非目标（YAGNI）

- 不做插件版本差异检测（已安装即显示「更新」按钮，重装即覆盖最新）。
- 不做插件详情 README 预览。
- 不把加速通道做成 UI 可视化编辑（config.json 可改即可）。
- 插件市场不加搜索/分类。
