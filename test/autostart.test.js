const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { buildAutostartOptions, linuxAutostartPath, buildLinuxDesktopFile, getLinuxAutostartEnabled, setLinuxAutostart, quoteDesktopExec } = require('../src/main/autostart');

const EXEC = 'D:\\dev\\node_modules\\electron\\dist\\electron.exe';
const APP = 'D:\\dev\\RIM DESKTOP';

// 期望路径用 path.join 拼（函数内部用平台原生分隔符，Windows 下为反斜杠）
const P = (...parts) => path.join(...parts);

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

// ---- Linux XDG autostart（Electron setLoginItemSettings 不支持 Linux，改 .desktop 文件）----

test('linuxAutostartPath 缺省走 ~/.config/autostart', () => {
  assert.equal(
    linuxAutostartPath({ homedir: '/home/user', env: {} }),
    P('/home/user', '.config', 'autostart', 'rimletter.desktop')
  );
});

test('linuxAutostartPath 优先 $XDG_CONFIG_HOME', () => {
  assert.equal(
    linuxAutostartPath({ homedir: '/home/user', env: { XDG_CONFIG_HOME: '/custom/cfg' } }),
    P('/custom/cfg', 'autostart', 'rimletter.desktop')
  );
});

test('quoteDesktopExec 无特殊字符不加引号，含空格/引号时转义加引号', () => {
  assert.equal(quoteDesktopExec('/opt/RimLetter/rimletter'), '/opt/RimLetter/rimletter');
  assert.equal(quoteDesktopExec('/home/u/My App/rim'), '"/home/u/My App/rim"');
  assert.equal(quoteDesktopExec('/a"b\\c'), '"/a\\"b\\\\c"');
});

test('buildLinuxDesktopFile 打包应用 Exec 直指可执行文件', () => {
  const content = buildLinuxDesktopFile({ execPath: '/opt/RimLetter/rimletter', args: [] });
  assert.ok(content.includes('Type=Application'));
  assert.ok(content.includes('Name=RimLetter'));
  assert.ok(content.includes('Exec=/opt/RimLetter/rimletter'));
  assert.ok(content.includes('X-GNOME-Autostart-enabled=true'));
});

test('buildLinuxDesktopFile 开发模式（裸 electron）Exec 附带 app 路径参数', () => {
  const content = buildLinuxDesktopFile({ execPath: '/usr/lib/electron/electron', args: ['/home/u/rimletter'] });
  assert.ok(content.includes('Exec=/usr/lib/electron/electron /home/u/rimletter'));
});

test('buildLinuxDesktopFile 路径含空格时 Exec 加引号', () => {
  const content = buildLinuxDesktopFile({ execPath: '/home/u/My Downloads/RimLetter.AppImage', args: [] });
  assert.ok(content.includes('Exec="/home/u/My Downloads/RimLetter.AppImage"'));
});

test('getLinuxAutostartEnabled 以 .desktop 文件存在与否判定开关', () => {
  const fs = { existsSync: (p) => p.endsWith('rimletter.desktop') };
  assert.equal(getLinuxAutostartEnabled({ fs, homedir: '/home/u', env: {} }), true);
  const fs2 = { existsSync: () => false };
  assert.equal(getLinuxAutostartEnabled({ fs: fs2, homedir: '/home/u', env: {} }), false);
});

test('setLinuxAutostart(true) 写入 .desktop 文件（打包应用，无 app 路径参数）', () => {
  const written = {};
  const fs = {
    mkdirSync: (d) => { written.dir = d; },
    writeFileSync: (f, c) => { written.file = f; written.content = c; },
    existsSync: () => false
  };
  const ok = setLinuxAutostart(true, { packaged: true, execPath: '/opt/RimLetter/rimletter', fs, homedir: '/home/u', env: {} });
  assert.equal(ok, true);
  assert.equal(written.dir, P('/home/u', '.config', 'autostart'));
  assert.equal(written.file, P('/home/u', '.config', 'autostart', 'rimletter.desktop'));
  assert.ok(written.content.includes('Exec=/opt/RimLetter/rimletter'));
});

test('setLinuxAutostart(true) 开发模式（裸 electron）写入带 app 路径参数', () => {
  const written = {};
  const fs = {
    mkdirSync: () => {},
    writeFileSync: (f, c) => { written.content = c; },
    existsSync: () => false
  };
  setLinuxAutostart(true, { packaged: false, execPath: '/usr/lib/electron/electron', appPath: '/home/u/rimletter', fs, homedir: '/home/u', env: {} });
  assert.ok(written.content.includes('Exec=/usr/lib/electron/electron /home/u/rimletter'));
});

test('setLinuxAutostart(false) 删除 .desktop 文件并返回 false', () => {
  let unlinked = false;
  const fs = {
    existsSync: () => true,
    unlinkSync: (f) => { unlinked = f; },
    mkdirSync: () => {},
    writeFileSync: () => {}
  };
  const ok = setLinuxAutostart(false, { fs, homedir: '/home/u', env: {} });
  assert.equal(ok, false);
  assert.equal(unlinked, P('/home/u', '.config', 'autostart', 'rimletter.desktop'));
});

test('setLinuxAutostart 写入失败返回 false（不抛）', () => {
  const fs = {
    existsSync: () => false,
    mkdirSync: () => { throw new Error('EACCES'); },
    writeFileSync: () => {},
    unlinkSync: () => {}
  };
  assert.equal(setLinuxAutostart(true, { packaged: true, execPath: '/x', fs, homedir: '/home/u', env: {} }), false);
});
