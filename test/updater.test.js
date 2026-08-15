const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('../src/main/updater');

function mockAutoUpdater({ failFirst = 0 } = {}) {
  const au = new EventEmitter();
  let calls = 0;
  au.checkForUpdates = () => {
    calls++;
    au.checkCalled = true;
    if (calls <= failFirst) return Promise.reject(new Error('网络不可用'));
    return Promise.resolve({});
  };
  au.quitAndInstall = () => { au.quitCalled = true; };
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
  au.setFeedURL = (opts) => { (au.feedHistory = au.feedHistory || []).push(opts); };
  au.failFirst = failFirst;
  return au;
}

test('init 设置 autoDownload/autoInstallOnAppQuit 并挂接事件', () => {
  const au = mockAutoUpdater();
  const updater = createUpdater({ autoUpdater: au });
  updater.init();
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  assert.equal(au.listenerCount('update-downloaded'), 1);
});

test('disabled 时 checkNow 不调用 checkForUpdates 且状态为 disabled', async () => {
  const au = mockAutoUpdater();
  let status = null;
  const updater = createUpdater({ autoUpdater: au, isEnabled: () => false, onStatus: s => status = s });
  updater.init();
  const r = await updater.checkNow();
  assert.equal(au.checkCalled, undefined);
  assert.equal(status.code, 'disabled');
  assert.equal(r, null);
});

test('checkNow 置 checking，update-not-available 后置 uptodate', async () => {
  const au = mockAutoUpdater();
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, onStatus: s => seen.push(s) });
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.deepEqual(seen.map(s => s.code), ['checking', 'uptodate']);
});

test('update-available 记录版本号', () => {
  const au = mockAutoUpdater();
  let status = null;
  const updater = createUpdater({ autoUpdater: au, onStatus: s => status = s });
  updater.init();
  au.emit('update-available', { version: '0.2.3' });
  assert.equal(status.code, 'update-available');
  assert.equal(status.version, '0.2.3');
});

test('download-progress 置 downloading', () => {
  const au = mockAutoUpdater();
  let status = null;
  const updater = createUpdater({ autoUpdater: au, onStatus: s => status = s });
  updater.init();
  au.emit('download-progress', { percent: 50 });
  assert.equal(status.code, 'downloading');
});

test('update-downloaded 置 downloaded 并触发 onDownloaded', () => {
  const au = mockAutoUpdater();
  let status = null, got = null;
  const updater = createUpdater({ autoUpdater: au, onStatus: s => status = s, onDownloaded: info => got = info });
  updater.init();
  const info = { version: '0.2.3' };
  au.emit('update-downloaded', info);
  assert.equal(status.code, 'downloaded');
  assert.equal(got, info);
});

test('error 事件置 error 状态', () => {
  const au = mockAutoUpdater();
  let status = null;
  const updater = createUpdater({ autoUpdater: au, onStatus: s => status = s });
  updater.init();
  au.emit('error', new Error('网络不可用'));
  assert.equal(status.code, 'error');
  assert.ok(status.error.includes('网络不可用'));
});

test('未下载时 quitAndInstall 不调用，下载后调用', () => {
  const au = mockAutoUpdater();
  const updater = createUpdater({ autoUpdater: au });
  updater.init();
  updater.quitAndInstall();
  assert.equal(au.quitCalled, undefined);
  au.emit('update-downloaded', { version: '0.2.3' });
  updater.quitAndInstall();
  assert.equal(au.quitCalled, true);
});

test('首通道失败自动换下一通道并成功', async () => {
  const au = mockAutoUpdater({ failFirst: 1 });
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1', 'https://p2'], publishRepo: 'o/r', onStatus: s => seen.push(s) });
  updater.init();
  const p = updater.checkNow();
  // 等一个宏任务，让通道回退的微任务链先走完（回退到 p2、进入 checking 态）
  await new Promise(r => setTimeout(r, 0));
  au.emit('update-not-available');
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['generic', 'generic']);
  assert.deepEqual(au.feedHistory.map(f => f.url), [
    'https://p1/https://github.com/o/r/releases/latest/download',
    'https://p2/https://github.com/o/r/releases/latest/download'
  ]);
  assert.equal(seen[seen.length - 1].code, 'uptodate');
});

test('全部通道失败置 error，最后一个是原生 github', async () => {
  const au = mockAutoUpdater({ failFirst: 3 });
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1', 'https://p2'], publishRepo: 'o/r', onStatus: s => seen.push(s) });
  updater.init();
  const p = updater.checkNow();
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['generic', 'generic', 'github']);
  assert.equal(seen[seen.length - 1].code, 'error');
  assert.ok(seen[seen.length - 1].error.includes('网络不可用'));
});

test('无 proxyChannels 时只走原生 github feed', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const updater = createUpdater({ autoUpdater: au, publishRepo: 'o/r' });
  updater.init();
  await updater.checkNow();
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['github']);
});

test('下载阶段错误自动换下一通道重试并最终成功', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1', 'https://p2'], publishRepo: 'o/r', onStatus: s => seen.push(s) });
  updater.init();
  await updater.checkNow(); // 检查成功（p1）
  const beforeLen = au.feedHistory.length;
  au.emit('error', new Error('下载中断'));
  assert.equal(au.feedHistory.length, beforeLen + 1, '下载失败后换下一通道');
  assert.equal(seen[seen.length - 1].code, 'checking', '回退后对新通道重新检查');
  au.emit('update-not-available'); // 新通道检查结果
  assert.equal(seen[seen.length - 1].code, 'uptodate');
});

test('下载阶段全部通道失败置 error，且最后通道失败不再换通道', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', onStatus: s => seen.push(s) });
  updater.init();
  await updater.checkNow(); // p1 检查成功
  au.emit('error', new Error('下载中断')); // p1 下载失败 → 换 github
  await new Promise(r => setTimeout(r, 0)); // 等 github 检查微任务把 checking 复位
  const beforeLen = au.feedHistory.length; // p1 + github
  au.emit('error', new Error('下载中断2')); // github 下载失败 → 无剩余通道
  assert.equal(seen[seen.length - 1].code, 'error');
  assert.ok(seen[seen.length - 1].error.includes('下载中断2'));
  assert.equal(au.feedHistory.length, beforeLen, '最后通道失败不再换通道');
});

test('setFeedURL 抛错时视为该通道失败并换下一通道', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  // 首个通道的 setFeedURL 抛错
  let throwOnApply = true;
  au.setFeedURL = (opts) => {
    (au.feedHistory = au.feedHistory || []).push(opts);
    if (throwOnApply) { throwOnApply = false; throw new Error('bad feed url'); }
  };
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1', 'https://p2'], publishRepo: 'o/r', onStatus: s => seen.push(s) });
  updater.init();
  const p = updater.checkNow();
  await new Promise(r => setTimeout(r, 0));
  au.emit('update-not-available');
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['generic', 'generic'], '抛错后仍切到 p2');
  assert.equal(seen[seen.length - 1].code, 'uptodate');
});

test('测速开启时先测速，按吞吐重排后再检查', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const seen = [];
  let buildCalls = 0;
  const speedTest = {
    buildChannelProbeUrls: () => { buildCalls++; return [{ label: 'p1', manifestUrl: 'm1', installBase: 'b1' }, { label: 'github', manifestUrl: 'm2', installBase: 'b2' }]; },
    fetchManifest: async () => ({ ok: true, path: 'x.exe' }),
    measureThroughput: async (fetch, url) => ({ ok: true, mbps: url.startsWith('b1') ? 1 : 9 }),
    rankChannels: (channels, byLabel) => [...channels].sort((a, b) => (byLabel[b.label].mbps || -1) - (byLabel[a.label].mbps || -1))
  };
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', speedTest, fetch: async () => {}, isSpeedTestEnabled: () => true, onStatus: s => seen.push(s) });
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.ok(buildCalls >= 1, '应调用 buildChannelProbeUrls');
  assert.ok(seen.some(s => s.code === 'speedtesting'), '应出现 speedtesting 状态');
  assert.equal(au.feedHistory[0].provider, 'github', 'github 最快应最先被尝试');
});

test('测速整体失败时按原顺序继续检查', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const speedTest = {
    buildChannelProbeUrls: () => [{ label: 'p1', manifestUrl: 'm1', installBase: 'b1' }],
    fetchManifest: async () => ({ ok: false, error: 'HTTP 429' }),
    measureThroughput: async () => ({ ok: false }),
    rankChannels: (c, b) => c
  };
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', speedTest, fetch: async () => {}, isSpeedTestEnabled: () => true });
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['generic'], '测速失败仍按原顺序 p1 在前');
});

test('isSpeedTestEnabled false 时跳过测速', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  let built = false;
  const speedTest = {
    buildChannelProbeUrls: () => { built = true; return []; },
    fetchManifest: async () => ({ ok: false }),
    measureThroughput: async () => ({ ok: false }),
    rankChannels: c => c
  };
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', speedTest, fetch: async () => {}, isSpeedTestEnabled: () => false });
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.equal(built, false, '关闭时不测速');
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['generic']);
});

test('测速开启时把 platform 传给 buildChannelProbeUrls（Linux 清单名平台化）', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  let gotPlatform = null;
  const speedTest = {
    buildChannelProbeUrls: (opts) => { gotPlatform = opts.platform; return [{ label: 'github', manifestUrl: 'm2', installBase: 'b2' }]; },
    fetchManifest: async () => ({ ok: true, path: 'x' }),
    measureThroughput: async () => ({ ok: true, mbps: 5 }),
    rankChannels: (c) => c
  };
  const updater = createUpdater({ autoUpdater: au, publishRepo: 'o/r', platform: 'linux', speedTest, fetch: async () => {}, isSpeedTestEnabled: () => true });
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.equal(gotPlatform, 'linux');
});

test('未注入 speedTest 时不测速直接检查', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const updater = createUpdater({ autoUpdater: au, isSpeedTestEnabled: () => true }); // 无 speedTest/fetch
  updater.init();
  const p = updater.checkNow();
  au.emit('update-not-available');
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['github']);
});

test('测速重排后最快通道失败时换下一通道', async () => {
  const au = mockAutoUpdater({ failFirst: 1 }); // 重排后第一个尝试的通道（github）检查失败
  const speedTest = {
    buildChannelProbeUrls: () => [{ label: 'p1', manifestUrl: 'm1', installBase: 'b1' }, { label: 'github', manifestUrl: 'm2', installBase: 'b2' }],
    fetchManifest: async () => ({ ok: true, path: 'x.exe' }),
    measureThroughput: async (fetch, url) => ({ ok: true, mbps: url.startsWith('b1') ? 1 : 9 }),
    rankChannels: (channels, byLabel) => [...channels].sort((a, b) => (byLabel[b.label].mbps || -1) - (byLabel[a.label].mbps || -1))
  };
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', speedTest, fetch: async () => {}, isSpeedTestEnabled: () => true });
  updater.init();
  const p = updater.checkNow();
  await new Promise(r => setTimeout(r, 0)); // 等微任务链：测速→重排→github 检查失败→换 p1
  au.emit('update-not-available'); // p1 检查成功
  await p;
  assert.deepEqual(au.feedHistory.map(f => f.provider), ['github', 'generic'], 'github 检查失败后换 p1');
});
