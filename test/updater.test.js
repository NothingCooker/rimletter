const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('../src/main/updater');

function mockAutoUpdater() {
  const au = new EventEmitter();
  au.checkForUpdates = () => { au.checkCalled = true; return Promise.resolve({}); };
  au.quitAndInstall = () => { au.quitCalled = true; };
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
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
