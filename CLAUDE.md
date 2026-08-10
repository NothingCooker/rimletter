# RimLetter「边缘信使」项目记录

> **完整项目文档见 `PROJECT.md`**（仓库、发布流程、技术栈、配置、API、插件、环境等）

桌面功能性摆件：复刻《边缘世界》(RimWorld) 屏幕右侧的**信息播报（Letter 信件系统）**，硬件占用过高时信从屏幕右缘滑入提醒。

## 实现状态（2026-08-10 v0.2.6 发布）
- ✅ v0.2.6：插件配置新增 **button 字段类型** + `api.registerAction`（配置按钮/测试按钮），插件开发文档与 README 同步更新；56 单元测试通过（`npm test`）
- ✅ 全部 15 个任务完成，55 个单元测试通过（`npm test`）
- ✅ 应用可运行：`npm start`（透明覆盖层 + 托盘 + HTTP API + 插件系统）
- ✅ 素材已提取：`assets/raw/`(22 纹理)、`assets/letter/`(5 染色信)、`assets/sounds/`(6 游戏原声 WAV)
- ✅ 本地 API：http://127.0.0.1:17301（token 见 `%APPDATA%\rimletter\config.json`）
- ✅ 插件：userData/plugins/ 放 .js 即加载；插件管理页支持文档/预览/启用禁用；example 默认禁用
- ✅ 自动更新：electron-updater，启动静默检查 GitHub 新版，下载完用「信」通知，重启自动安装；设置 → 常规可关闭/立即检查/立即重启安装（`src/main/updater.js`）
- ✅ 信出现播放游戏原声音效（`formatLetter` 音效回退：空 / `auto` 哨兵解析为紧急度默认音效，`src/main/letters.js`）
- ✅ 点掉信后剩余信立即非线性上移补位（FLIP 动画，`src/renderer/overlay.js`）
- ✅ 默认音效音量 0.25；规则编辑器第一行不再出框（标签收窄 + 允许换行，`src/renderer/ui.css`）
- ✅ 开机自启开发模式修复：`npm start` 下显式传 app 路径，避免启动裸 electron（`src/main/autostart.js`）
- ✅ 用户视觉确认通过：信滑入/闪光/弹跳/文字观感、补位动画、设置页自动更新行
- ✅ 插件配置界面：插件可声明式注册配置表单（registerConfig/getConfig/on('config')，text/number/bool/select/slider 5 种字段），设置→插件管理内展开编辑，持久化到 config.json 的 pluginConfig 命名空间

## 代码结构
```
src/main/main.js        Electron 入口：透明窗+托盘+IPC+组装
src/main/config.js      配置（DEFAULT_CONFIG + deepMerge）
src/main/letterdefs.js  5 级紧急度定义（游戏数值）
src/main/letters.js     信对象格式化（含音效回退）
src/main/rules.js       规则引擎（纯函数，状态机/去重/恢复）
src/main/sensors.js     传感器（systeminformation，可注入 mock）
src/main/monitor.js     轮询服务（动态 snapshot 门面）
src/main/api.js         本地 HTTP API（token 鉴权）
src/main/plugins.js     插件加载器 + 配置纯函数（normalizeConfig/getPluginConfig）
src/main/updater.js     自动更新状态机（electron-updater 包装）
src/main/autostart.js   开机自启登录项参数（纯函数）
src/renderer/           覆盖层 + 设置窗口 + 环世界样式
scripts/extract_assets.py  素材提取管线
```

## Git 与仓库
- 远程仓库：https://github.com/NothingCooker/rimletter （公开，master 分支）
- 当前版本：**v0.2.6**（已发布；Releases 见 https://github.com/NothingCooker/rimletter/releases）
- GitHub CLI：`C:\Program Files\GitHub CLI\gh.exe`（PATH 未刷新，需全路径）
- 网络（dev-sidecar 代理）：Windows 系统代理 http=127.0.0.1:31180 / https=127.0.0.1:31181
- git 已配置：`http.proxy=127.0.0.1:31180`、`https.proxy=127.0.0.1:31181`、`http.sslBackend=schannel`（信任 dev-sidecar 的 MITM 证书）
- 推送需带代理：`HTTPS_PROXY=http://127.0.0.1:31181 HTTP_PROXY=http://127.0.0.1:31180 git push`
- gh 调用同样需带 HTTPS_PROXY

## 构建
- 本地 `npm run build` 可能因 dev-sidecar 代理干扰 app-builder（Go 二进制不信任 MITM 证书）而失败（`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`）
- **CI 构建不受影响**：GitHub Actions（.github/workflows/build.yml）在 push 到 master 时自动编译，产物在 Actions Artifacts 下载
- `.npmrc` 只保留 `electron_mirror`（国内镜像），无 skip-binary 配置

## 已知注意点
- GPU 温度依赖显卡驱动，读不到时优雅返回空（不报错）
- 游戏音频是 FMOD .fsb，用 UnityPy `samples` 解码为 WAV 才可播

## 技术栈
- **Electron**（本机 Node v24 / npm 11；无 Rust，不用 Tauri）
- 硬件监控：`systeminformation` npm 包
- 素材提取：Python + UnityPy（`pip install unitypy`）
- 反编译：ILSpy（`ilspycmd` dotnet tool，或 NuGet 解包到 `tools/net10.0/any/` 用 `dotnet xxx.dll` 运行）

## 已确认设计决策（用户拍板）
- 窗口：**全屏透明悬浮层**，透明/无边框/置顶/不进任务栏/鼠标穿透（仅信区域可交互）
- 呈现：平时隐身，告警才出现
- 监控：CPU / 内存 / 磁盘 / GPU + 可扩展规则表
- 信视觉：`LetterUnopened` 纹理按紧急度染色，图标 ~64×50
- **信文字：标题居中于图标中心、允许向两侧溢出**（游戏原版行为）
- 素材：全部用游戏解包原始 UI
- 设置窗口：完全参考环世界 UI，含**自定义规则/阈值管理**（增删改）
- 托盘图标：单击打开设置
- 音效：设置中可自定义（开关/音量/每级换音效）
- 扩展：本地 HTTP API（127.0.0.1 + token，其他程序触发播报/管规则）+ `plugins/` 手写 JS 插件（注册自定义传感器/规则/主动播报）

完整设计见 `docs/superpowers/specs/2026-08-09-rimletter-design.md`

## 游戏参考发现（反编译自 Assembly-CSharp.dll + Defs）
游戏路径：`D:\SteamLibrary\steamapps\common\RimWorld`

### Letter 播报行为（Verse.Letter.DrawButtonAt）
- 位置：右上角 `x = 屏宽-38-12`，垂直堆叠间距 12，超容量折叠为 Bundle 聚合信
- 滑入：1s 内从上方 200px 坠落 + 淡入
- 径向闪光：每 flashInterval 秒扩散 `屏宽×0.6` 大小彩色闪光，亮度脉冲 ×0.55
- 弹跳：威胁级每 5s 横向抛物线弹跳（偏移 `屏宽×0.06`）
- 文字以图标中心为锚点居中、溢出两侧，`GrayTextBG` 灰底
- 右键关闭、左键打开、悬停 330px 详情框

### LetterDef 紧急度配色（Data/Core/Defs/Misc/LetterDefs/StandardLetters.xml）
| 紧急度 | 主色 | 闪光色 | 闪间隔 |
|---|---|---|---|
| ThreatBig | (204,115,115) 红 | (255,85,85) | 6 |
| ThreatSmall | (204,155,125) 橙 | (255,155,95) | 16 |
| NegativeEvent | (204,196,135) 黄 | (210,198,106) | 40 |
| NeutralEvent | (175,176,185) 灰 | (160,170,180) | 90 |
| PositiveEvent | (120,176,216) 蓝 | (106,179,231) | 90 |

### 窗口 UI 配色（Verse.Widgets）
窗口填充 (21,25,29) / 边框 (97,108,122)；菜单区 (42,43,44)/(135,135,135)。**窗口不是米色，是深灰蓝**。

## 素材提取
- 已用 UnityPy 提取 78 张 UI/信/特效纹理（PNG），存于确认用临时目录 `C:\Users\Nothingbot\AppData\Local\Temp\rimtex\`
- 正式实现时：`scripts/extract_assets.py` 把清单纹理提取到 `assets/raw/`，音效到 `assets/sounds/`
- 注意：Python 在 Windows 上不认 git-bash 的 `/tmp` 路径，必须用显式 Windows 绝对路径

## 验证用的确认页面（浏览器）
- `broadcast-sim.html` — 播报动画模拟（滑入/闪光/弹跳/文字居中溢出）
- `ui-mockup.html` — 环世界风格设置窗口模拟（含规则页签）
- `letter-colors.html` — 五种紧急度信染色预览
- `gallery.html` — 全部解包素材图册

## 约定
- 拿不准的 UI 素材/观感先做成浏览器模拟让用户确认，不擅自决定
- 监控/规则引擎放主进程，渲染层只负责画播报
- 规则 = 传感器+指标+比较符+阈值+持续时长+紧急度+标题+描述+音效+启用，存 config.json
- **提交绝不加 `Co-Authored-By: Claude` 尾注**：GitHub 会把协作者计入仓库 Contributors，用户已要求把 @claude 移出（2026-08-09 重写 12 个 commit + 移动 tag 实现，见「Git 与仓库」）
