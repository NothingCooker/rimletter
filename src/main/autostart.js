// src/main/autostart.js
// 开机自启登录项参数构造（纯函数，便于单测）。
// Windows 开发模式（npm start）的 process.execPath 是裸 electron.exe，
// 若不显式带上 app 路径参数，开机启动的会是裸 electron → 打开 Electron 欢迎页而非主程序。
function buildAutostartOptions(enable, { packaged, execPath, appPath, platform = process.platform }) {
  const openAtLogin = !!enable;
  const opts = { openAtLogin };
  if (openAtLogin && platform === 'win32' && !packaged) {
    opts.path = execPath;
    opts.args = [appPath];
  }
  return opts;
}

module.exports = { buildAutostartOptions };
