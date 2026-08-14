# 更新多通道测速 + 可视化 设计文档

> 日期：2026-08-14
> 状态：已确认（用户拍板）
> 版本：v0.4.0 目标

## 背景

当前自动更新（`src/main/updater.js`）是**响应式回退**：按配置顺序尝试每个通道（每个加速前缀 → generic feed，末尾追加原生 GitHub），仅当某通道**出错**时才换下一个。它不做主动测速，无法在「所有通道都通但速度差异大」时优先走快的通道。

目标：更新检查前对全部通道主动测速（下载实际安装包前 1MB 测吞吐），**选择最快的通道优先下载**，并把测速过程用文字可视化在设置页「立即检查」按钮旁。

## 用户确认的关键决策

| 决策 | 结论 |
|---|---|
| 测速方式 | B：先拉各通道 `latest.yml` 清单，再对实际安装包发 `Range` 请求下载前 1MB 测真实吞吐 |
| 触发时机 | A：每次检查都测（启动自动检查 + 手动「立即检查」），不做缓存 |
| 可视化形式 | 仅文字总结：测速中「正在测速(通道 1/3)…」，完成后「正在通过「ghproxy.net」检查更新…」 |
| 「更新前测速」开关 | 加，`update.speedTest` 默认 true |
| 分块 / 超时 | 1MB 分块、每通道 5s 超时 |

## 架构

### 新增模块 `src/main/speedtest.js`（纯函数，可单测）

与 updater.js 解耦，延续「纯函数 + 可注入 mock」风格（参考 rules.js）。

| 函数 | 职责 |
|---|---|
| `buildChannelProbeUrls({ proxyChannels, publishRepo, arch })` | 为每个通道构造探测 URL：清单文件 + 安装包探测地址。清单文件名：`arch === 'arm64' ? 'latest-arm64.yml' : 'latest.yml'`（与 electron-updater 行为一致） |
| `fetchManifest(fetch, url, timeoutMs)` | 下载清单，解析出安装包相对路径 `path`（正则提取顶层 `path:` 行，fallback 到 `files` 段的 `- url:`）。返回 `{ ok, path }` 或 `{ ok: false, error }` |
| `measureThroughput(fetch, url, { chunkBytes, timeoutMs })` | 对安装包 URL 发 `Range: bytes=0-(chunkBytes-1)` 请求，读响应流计时，返回 `{ ok, mbps, bytes, ms }`。超时/失败 → `ok:false` |
| `rankChannels(channels, resultsByLabel)` | 按吞吐率（MB/s）降序重排通道；失败通道排后、同速保持原配置顺序（依赖稳定排序） |

URL 构造规则（与 updater.js `buildChannels` 保持一致）：
- 加速通道：`{base}/https://github.com/{owner}/{repo}/releases/latest/download/{file}`（base 为 `proxyChannels` 里的前缀）
- 原生 GitHub：`https://github.com/{owner}/{repo}/releases/latest/download/{file}`

`fetch` 由上层注入（main.js 传 `globalThis.fetch`，与 market.js 一致），保证 Node 版本无关与可测性。

### updater.js 集成

`createUpdater` 新增依赖注入：`{ speedTest, fetch, arch, isSpeedTestEnabled }`（均有默认，默认 `speedTest` 为空或 `isSpeedTestEnabled` 返回 false → 不测速，保证旧测试兼容）。`isSpeedTestEnabled` 为 live 回调（读实时 config，与现有 `isEnabled` 一致），设置页切换开关即时生效。

`checkNow()` 流程改为：

```
checkNow()
  ├─ isSpeedTestEnabled() 为真 且 buildChannelProbeUrls 有通道 →
  │    ├─ 并行拉各通道清单，取第一个成功者的安装包 path
  │    ├─ （path 为空 → 跳过测速，按原顺序走）
  │    ├─ 按序对每通道 measureThroughput（顺序测量避免带宽争抢导致测速失真，同时自然驱动「通道 x/n」进度）
  │    ├─ 每个通道测完即推 speedtesting 状态 { code, current, total, channel, mbps }
  │    └─ rankChannels 按吞吐重排 channels，winner 放最前，idx=0
  ├─ 测速整体异常 → log.warn，按原顺序走
  └─ 走现有 attempt()（checking → update-available → downloading → downloaded）
```

**现有响应式回退完整保留**作为安全网：测速只决定初始顺序，选中的通道在实际检查/下载中出错时仍换下一通道。

### 状态机与 IPC

- 新增 `speedtesting` 状态：`{ code:'speedtesting', current, total, channel, mbps? }`，经现有 `update:status` 通道推给设置窗（main.js 的 `onStatus` 已做转发，无需改 IPC）
- `checking` 状态已携带 `channel`，设置窗据此显示「正在通过「X」检查更新…」

### 设置页 UI（`src/renderer/settings.js`，仅文字）

更新状态行（`showUpdateStatus`）文案映射新增/修改：

| 状态 | 文案 |
|---|---|
| `speedtesting` | `正在测速(通道 ${current}/${total})…` |
| `checking`（带 channel） | `正在通过「${channel}」检查更新…` |
| `checking`（无 channel） | 保持 `正在检查更新…` |

「自动更新」行旁新增「更新前测速」开关（`data-toggle="update.speedTest"`）。

### 配置（`src/main/config.js`）

`DEFAULT_CONFIG.update` 新增 `speedTest: true`。无迁移逻辑（新字段 deepMerge 自然合并）。

### main.js 接线

`initUpdater()` 传 `fetch: globalThis.fetch`、`arch: process.arch`、`speedTest: require('./speedtest')`、`isSpeedTestEnabled: () => !!(config.update && config.update.speedTest)`。

## 错误处理

- 某通道清单拉不到：该通道标记失败，不参与吞吐排名；只要还有通道拉到清单即继续
- 全部通道清单都拉不到：跳过测速，按原顺序走现有逻辑（现有响应式回退兜底）
- 单通道 Range 下载超时/失败：该通道 `ok:false`，从排名剔除
- 测速整体抛异常：跳过测速，按原顺序继续（`speedTestChannels` 内部捕获一切异常并 resolve null，绝不 reject 阻断更新检查）

## 测试计划

- 新增 `test/speedtest.test.js`：
  - `buildChannelProbeUrls`：proxy + github 通道的清单/安装包 URL；arm64 用 `latest-arm64.yml`
  - `fetchManifest`：解析顶层 `path:`；无顶层 path 时 fallback files `- url:`；超时 → ok:false
  - `measureThroughput`：mock fetch 返回可控字节流，验证 mbps = bytes/ms 换算；断流/超时 → ok:false
  - `rankChannels`：按吞吐排序；同速保序；全失败保原序
- `test/updater.test.js` 补充：
  - `speedTest:true` 时先测速、按重排结果检查（feedHistory 顺序 = 重排后）
  - 测速整体失败 → 按原顺序
  - `speedTest:false` / 未注入 speedTest → 不测速、直接原逻辑
- 现有 122 测试保持通过

## 非目标（YAGNI）

- 不做测速结果缓存/持久化
- 不做每通道完整进度条/图形化可视化（用户选仅文字）
- 不给测速结果单独持久化存储
- 不做手动「只测速不更新」按钮
