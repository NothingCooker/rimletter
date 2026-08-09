const { test } = require('node:test');
const assert = require('node:assert');
const { buildAutostartOptions } = require('../src/main/autostart');

const EXEC = 'D:\\dev\\node_modules\\electron\\dist\\electron.exe';
const APP = 'D:\\dev\\RIM DESKTOP';

test('开发模式(win32)开启自启时附带 electron + app 路径参数', () => {
  const opts = buildAutostartOptions(true, { packaged: false, execPath: EXEC, appPath: APP, platform: 'win32' });
  assert.deepEqual(opts, { openAtLogin: true, path: EXEC, args: [APP] });
});

test('打包应用开启自启时只传 openAtLogin（execPath 即应用本体）', () => {
  const opts = buildAutostartOptions(true, { packaged: true, execPath: EXEC, appPath: APP, platform: 'win32' });
  assert.deepEqual(opts, { openAtLogin: true });
});

test('关闭自启时不附带 path/args，且 openAtLogin 为 false', () => {
  const opts = buildAutostartOptions(false, { packaged: false, execPath: EXEC, appPath: APP, platform: 'win32' });
  assert.deepEqual(opts, { openAtLogin: false });
});

test('非 Windows 平台不附加 path/args', () => {
  const opts = buildAutostartOptions(true, { packaged: false, execPath: EXEC, appPath: APP, platform: 'darwin' });
  assert.deepEqual(opts, { openAtLogin: true });
});
