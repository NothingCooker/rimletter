# 插件市场缓存新鲜度 + 插件版本号 设计

日期：2026-08-18
状态：已确认（v0.6.5 目标）

## 1. 问题

1. **缓存过期时间长**：jsDelivr 对 `@branch`（`@main`）引用最长缓存 12 小时，`?cb=` query string 不在 CDN 缓存键里破不了缓存。v0.5.2 的 purge 方案只在手动点「刷新市场」时生效（purge API 有调用限制，普通 list 不做），用户平时打开市场页签、或插件作者刚 push 新版，仍可能读到最长 12 小时前的旧清单，感应不到更新。
2. **无插件版本号**：清单 `plugins.json` 条目本来就有 `version` 字段，但界面不显示、本地不记录已装版本——「更新」按钮对每个已装插件都显示，用户看不出是否真有新版。

## 2. 方案

### 2.1 commit SHA 固定引用，从根上消除 CDN 过期

拉取路径改为「先解析、后固定」：

1. **解析**：分支 → 最新 commit SHA。优先 GitHub API `GET /api.github.com/repos/{repo}/commits/{branch}`（动态数据，无 CDN 缓存，永远新鲜；匿名限 60 次/小时，市场低频使用足够）；失败回退 jsDelivr data API `GET /data.jsdelivr.com/v1/packages/gh/{repo}@{branch}`（`version` 字段即解析到的 commit）；再失败返回 null。
2. **拉取**：拿到 SHA 后，清单与插件文件都按**不可变 commit 引用** `cdn.jsdelivr.net/gh/{repo}@{sha}/...`（jsDelivr 对 commit 永久缓存、内容永不变化，不存在过期问题），回退 `raw.githubusercontent.com/{repo}/{sha}/...`。
3. **一致性**：清单与文件来自**同一 commit**，不会出现「新清单 + 旧插件文件」错配；安装/更新时把清单解析出的 ref 传给文件下载复用，中途 push 也不影响。
4. **兜底**：SHA 解析失败（GitHub API 与 data API 都不通）回退旧 `@branch` 行为（refresh 仍先 purge）。解析成功但 `@sha` 两通道全挂则直接报错，**不回退 `@branch`**——避免版本错配。

### 2.2 本地已装版本记录

插件目录新增 `.installed.json`（`{ [id]: { version, updatedAt } }`）：

- 安装/更新时写入（原子写：tmp + rename），卸载时删除。
- `list()` 返回每条目附带 `installedVersion` 与 `hasUpdate`。
- `hasUpdate(remote, installed)`：清单无 version（老清单）→ 保守视为可更新（保持旧「始终显示更新」行为）；本地无记录（手动放的插件）→ 视为可更新（更新后补记）；两者都有 → `compareVersions(remote, installed) > 0` 才提示，本地更高不回退。
- `compareVersions`：数字段逐段比较（`1.10.0 > 1.9.0`）；数字部分相等时无后缀 > 有后缀（发布版 > 预发布版，`0.1.0-beta < 0.1.0`）；非数字版本整串字符串比较；忽略前导 `v`。

### 2.3 updateAll 只更新有新版

`updateAll()` 从「重装全部已安装」改为「只更新 `hasUpdate` 的已安装插件」，返回 `{ updated: [{id, version}], skipped: [id], errors: [{id, error}] }`。设置窗提示「已更新 N 个 / 全部已是最新 / 失败列表」。

### 2.4 自动检查 + 来信通知

- `market.checkUpdates()` 返回已安装且有更新的插件列表。
- main.js 启动延迟 30s 首次检查，之后按 `config.market.checkIntervalMs`（默认 6 小时）周期检查（`config.market.autoCheck` 可关）。
- 发现新版弹一封**中性「插件更新可用」信**，描述列出插件名与版本号（`「天气信」v1.0.0 → v1.2.0`），提示「打开设置 → 插件市场可更新」。
- 每会话同一批插件只通知一次（`notifiedPluginUpdates` Set），用户不理不重复打扰；检查失败只记日志（warn），不打扰。

### 2.5 设置窗市场 UI

表格新增「版本」列（显示清单 version，无则 `—`）；状态列区分：

| 状态 | 显示 | 操作 |
|---|---|---|
| 未安装 | `未安装`（灰） | 安装 |
| 已装且最新 | `已安装 v1.2.0`（绿） | 卸载 |
| 已装且有新版 | `有新版本（已装 v1.0.0）`（黄） | 更新 + 卸载 |

「刷新市场 / 更新全部」按钮旁显示「⚠ N 个插件可更新」提示（黄）。

## 3. 配置

```js
market: { repo: 'NothingCooker/rimletter-official-plugins', branch: 'main', autoCheck: true, checkIntervalMs: 6 * 3600 * 1000 }
```

## 4. 测试

- SHA 解析：URL 构建、`{sha}`/`{version}` 提取、非法拒绝、通道回退、全败返回 null。
- 固定引用拉取：list 只请求 `@sha` 地址且无 `?cb=`；安装文件与清单同 commit；`@sha` 全挂直接抛错不回退 `@branch`。
- 版本：`compareVersions`（多位数段/前导 v/预发布/非数字）、`hasUpdate`（更高/相等/本地更高/缺版本）。
- 记录文件：安装写入、卸载删除、list 合并 `installedVersion`/`hasUpdate`。
- updateAll：无记录视为可更新、最新跳过、单项失败不中断。
- checkUpdates：只返回已装有更新的插件；全部最新返回空。
- config：`market.autoCheck` / `checkIntervalMs` 默认值。

## 5. 安全

- `@sha` 引用与 `@branch` 一样由 `market.repo` 固定拼装，不接受任意 URL；SHA 严格 `^[0-9a-f]{40}$` 校验。
- `.installed.json` 仅记录 id/version/updatedAt，不参与插件加载（加载器只读 `.js`）。
