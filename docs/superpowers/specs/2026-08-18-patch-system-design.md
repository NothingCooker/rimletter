# 补丁系统（热补丁 + 补丁版本差分）设计

日期：2026-08-18
状态：已确认（v1.0.0 目标；M1~M4 全部完成 2026-08-19，`npm test` 259 通过）

## 1. 问题

用户对 v1.0.0 之后的版本治理提出三个目标：

1. **版本号语义化**：以后版本号更新只代表新功能（1.1.0 = 新功能），不再像 v0.x 时代那样频繁为修 bug 发版。
2. **旧版本无 bug**：用户从 Releases 下载的**任何 ≥1.0.0 的旧安装包**，装上启动后也能被修复——即「下载旧版本也没有 bug」。
3. **修 bug 不升版本号**：常规 bug 修复走「补丁系统」静默下发，不占用版本号。

约束：**恶性破坏性 bug 除外**（启动即崩、数据丢失、安全漏洞），这类允许破例升版。

第 2 点是关键难点：旧安装包里的代码是死的，唯一可行的答案是把**补丁引擎内置进 v1.0.0**，让任何 ≥1.0.0 的安装包启动后自动拉取并应用全部历史补丁。

## 2. 版本语义约定（v1.0.0 起）

| 版本位 | 含义 | 例子 |
|---|---|---|
| minor（x.1.0） | **仅新功能** | 1.1.0 新增传感器 / 1.2.0 新增信样式 |
| major（2.0.0） | 破坏性变化（插件 API break / 配置不兼容 / UI 大改） | 2.0.0 |
| patch（1.0.x） | **仅恶性 bug**（启动崩溃、数据丢失、安全漏洞、原生层/渲染层无法热修），一年不超过几次 | 1.0.1 |
| 热补丁（无版本号） | **所有常规 bug**，静默下发，用户版本号不变 | 1.0.0 + P12 |

设置页显示：`版本 1.0.0 · 已应用补丁 12`（补丁数只读展示，不强调版本变化）。

## 3. 方案 A：热补丁引擎（主力）

### 3.1 分发链路：复用 v0.6.5 的「先解析后固定」@sha 模式

补丁清单与补丁文件放**主仓库 `patches/` 目录**（与源码同仓：CI 可单测补丁、与代码版本对应清晰），拉取链路完全复用插件市场 v0.6.5 已验证的机制：

1. **解析**：GitHub API `GET /api.github.com/repos/NothingCooker/rimletter/commits/master`（回退 jsDelivr data API）→ 最新 commit SHA。
2. **拉取**：manifest 与补丁文件都按不可变引用 `cdn.jsdelivr.net/gh/NothingCooker/rimletter@{sha}/patches/...`（回退 `raw.githubusercontent.com`）。
3. **一致性**：manifest 与补丁文件来自**同一 commit**，无版本错配（与市场安装同一模式，中途 push 不影响）。

不选 GitHub Releases assets（`gh release upload --clobber` 覆盖）：更新需 DELETE+POST 且历史不可追，且易与 electron-updater 的 feed 逻辑混淆。@sha 模式 CDN 永久缓存、无 12h 过期、无 purge 滥用。

### 3.2 manifest 格式（累积全量）

manifest 是**累积列表**（不是增量）——新装旧包（如 1.0.0）的客户端需要全部历史补丁，必须一次拉全。每条补丁声明适用版本范围，客户端按自身版本过滤：

```json
{
  "schema": 1,
  "updatedAt": "2026-08-18T12:00:00Z",
  "patches": [
    {
      "id": "fix-001-disk-efi",
      "title": "修复磁盘规则对 EFI 分区误报",
      "minVersion": "1.0.0",
      "maxVersion": "1.0.99",
      "platforms": ["win32", "linux"],
      "file": "patches/fix-001-disk-efi.js",
      "sha256": "…64位hex…",
      "severity": "bugfix",
      "publishedAt": "2026-08-20T10:00:00Z"
    }
  ]
}
```

- `file` 为相对路径，客户端用**同一解析到的 SHA** 拼完整 URL（同 commit 拉取）。
- `maxVersion` 用于代码重构后补丁不再适用的场景（如 1.2.0 重写了目标函数且已含修复 → 新客户端不再打该补丁）。
- manifest 由 `scripts/build_patch_manifest.js` 扫描 `patches/` 生成（含 sha256），随 push 提交。

### 3.3 补丁文件格式与作用域

```js
// patches/fix-001-disk-efi.js —— 头部注释被 build 脚本读取
// @id fix-001-disk-efi
// @title 修复磁盘规则对 EFI 分区误报
// @minVersion 1.0.0
// @maxVersion 1.0.99
// @platforms win32,linux

module.exports = {
  apply(ctx) {
    // 幂等自检：已打过直接返回
    if (ctx.patched('fix-001-disk-efi')) return;
    // 例：替换 rules.js 导出对象上的函数
    ctx.patchModule('src/main/rules.js', (exports) => {
      const orig = exports.isDiskCandidate;
      exports.isDiskCandidate = (m) => orig(m) && !/^(vfat|msdos)$/.test(m.fs);
    });
  }
};
```

**作用域机制 `patchModule(relPath, mutator)`**：按应用根（`app.getAppPath()`，兼容 asar）`require.resolve` 目标模块，取 `require.cache` 中的导出对象，`mutator(exports)` 原地替换导出属性。凡是通过**对象属性访问**调用方（`const rules = require('./rules'); rules.isDiskCandidate(x)`）自动生效。

**硬限制（必须写进补丁编写指南）**：调用方若**解构导入**（`const { isDiskCandidate } = require('./rules')`），属性替换不生效。此类函数不可热修，其 bug 走方案 B 或并入下个 feature 版。**v1.0.0 起的新代码约定：跨模块调用一律对象访问，禁止解构导入**，让热补丁覆盖面随版本增长。

**补丁内容指南**：默认阈值/正则/白名单等数据、规则引擎纯函数逻辑、配置迁移、信格式化等主进程行为。**v1 热补丁范围外**：渲染层逻辑、原生层、Electron 升级 → 方案 B。

### 3.4 启动时序

```
main.js 启动
→ patcher.preflight()           同步（毫秒级）：读 patch-state.json，崩溃熔断检测
→ patcher.applyAll()            异步（整体超时 ~8s，失败静默不阻塞）：
    resolve SHA（5s 超时）→ 拉 manifest → 过滤（版本范围/platform/已应用/已禁用）
    → 逐个下载 → sha256 校验 → apply（try/catch + 3s 超时熔断）→ 记 state
→ 补丁阶段完成（无论成败）→ updater.scheduleInitialCheck() 才开始计时
→ 失败/离线：只记日志，启动与自动更新照常
```

**时序要点**：自动更新的首次检查必须等补丁阶段结束后再调度（checkDelayMs 从补丁完成开始算），否则「修 updater 的补丁」来不及生效。

### 3.5 崩溃熔断（补丁打崩应用自动回滚）

状态独立存 `userData/patch-state.json`（config.json 高频写盘，补丁状态低频且需原子性，写盘用 tmp+rename）：

```json
{ "schema": 1, "applied": [{ "id": "fix-001", "at": "…" }], "disabled": ["fix-002"], "crashes": 0, "lastExitOk": true }
```

规则：

- 正常退出（app quit 流程）或连续健康运行 5 分钟 → `lastExitOk = true`、`crashes = 0`。
- 启动时发现上次非正常退出 → `crashes++`；`crashes ≥ 2`（`patch.crashThreshold`）→ **禁用最近一个 applied 补丁**并清零计数，日志记录，应用照常启动。
- 连续异常但无补丁可禁 → 不再干预（另有全局看门狗兜底）。
- 补丁 apply 全程 try/catch + 超时，单补丁失败不中断其他补丁、不影响启动。

### 3.6 补丁发布流程

1. 改 `patches/` 下补丁文件（或新增）→ 跑 `scripts/build_patch_manifest.js` 重新生成 manifest。
2. `npm test`（补丁单测在 CI 跑）→ push master。
3. 可选：build.yml 加 `paths-ignore: ['patches/**', 'docs/**']`，补丁提交不触发全量 Windows/Linux 构建（当前 build.yml 对任何 push 全量构建，纯补丁提交属浪费）。
4. **无需发版**：客户端启动时自动拉到（CDN 秒级生效）。补丁发布不碰 electron-updater、不碰版本号。

### 3.7 灰度（预留，v1 不全量启用）

manifest 每条补丁预留 `channel: 'stable' | 'beta'` 与 `rollout: 0~1`（客户端按 `hash(安装ID+补丁id) % 100 < rollout*100` 判断）。v1 只发 stable 全量，机制字段保留。

## 4. 方案 B：补丁版本号 + 差分更新（兜底）

热补丁覆盖不了的（启动即崩、原生层、渲染层硬伤、安全）→ 升 `1.0.x`：

- electron-updater v6 原生支持 **blockmap 差分更新**（electron-builder 已自动生成 `.blockmap`，NSIS/AppImage 自动只下载变更部分，几百 KB~几 MB，用户无感静默升级，无需新代码）。
- 设置页显示 `版本 1.0.1（补丁）`，弱化表达。
- **Linux deb 不支持差分**，需手动重装；README 注明——deb 用户的常规 bug 更要靠热补丁兜住。
- 频次纪律：patch 版本一年 ≤ 几次。

## 5. 方案 C：兼容性纪律（地基）

补丁系统救不了所有情况，1.0.0 起必须遵守：

- **配置向后兼容**：config schema 只增不改（现有 deepMerge 已支持），新字段带默认值。
- **API/插件契约冻结**：`api.*`、插件 API 只加不改；breaking change 必须升 minor 并带迁移。
- **新功能默认关闭/渐进增强**：新功能 bug 不波及老配置路径。
- **发布清单**：每次发版记录已知问题 + 受影响版本范围（作为补丁 minVersion/maxVersion 依据）。
- 热补丁兼作**功能开关**：新功能出问题，发「禁用该功能」补丁，不回滚版本。

## 6. 配置

```js
patch: {
  enabled: true,        // 总开关
  repo: 'NothingCooker/rimletter',
  branch: 'master',
  timeoutMs: 8000,      // 补丁阶段整体超时（含 resolve+manifest）
  applyTimeoutMs: 3000, // 单个补丁 apply 超时
  crashThreshold: 2,    // 连续异常启动次数达到即回滚最近补丁
  channel: 'stable'     // 预留灰度
}
```

## 7. 测试计划

- manifest：解析、累积完整性、版本范围过滤（边界 1.0.0 / 1.0.99 / 不适用跳过）、平台过滤。
- 执行：sha256 不符丢弃不执行；单补丁 apply 抛错不中断其余；幂等（applyAll 两次只应用一次）；@sha URL 拼装（与 manifest 同 commit）。
- 熔断状态机：健康运行清零 / 异常递增 / 达到阈值禁用最近补丁 / 无可禁补丁不干预 / 原子写。
- 作用域：`patchModule` 对真实模块（如 rules.js）打示例补丁验证行为变化；解构引用不生效的文档化限制（warn 日志）。
- 时序：补丁阶段完成后才触发 updater 首次检查（mock 验证调用顺序）。
- 配置：`patch.*` 默认值。

## 8. 安全

- manifest 与补丁文件 HTTPS + sha256 严格校验（`^[0-9a-f]{64}$`），不符丢弃不执行。
- repo/branch 固定拼装，不接受任意 URL（与市场一致）。
- 补丁在主进程执行 = 远程代码执行能力；信任模型 = 仓库 push 权限，与自动更新安装包等同（补丁只影响本会话进程、不写系统级位置），文档明示。
- 补丁仅由官方维护者编写，随主仓库审阅/CI 单测。

## 9. 文件清单与里程碑

| 里程碑 | 内容 |
|---|---|
| ✅ M1 引擎核心 | `src/main/patcher.js`（resolve/fetch/verify/apply/状态/熔断，deps 注入可单测）+ `test/patcher.test.js`（26 个单测） |
| ✅ M2 作用域+示例 | `patchModule` 工具 + 示例补丁 `patches/fix-001-empty-letter-label.js`（formatLetter 空标题回退）+ `test/patches.test.js`（含端到端 applyAll 验证，补丁单测进 CI） |
| ✅ M3 集成 | main.js 接入（preflight → applyAll → 补丁阶段完成后才 `updater.scheduleInitialCheck()` + 5 分钟健康标记 + before-quit `markExitOk`）+ `DEFAULT_CONFIG.patch` 命名空间 + 设置页「关于」版本行显示「版本 x · 已应用补丁 N」 |
| ✅ M4 发布工具 | `scripts/build_patch_manifest.js`（生成/`--check` 校验，忽略 updatedAt 比对内容实质）+ `npm run build:manifest` + `docs/patches-guide.md` + build.yml `paths-ignore: ['patches/**','docs/**']` + 轻量 workflow `patches.yml`（补丁单测 + manifest 校验） |

**实现补充（2026-08-19）**：方案 C「禁止解构导入」约定不只是新代码规范——现有代码已全部改造为对象访问（main.js / monitor.js / letters.js / patcher.js），否则补丁对解构引用点（monitor 的 evaluateRules、main 的 formatLetter 等）静默无效。1.0.0 起热补丁对主进程核心模块真实生效。

1.0.0 之后：常规 bug 默认走热补丁（不升版）；恶性 bug 走 1.0.x 补丁版本；新功能走 1.1.0+。

## 10. 待确认点

1. 补丁拉取链路确认走主仓库 `patches/` + jsDelivr @sha（复用 v0.6.5 市场机制）？
2. 崩溃熔断阈值（默认连续 2 次异常启动回滚）是否合适？
3. 设置页补丁列表（只读展示补丁 id/标题/时间）v1 是否要做，还是只显示补丁计数？
4. build.yml 加 `paths-ignore` 让补丁提交不触发全量构建，是否同意？
