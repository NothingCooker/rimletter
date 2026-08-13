// src/main/updater.js
// 封装 electron-updater 为状态机 + 加速通道回退。
// 不直接 require electron-updater，由上层注入，便于单测 mock。
function createUpdater(deps) {
  const {
    autoUpdater,
    onStatus = () => {},
    onDownloaded = () => {},
    isEnabled = () => true,
    checkDelayMs = 3000,
    proxyChannels = [],                 // 加速前缀列表，如 ['https://gh.ddlc.top']
    publishRepo = 'NothingCooker/rimletter'
  } = deps;

  let state = { code: 'idle' };
  let downloadedInfo = null;
  let checking = false;

  function setState(patch) { state = { ...state, ...patch }; onStatus(state); }
  function getState() { return { ...state }; }

  // 通道列表：每个加速前缀一个 generic feed，末尾追加原生 github feed
  function buildChannels() {
    const parts = publishRepo.split('/');
    const owner = parts[0], repo = parts[1];
    const channels = proxyChannels.map(base => ({
      label: base.replace(/^https?:\/\//, ''),
      apply: () => autoUpdater.setFeedURL({
        provider: 'generic',
        url: base + '/https://github.com/' + owner + '/' + repo + '/releases/latest/download'
      })
    }));
    channels.push({
      label: 'github',
      apply: () => autoUpdater.setFeedURL({ provider: 'github', owner, repo })
    });
    return channels;
  }

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
    autoUpdater.on('error', (err) => {
      // 检查阶段（checking=true）错误由 checkNow 的通道回退处理；
      // 下载阶段（checking=false）错误直接报错，不换通道。
      if (!checking) setState({ code: 'error', error: (err && err.message) || String(err) });
    });
  }

  function checkNow() {
    if (!isEnabled()) { setState({ code: 'disabled' }); return Promise.resolve(null); }
    if (checking) return Promise.resolve(null);
    checking = true;
    const channels = buildChannels();
    let idx = 0;
    function attempt() {
      const ch = channels[idx];
      try { ch.apply(); } catch (e) { /* setFeedURL 异常也视为该通道失败，继续回退 */ }
      setState({ code: 'checking', channel: ch.label });
      return autoUpdater.checkForUpdates()
        .then(() => { /* 成功：事件监听会置最终状态 */ })
        .catch((err) => {
          if (idx < channels.length - 1) { idx++; return attempt(); }
          setState({ code: 'error', error: (err && err.message) || String(err) });
        });
    }
    return attempt().finally(() => { checking = false; });
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
