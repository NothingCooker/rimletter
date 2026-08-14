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
    publishRepo = 'NothingCooker/rimletter',
    speedTest = null,                   // 测速模块（src/main/speedtest.js）；null=禁用
    fetch = null,                       // 测速用 fetch；null=禁用
    arch = null,                        // process.arch，决定清单文件名
    isSpeedTestEnabled = () => false    // live 回调，读实时 config
  } = deps;

  let state = { code: 'idle' };
  let downloadedInfo = null;
  let checking = false; // 当前是否有 checkForUpdates 在飞行：error 事件据此区分检查/下载阶段
  let speedTesting = false; // 测速是否在飞行：防止 checkNow 重入
  let channels = [];    // 当前一轮尝试的通道列表
  let idx = 0;          // 当前尝试的通道下标

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

  function shouldSpeedTest() {
    return !!(speedTest && fetch && isSpeedTestEnabled());
  }

  // 对全部通道测速，返回按吞吐重排后的 channels；失败返回 null（保持原顺序）。
  // 永不 reject —— 内部捕获一切异常并 resolve null，保证更新检查不被阻断。
  function speedTestChannels() {
    let probeUrls;
    try {
      probeUrls = speedTest.buildChannelProbeUrls({ proxyChannels, publishRepo, arch });
    } catch (e) {
      return Promise.resolve(null);
    }
    if (!probeUrls.length) return Promise.resolve(null);
    setState({ code: 'speedtesting', current: 0, total: probeUrls.length });
    return Promise.all(probeUrls.map(p => speedTest.fetchManifest(fetch, p.manifestUrl, 5000)))
      .then(manifests => {
        const ok = manifests.find(m => m && m.ok);
        if (!ok) return null; // 清单都拉不到 → 跳过测速
        const path = ok.path;
        const total = probeUrls.length;
        let current = 0;
        const results = [];
        // 顺序测量避免带宽争抢导致测速失真，同时自然驱动「通道 x/n」进度
        return probeUrls.reduce((chain, p) => chain.then(() =>
          speedTest.measureThroughput(fetch, p.installBase + '/' + path, { chunkBytes: 1024 * 1024, timeoutMs: 5000 })
            .then(m => {
              current++;
              const r = { label: p.label, ...m };
              results.push(r);
              setState({ code: 'speedtesting', current, total, channel: p.label, mbps: m.ok ? m.mbps : undefined });
              return r;
            })
        ), Promise.resolve()).then(() => results);
      })
      .then(results => {
        if (!results || !results.length) return null;
        const byLabel = {};
        for (const r of results) byLabel[r.label] = r;
        return speedTest.rankChannels(channels, byLabel);
      })
      .catch(() => null);
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
      // 检查阶段（checking=true）错误由 attempt 的 onCheckFail 换通道处理；
      // 下载阶段（checking=false）错误也换下一通道重试（下载中断/连接失败同算通道失败）。
      if (checking) return;
      onDownloadFail(err);
    });
  }

  // 在当前通道上跑一次「检查 +（自动）下载」。
  function attempt() {
    const ch = channels[idx];
    let feedErr = null;
    try { ch.apply(); } catch (e) { feedErr = e; }
    if (feedErr) return onCheckFail(feedErr);
    checking = true;
    setState({ code: 'checking', channel: ch.label });
    return autoUpdater.checkForUpdates()
      .then(() => { checking = false; })
      .catch((err) => { checking = false; return onCheckFail(err); });
  }

  // 检查阶段失败：换下一通道重试。
  function onCheckFail(err) {
    if (idx < channels.length - 1) { idx++; return attempt(); }
    setState({ code: 'error', error: (err && err.message) || String(err) });
  }

  // 下载阶段失败：换下一通道重试（检查+下载整段重来）。
  function onDownloadFail(err) {
    if (idx < channels.length - 1) { idx++; attempt(); }
    else setState({ code: 'error', error: (err && err.message) || String(err) });
  }

  function checkNow() {
    if (!isEnabled()) { setState({ code: 'disabled' }); return Promise.resolve(null); }
    if (checking || speedTesting) return Promise.resolve(null);
    channels = buildChannels();
    idx = 0;
    if (!shouldSpeedTest()) return attempt();
    speedTesting = true;
    return speedTestChannels().then(reordered => {
      speedTesting = false;
      if (reordered && reordered.length) channels = reordered;
      return attempt();
    });
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
