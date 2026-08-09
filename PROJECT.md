# RimLetter 边缘信使 - 完整项目文档

## 1. 项目概览

复刻《边缘世界》(RimWorld) 右侧 Letter 信件播报系统的**桌面功能性摆件**。硬件占用过高时，信从屏幕右缘坠落滑入提醒；平时完全隐身，告警才出现。使用游戏解包的原始 UI 素材与配色，支持本地 HTTP API 和手写 JS 插件扩展。

## 2. 仓库

- **远程仓库**：https://github.com/NothingCooker/rimletter （公开，master 分支）
- **本地目录**：`D:\claudeswork\RIM DESKTOP`
- **默认分支**：master
- **版本发布**：GitHub Releases（草稿/正式，见第 10 节）
- **自动构建**：GitHub Actions

## 3. 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 43（全屏透明无边框置顶窗口） |
| 硬件监控 | systeminformation 5 |
| 测试 | Node 内置 `node:test`（零额外依赖） |
| 素材提取 | Python 3 + UnityPy 1.25 + Pillow |
| 反编译参考 | ILSpy（ilspycmd） |
| 打包 | electron-builder 25（NSIS 安装程序） |

本机工具链：Node v24 / npm 11 / Python 3.13 / 无 Rust。

## 4. 功能特性

- 全屏透明悬浮层，平时隐身，鼠标穿透，仅信区域可交互
- 信从上方 200px 坠落滑入（1s）+ 淡入；全屏径向闪光；威胁级弹跳
- 标题**居中于图标中心、允许向两侧溢出**（游戏原版行为），图标+文字一起浮动
- 五种紧急度配色（取自游戏 LetterDefs）：
  - ThreatBig 重大威胁 - 红 `#CC7373`
  - ThreatSmall 威胁 - 橙红 `#CC9B7D`
  - NegativeEvent 负面 - 黄 `#CCC487`
  - NeutralEvent 中性 - 灰蓝 `#AFB0B9`
  - PositiveEvent 正面(恢复正常) - 蓝 `#78B0D8`
- 可扩展规则引擎：传感器 + 指标 + 比较符 + 阈值 + 持续时长 + 紧急度 + 标题 + 描述 + 音效
  - 含状态机：去重（不刷屏）、持续时长判定（防瞬时尖峰误报）、恢复时发"恢复正常"蓝信
- 本地 HTTP API（token 鉴权）：任何程序触发播报/管规则
- 插件系统：手写 JS，注册自定义传感器/规则/主动播报，注册的传感器自动出现在规则下拉
- 游戏原声音效（提取自 FMOD 音频，WAV 格式）
- 托盘图标：单击打开设置、右键菜单（设置/测试播报/退出）
- 开机自启开关（设置窗可切，写 Windows 注册表 Run 项）
- 自动更新：启动静默检查 GitHub 新版，下载完成用「信」通知，重启自动安装；设置可关闭/立即检查/立即重启安装
- 设置窗口完全参考环世界 UI：深灰蓝窗口 + 米色按钮 + 原版控件，三页签（常规/告警规则/插件管理）

## 5. 目录结构

```
D:\claudeswork\RIM DESKTOP\
├── package.json / package-lock.json / .npmrc / .gitignore
├── README.md                 # GitHub 仓库首页说明
├── PROJECT.md                # 本文件
├── CLAUDE.md                 # 会话记忆索引
├── electron-builder.yml      # 打包配置（NSIS + GitHub 发布）
├── build/icon.ico            # 应用图标（从 LetterUnopened 生成）
├── docs/
│   ├── images/               # README 截图（告警示例、设置窗口）
│   └── superpowers/
│       ├── specs/            # 设计文档
│       └── plans/            # 实现计划
├── assets/
│   ├── raw/                  # 解包游戏 UI 纹理（22 张）
│   ├── letter/               # 5 张紧急度染色信 PNG
│   └── sounds/               # 6 个游戏原声 WAV
├── scripts/extract_assets.py # 素材提取管线
├── src/
│   ├── main/
│   │   ├── main.js           # Electron 入口：透明窗+托盘+IPC+组装服务
│   │   ├── config.js         # 配置加载/保存（DEFAULT_CONFIG + deepMerge）
│   │   ├── letterdefs.js     # 5 级紧急度定义（游戏数值）
│   │   ├── rules.js          # 规则引擎（纯函数）
│   │   ├── sensors.js        # 传感器读取（依赖注入 si）
│   │   ├── monitor.js        # 轮询服务（动态 snapshot 门面）
│   │   ├── api.js            # 本地 HTTP API
│   │   └── plugins.js        # 插件加载器
│   └── renderer/
│       ├── preload.js        # contextBridge IPC 桥
│       ├── overlay.html/js   # 全屏透明覆盖层（信堆栈+动画）
│       ├── settings.html/js  # 设置窗口（3 页签）
│       └── ui.css            # 环世界风格样式
├── test/                     # node:test 单元测试（33 个）
├── plugins/example.js        # 示例插件模板（默认禁用）
└── .github/workflows/
    ├── build.yml             # master push → 构建预览包
    └── release.yml           # tag push → 构建并发布 Release
```

## 6. 快速开始

```bash
# 安装依赖（electron 二进制经 npmmirror 镜像下载）
npm install

# 启动
npm start

# 运行测试
npm test

# 提取素材（若 assets 缺失）
python scripts/extract_assets.py

# 本地打包（注意：本机 dev-sidecar 代理会干扰 electron-builder，见第 11 节）
npm run build
```

首次启动后托盘出现 RimLetter 图标，单击打开设置窗口。

## 7. 配置（config.json）

位于 `%APPDATA%\rimletter\config.json`，设置窗可改：

```json
{
  "pollIntervalMs": 2000,          // 轮询间隔
  "autoDismissMs": 20000,          // 信自动消失时长
  "recoveryDismissMs": 10000,      // 恢复类信消失时长
  "api": { "enabled": true, "port": 17301, "token": "自动生成" },
  "appearance": { "iconSize": 64 },// 信图标大小
  "sound": { "enabled": true, "volume": 0.7 },
  "plugins": { "disabled": ["example"] },
  "rules": [ /* 告警规则数组 */ ]
}
```

规则结构：
```json
{
  "id": "builtin-cpu",
  "sensor": "cpu", "metric": "load",
  "operator": ">", "threshold": 85,
  "durationMs": 5000,
  "severity": "ThreatBig",
  "label": "CPU 占用过高",
  "description": "...",
  "sound": "auto",
  "enabled": true
}
```

内置规则：CPU 占用 >85%(ThreatBig)、GPU 温度 >85°C(ThreatSmall)、GPU 占用 >95%(ThreatSmall)、内存 >90%(NegativeEvent)、磁盘剩余 <10GB(NeutralEvent)。

## 8. 本地 HTTP API

默认 `http://127.0.0.1:17301`，仅绑定本机，需请求头 `X-RimLetter-Token`（token 见 config.json）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /health | 存活检查 |
| POST | /letter | 触发播报 `{severity, title, description, sound?}` |
| GET | /state | 各传感器实时值 |
| GET | /rules | 读取规则 |
| POST | /rules | 新增规则 |
| PUT | /rules/:id | 修改规则 |
| DELETE | /rules/:id | 删除规则 |
| POST | /reload | 重载配置与插件 |

示例：
```bash
curl -X POST http://127.0.0.1:17301/letter \
  -H "X-RimLetter-Token: <token>" -H "Content-Type: application/json" \
  -d '{"severity":"ThreatSmall","title":"构建完成","description":"CI 产物已生成"}'
```

注意：Windows 终端 curl 发中文会按 GBK 编码导致乱码，用 Python 或确保 UTF-8 编码发送。

## 9. 插件开发

插件 = `%APPDATA%\rimletter\plugins\` 目录下 `.js` 文件，导出 `async ({ api, logger }) => {}`。

API：
| 方法 | 说明 |
|---|---|
| api.registerSensor(name, fn) | 注册自定义传感器，fn 返回 `{value}`，自动进规则下拉 |
| api.registerRule(rule) | 注册规则（结构同内置规则） |
| api.letter({severity, title, description, sound}) | 主动触发播报 |
| api.on(event, handler) | 订阅事件（alert/recovered/rule） |
| api.getState() | 读取当前全部传感器值 |
| api.setInterval(fn, ms) | 定时器（应用退出自动清理） |
| logger.info/warn/error(...) | 带插件名前缀的日志 |

完整 API 参考在设置窗 → 插件管理 → 插件开发文档。插件管理页支持：文档/源码预览/启用禁用。`example` 插件默认禁用。

## 10. CI/CD 与发布

**两个工作流：**

| 触发 | 工作流 | 行为 |
|---|---|---|
| push master | build.yml | 构建 NSIS 安装包 → 上传 Actions Artifact（预览包），**不碰 Release** |
| push tag v* | release.yml | 构建 → **发布 GitHub Release**（唯一发布入口） |

**预览构建：**
```bash
git add . && git commit -m "..." && git push
```
下载：`https://github.com/NothingCooker/rimletter/actions` → 最新运行 → Artifacts → RimLetter-windows

**发布正式版：**
```bash
# 1. 改 package.json 的 version（如 0.2.0），提交推送
# 2. 打 tag 并推送（触发发布）
git tag v0.2.0
git push origin v0.2.0
```
下载：`https://github.com/NothingCooker/rimletter/releases`

**重要：electron-builder 创建的 Release 是「草稿」（Draft），需手动发布：**
- 方式一（GitHub 页面）：Releases → 找到 Draft 条目 → 右上角「Publish release」
- 方式二（命令行，可同时写更新日志）：
  ```bash
  gh release edit v0.2.0 --repo NothingCooker/rimletter --notes "更新日志内容" --draft=false
  ```

**Release 文件：**
- `RimLetter-{版本}-x64.exe` — NSIS 安装程序（用户下载这个）
- `.exe.blockmap` — 增量更新映射（electron-updater 用）
- `latest.yml` — 自动更新元数据（electron-updater 用）

## 11. 网络环境（本机）

本机使用 **dev-sidecar** 代理（GitHub 加速）：
- Windows 系统代理：HTTP=`127.0.0.1:31180`，HTTPS=`127.0.0.1:31181`
- git 已全局配置：`http.proxy=127.0.0.1:31180`、`https.proxy=127.0.0.1:31181`、`http.sslBackend=schannel`（信任 dev-sidecar 的 MITM 证书）
- **gh（GitHub CLI）**：`C:\Program Files\GitHub CLI\gh.exe`（PATH 未刷新，用全路径）；调用需带代理：
  ```bash
  HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 gh ... 
  ```
- 本机 `npm run build`（electron-builder）会因 dev-sidecar 的 MITM 证书不被 Go 二进制信任而失败（`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`）。**CI 构建不受影响**，正式打包走 GitHub Actions。
- `.npmrc` 配置 `electron_mirror=https://npmmirror.com/mirrors/electron/`（国内镜像加速 electron 下载）

## 12. 素材提取

`scripts/extract_assets.py` 从游戏 `D:\SteamLibrary\steamapps\common\RimWorld` 提取：
- 22 张 UI 纹理 → `assets/raw/`（ButtonBG、GrayTextBG、CheckOn/Off、SliderRail/Handle、RadioButOn/Off、闪光特效、警告图标等）
- 5 张紧急度染色信 → `assets/letter/letter-{Severity}.png`（LetterUnopened 按 85% 强度染游戏紧急色，2x 放大）
- 6 个音效 → `assets/sounds/*.wav`（游戏音频是 FMOD .fsb，用 UnityPy 的 `samples` 属性解码为 WAV 才可播）

**关键经验：**
- Windows 上 Python 不认 git-bash 的 `/tmp`，必须用显式 Windows 绝对路径
- UnityPy 提取纹理用 `obj.read().image`；AudioClip 用 `d.samples`（返回 `{Name.wav: bytes}`）
- 素材版权归 Ludeon Studios，仅供个人使用

## 13. 游戏参考（反编译/Defs）

**Letter 播报行为**（Verse.Letter.DrawButtonAt）：
- 信按钮右上角 `x = 屏宽-38-12`，垂直堆叠间距 12，超容量折叠为 Bundle 聚合信
- 滑入：1s 内从上方 200px 坠落 + 淡入
- 径向闪光：每 flashInterval 秒扩散 `屏宽×0.6` 大小彩色闪光，亮度脉冲 ×0.55
- 弹跳：威胁级每 5s 横向抛物线弹跳（偏移 `屏宽×0.06`）
- 文字以图标中心为锚点居中、向两侧溢出，`GrayTextBG` 灰底
- 右键关闭、左键打开、悬停 330px 详情框

**紧急度配色**（Data/Core/Defs/Misc/LetterDefs/StandardLetters.xml）：
| 紧急度 | 主色 | 闪光色 | 闪间隔 |
|---|---|---|---|
| ThreatBig | (204,115,115) | (255,85,85) | 6 |
| ThreatSmall | (204,155,125) | (255,155,95) | 16 |
| NegativeEvent | (204,196,135) | (210,198,106) | 40 |
| NeutralEvent | (175,176,185) | (160,170,180) | 90 |
| PositiveEvent | (120,176,216) | (106,179,231) | 90 |

**窗口 UI 配色**（Verse.Widgets）：窗口填充 (21,25,29)、边框 (97,108,122)；菜单区 (42,43,44)/(135,135,135)。窗口不是米色，是深灰蓝。

## 14. 已知注意点

- GPU 温度依赖显卡驱动，读不到时优雅返回空（不报错）
- 文件路径用 UTF-8 时，HTML 需带 BOM 否则中文乱码（settings.html/overlay.html 已加）
- CSP 在 file:// 下会拦截本地脚本，已移除（本地应用无 CSP）
- 相对路径：渲染层在 `src/renderer/`，资源在项目根，用 `../../assets/`
- electron 二进制需手动放到 `node_modules/electron/dist/`（本机）；CI 自动下载
