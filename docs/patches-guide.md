# RimLetter 补丁编写与发布指南

> 完整设计见 `docs/superpowers/specs/2026-08-18-patch-system-design.md`。
> 一句话：**常规 bug 修复不升版本号**，通过热补丁系统静默下发；只有恶性 bug（启动即崩、数据丢失、安全漏洞、原生层/渲染层无法热修）才升 `1.0.x` 补丁版本。

## 1. 什么 bug 适合热补丁

适合（主进程 JS 逻辑）：

- 规则引擎（`rules.js`）、信格式化（`letters.js`）等主进程模块的函数行为
- 默认阈值 / 正则 / 白名单等数据与判断条件
- 配置迁移、API 行为、传感器数据修正
- 新功能出问题时的「禁用该功能」开关

不适合（走补丁版本 `1.0.x`）：

- 应用启动即崩溃（补丁引擎都跑不起来）
- 渲染层（覆盖层/设置窗 UI 逻辑）——v1 热补丁范围外
- 原生层、Electron 本身、安装包问题
- 数据丢失类、安全漏洞（需要用户尽快升级）

## 2. 补丁文件结构

放在 `patches/<id>.js`，头部注释即元数据（`scripts/build_patch_manifest.js` 读取并生成 `manifest.json`）：

```js
// 补丁：信标题为空时回退为紧急度名
// 正文说明该 bug 与修复思路（会进入仓库审阅与单测）。
// @id fix-001-empty-letter-label      ← 必须，全局唯一（^[a-zA-Z0-9_-]+$）
// @title 信标题为空时回退为紧急度名    ← 必须
// @minVersion 1.0.0                   ← 必须，适用版本下限（含）
// @maxVersion 1.0.99                  ← 必须，适用版本上限（含）；代码重构后不再适用时收窄
// @platforms win32,linux              ← 可选，默认全平台
// @severity bugfix                    ← 可选，默认 bugfix
// @channel stable                     ← 可选，默认 stable（预留灰度）
// @publishedAt 2026-08-20T10:00:00Z   ← 可选

module.exports = {
  // 幂等：引擎按 state.applied 过滤，这里用 ctx.patched 自检双保险
  apply(ctx) {
    if (ctx.patched('fix-001-empty-letter-label')) return; // @id 与此处字符串必须一致
    ctx.patchModule('src/main/letters.js', (exports) => {
      const orig = exports.formatLetter;
      exports.formatLetter = function (severity, label, description, extra, dismissMs) {
        const safeLabel = (typeof label === 'string' && label.trim()) ? label : String(severity == null ? '' : severity);
        return orig(severity, safeLabel, description, extra, dismissMs);
      };
    });
  }
};
```

### apply(ctx) 可用 API

| API | 说明 |
|---|---|
| `ctx.patchModule(relPath, mutator)` | 按应用根解析模块，取 require 缓存导出对象原地替换属性。`mutator(exports)` 内先保存 `orig` 再替换 |
| `ctx.patched(id)` | 该补丁是否已应用（幂等自检） |
| `ctx.log(msg)` | 记入 rimletter.log（前缀 `[patch:<id>]`） |

### 硬性限制（违反则补丁静默无效）

- **调用方必须对象访问**：补丁只能替换「模块导出对象上的属性」；若调用方是**解构导入**（`const { formatLetter } = require('./letters')`），替换不生效。应用代码已约定禁止解构导入，**新代码务必遵守**。
- **目标模块导出必须是对象**：`module.exports = function` 之类的直接导出无法原地替换。
- **补丁必须是幂等的**：先 `ctx.patched` 自检再动手。
- **补丁代码全程 try/catch 或保证不抛错**：apply 抛错该补丁失败，不影响启动与其它补丁，但修复不生效。
- 补丁运行于主进程，拥有应用全部权限——**只写官方补丁**，sha256 校验 + 仓库 push 权限是唯一信任边界。

## 3. 发布流程

```bash
# 1. 写补丁 patches/<id>.js（按第 2 节结构）
# 2. 在 test/patches.test.js 里加行为测试（补丁单测会进 CI）
# 3. 重新生成 manifest（sha256 变了必须更新）
npm run build:manifest
# 4. 本地全量测试
npm test
# 5. 提交并推送 master（无需发版、无需构建、无需打 tag）
git add patches/ test/patches.test.js
git commit -m "patch: <标题>"
git push
```

推送后：

- 触发 `patches.yml`（轻量 workflow，只跑补丁相关测试 + manifest 一致性校验），**不触发全量构建**（build.yml 已对 `patches/**`、`docs/**` 配置 paths-ignore）。
- 客户端下次启动自动拉到（GitHub API 解析 commit → jsDelivr 不可变 @sha，秒级生效，无 CDN 缓存过期）。

**不要做的事**：不要为发补丁改 `package.json` 版本、不要打 tag、不要动 electron-builder 产物。补丁不经过自动更新通道。

## 4. 版本范围选择

- 新补丁默认 `minVersion` = 当前最新正式版（如 1.0.0），`maxVersion` = 当前大版本上限（如 1.0.99）。
- 若某版本（如 1.2.0）重构了目标函数且已包含修复，把 `maxVersion` 收窄到 1.1.99，避免重复包装。
- manifest 是**累积全量列表**：新装旧包（如 1.0.0）的客户端会一次应用全部历史补丁——这正是「下载旧版本也没有 bug」的机制。

## 5. 回滚

- **自动**：补丁打崩应用 → 连续 2 次异常启动后引擎自动禁用最近补丁（`config.patch.crashThreshold` 可调），下次启动不再应用即回滚。
- **手动**：用户改 `config.json` 的 `patch.enabled = false` 可整体关闭；或在 `userData/patch-state.json` 的 `disabled` 数组加补丁 id。
- 补丁有问题时发布「禁用补丁」的新补丁即可，无需发版。
