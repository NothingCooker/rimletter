// src/main/updater.js
// 封装 electron-updater 为状态机。不直接 require electron-updater，由上层注入，便于单测 mock。
function createUpdater(deps) {
  const {
    autoUpdater,
    onStatus = () => {},
    onDownloaded = () => {},
    isEnabled = () => true,
    checkDelayMs = 3000
  } = deps;

  let state = { code: 'idle' };
  let downloadedInfo = null;
  let checking = false;

  function setState(patch) { state = { ...state, ...patch }; onStatus(state); }
  function getState() { return { ...state }; }

  function init() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // 退出应用时自动装已下载的更新
    autoUpdater.on('checking-for-update', () => setState({ code: 'checking' }));
    autoUpdater.on('update-available', (info) => setState({ code: 'update-available', version: info && info.version }));
    autoUpdater.on('update-not-available', () => setState({ code: 'uptodate' }));
    autoUpdater.on('download-progress', () => setState({ code: 'downloading' }));
    autoUpdater.on('update-downloaded', (info) => {
      downloadedInfo = info;
      setState({ code: 'downloaded', version: info && info.version });
      onDownloaded(info);
    });
    autoUpdater.on('error', (err) => setState({ code: 'error', error: (err && err.message) || String(err) }));
  }

  function checkNow() {
    if (!isEnabled()) { setState({ code: 'disabled' }); return Promise.resolve(null); }
    if (checking) return Promise.resolve(null);
    checking = true;
    setState({ code: 'checking' });
    return autoUpdater.checkForUpdates()
      .catch((err) => setState({ code: 'error', error: (err && err.message) || String(err) }))
      .finally(() => { checking = false; });
  }

  function scheduleInitialCheck() {
    setTimeout(() => { if (isEnabled()) checkNow(); }, checkDelayMs);
  }

  function quitAndInstall() {
    if (downloadedInfo) autoUpdater.quitAndInstall();
  }

  return { init, checkNow, scheduleInitialCheck, quitAndInstall, getState };
}

module.exports = { createUpdater };
