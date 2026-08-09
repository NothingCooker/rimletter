# RimLetter 自动更新 设计文档

日期：2026-08-09
状态：已批准（方案 A，用户确认）

## 1. 目标

为 RimLetter 增加自动检查更新功能：

- 启动后自动检查 GitHub Releases 是否有新版本
- 发现新版本时**静默后台下载**
- 下载完成后用应用自带的「信」通知「新版本已下载，重启后安装」
- 用户重启应用（或点设置页按钮）时自动安装新版本
- 设置里可以**手动关闭**自动检查（默认开启）

## 2. 方案选择

采用 **electron-updater**（electron-builder 同家族）：

- 项目 `electron-builder.yml` 已配置 `publish: github`，发布产物已含 `latest.yml` + `.blockmap`，正是 electron-updater 需要的元数据，零改造对接
- 支持增量更新、自动处理 GitHub Releases 元数据、事件驱动，代码量最小
- 备选的手写更新器（拉 latest.yml + 比较 + 下载 + 起安装器）重复造轮子，不做

## 3. 组件改动

| 文件 | 改动 |
|---|---|
| `src/main/updater.js`（新增） | 封装 electron-updater：`init` / `checkNow` / 事件→状态机。依赖注入 `autoUpdater`，便于单测 mock |
| `src/main/config.js` | `DEFAULT_CONFIG` 加 `update: { enabled: true }`。旧 config.json 无此字段时靠 `deepMerge` 补默认值 |
| `src/main/main.js` | ready 后接 updater；IPC handlers；`before-quit` 里有待装更新时 `quitAndInstall` |
| `src/renderer/preload.js` | 暴露 `getUpdateState` / `checkForUpdate` / `onUpdateStatus` |
| `src/renderer/settings.js` + `ui.css` | 常规设置页加「自动更新」开关 + 状态文字 + 「立即检查」按钮 |
| `package.json` | `dependencies` 加 `electron-updater`（运行时依赖，需打进包） |

## 4. 更新流程（数据流）

```
应用启动
  └─ 延时 ~3s，若 config.update.enabled
       └─ updater.checkForUpdates()
            ├─ 有更新 → autoDownload=true → 后台下载
            │    └─ 下载完成 → 触发通知信（NeutralEvent 灰蓝）「RimLetter vX.Y.Z 已下载，重启后安装」
            │         ├─ 重启应用 → before-quit → quitAndInstall() → 自动安装
            │         └─ 设置页「立即重启安装」按钮 → quitAndInstall()
            └─ 无更新 / 出错 → 状态回传设置页，静默不影响使用
```

- 手动「立即检查」按钮 → 立即 `checkForUpdates()`，结果反馈到设置页状态行
- 开关关闭 → 不自动检查/下载；但手动按钮仍可用（用户显式操作）

## 5. 状态机

updater 对上层暴露的状态：

| 状态 | 含义 |
|---|---|
| `checking` | 正在检查 |
| `uptodate` | 已是最新版本 |
| `update-available` | 发现新版本（后台开始下载） |
| `downloading` | 下载中（仅起止状态，不透传进度百分比） |
| `downloaded` | 已下载，待重启安装 |
| `error` | 检查/下载失败（含原因） |
| `disabled` | 自动更新开关关闭 |

设置页状态行按状态显示对应文案。

## 6. 错误处理

- 无网络 / GitHub 不可达 → 静默失败：console.log 记录 + 设置页状态「检查失败」，不影响应用任何功能
- 下载失败 → 状态置 error，下次启动自动重试；用户也可手动点「立即检查」重试
- `quitAndInstall` 仅在 `update-downloaded` 之后才调用

## 7. 测试

1. **单元测试**（node:test）：
   - config：`update.enabled` 默认 `true`；开关持久化（save/load 往返）
   - updater 状态机：mock electron-updater 的 `checkForUpdates` / 事件发射，断言状态迁移正确、`quitAndInstall` 仅在 downloaded 后触发、disabled 时不检查
2. **开发模式联调**（发布前）：
   - 临时把 `package.json` version 降到 `0.2.1`
   - 根目录加 `dev-app-update.yml`（provider: github, owner/repo），`autoUpdater.forceDevUpdateConfig = true`
   - `npm start` → 应检测到 GitHub 上的 v0.2.2 并开始下载 → 验证：网络、latest.yml 解析、版本比较、下载管线
   - 测完恢复版本号
3. **发布后实测**：
   - 发布 v0.2.3 后，用已安装旧版实测完整链路：启动 → 检测 → 下载 → 重启安装 → 版本变为 v0.2.3

## 8. 发布

- 功能 + 测试通过后 bump 到 `0.2.3`，走既有发布流程（commit → push master → tag v0.2.3 → CI 构建 → 发布草稿 → 手动 publish）
