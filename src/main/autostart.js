// src/main/autostart.js
// 开机自启登录项参数构造（纯函数，便于单测）。
//
// Windows 开发模式（npm start）的 process.execPath 是裸 electron.exe，
// 若不显式带上 app 路径参数，开机启动的会是裸 electron → 打开 Electron 欢迎页而非主程序。
// （Windows/macOS 走 Electron app.setLoginItemSettings；其 @platform 标注为 darwin,win32，
//  Linux 不支持该 API，故 Linux 自启走 XDG autostart：写入 ~/.config/autostart/rimletter.desktop）
const nodeOs = require('node:os');
const nodePath = require('node:path');
const nodeFs = require('node:fs');

const LINUX_DESKTOP_FILE = 'rimletter.desktop';

function buildAutostartOptions(enable, { packaged, execPath, appPath, platform = process.platform }) {
  const openAtLogin = !!enable;
  const opts = { openAtLogin };
  if (openAtLogin && platform === 'win32' && !packaged) {
    opts.path = execPath;
    opts.args = [appPath];
  }
  return opts;
}

// ---- Linux XDG autostart（Electron setLoginItemSettings 不支持 Linux）----

// autostart .desktop 文件路径：优先 $XDG_CONFIG_HOME/autostart，缺省 ~/.config/autostart
function linuxAutostartPath({ homedir = nodeOs.homedir(), env = process.env } = {}) {
  const base = (env && env.XDG_CONFIG_HOME) || nodePath.join(homedir, '.config');
  return nodePath.join(base, 'autostart', LINUX_DESKTOP_FILE);
}

// desktop entry Exec 值引号：含空白/引号/反斜杠时按桌面规范加双引号转义
function quoteDesktopExec(s) {
  const str = String(s);
  return /[\s"\\]/.test(str) ? '"' + str.replace(/(["\\])/g, '\\$1') + '"' : str;
}

// 生成 XDG autostart .desktop 文件内容（纯函数）。打包应用 Exec 直指可执行文件；
// 开发模式（npm start）execPath 是裸 electron，需带上 app 路径参数。
function buildLinuxDesktopFile({ name = 'RimLetter', comment = 'RimLetter 边缘信使', execPath, args = [] }) {
  const exec = [execPath, ...args].map(quoteDesktopExec).join(' ');
  return '[Desktop Entry]\n' +
    'Type=Application\n' +
    'Version=1.0\n' +
    'Name=' + name + '\n' +
    (comment ? 'Comment=' + comment + '\n' : '') +
    'Exec=' + exec + '\n' +
    'Terminal=false\n' +
    'X-GNOME-Autostart-enabled=true\n';
}

// 读取 Linux 自启开关状态：.desktop 文件存在即视为开启
function getLinuxAutostartEnabled({ fs = nodeFs, homedir, env } = {}) {
  try { return fs.existsSync(linuxAutostartPath({ homedir, env })); } catch { return false; }
}

// 写入/删除 Linux 自启 .desktop 文件。返回是否成功生效。
function setLinuxAutostart(enable, { packaged, execPath, appPath, fs = nodeFs, homedir, env } = {}) {
  const file = linuxAutostartPath({ homedir, env });
  try {
    if (!enable) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return false;
    }
    const args = packaged ? [] : [appPath];
    const content = buildLinuxDesktopFile({ execPath, args });
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
    return true;
  } catch { return false; }
}

module.exports = { buildAutostartOptions, linuxAutostartPath, buildLinuxDesktopFile, getLinuxAutostartEnabled, setLinuxAutostart, quoteDesktopExec, LINUX_DESKTOP_FILE };
