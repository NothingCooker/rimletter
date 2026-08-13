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

test('下载阶段错误不换通道', async () => {
  const au = mockAutoUpdater({ failFirst: 0 });
  const seen = [];
  const updater = createUpdater({ autoUpdater: au, proxyChannels: ['https://p1'], publishRepo: 'o/r', onStatus: s => seen.push(s) });
  updater.init();
  await updater.checkNow(); // 检查成功
  const historyLen = au.feedHistory.length;
  au.emit('error', new Error('下载中断'));
  assert.equal(au.feedHistory.length, historyLen, '错误事件不触发换通道');
  assert.equal(seen[seen.length - 1].code, 'error');
});
