// src/main/main.js
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('node:path');
const { loadConfig, saveConfig } = require('./config');
const { createOverlayMouseGuard } = require('./overlayMouse');
const { createSensors } = require('./sensors');
const { createMonitor } = require('./monitor');
const { formatLetter } = require('./letters');
const { createApiServer } = require('./api');
const { loadPlugins, assertSchema, normalizeConfig, getPluginConfig } = require('./plugins');
const { createUpdater } = require('./updater');
const { buildAutostartOptions } = require('./autostart');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let settingsWin = null;
let tray = null;
let config = null;
let configDir = null;
let monitor = null;
let apiServer = null;
let registry = { sensors: {}, customRules: [], pluginConfigs: {}, pluginConfigHandlers: {}, pluginActions: {} };
let lastPluginResults = [];
let updater = null;
let overlayGuard = null;      // 覆盖层鼠标穿透守卫（见 overlayMouse.js）

const ASSETS = path.join(__dirname, '..', '..', 'assets');

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendToSettings(channel, payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
}

function getEffectiveRules() {
  return [...config.rules, ...registry.customRules];
}

function getSensors() {
  const si = require('systeminformation');
  const base = createSensors({ si });
  const merged = { ...base };
  for (const [name, s] of Object.entries(registry.sensors)) {
    merged[name] = { name, read: s.read };
  }
  return merged;
}

function triggerLetter({ severity, title, description, sound }) {
  const letter = formatLetter(severity, title, description, { sound: sound || undefined });
  send('letter:new', letter);
}

function reloadEverything() {
  config = loadConfig(configDir);
  registry = { sensors: {}, customRules: [], pluginConfigs: {}, pluginConfigHandlers: {}, pluginActions: {} };
  const disabled = new Set((config.plugins && config.plugins.disabled) || []);
  const pluginResults = loadPlugins({
    pluginsDir: path.join(configDir, 'plugins'),
    apiFactory: name => makePluginApiFor(name),
    filter: name => !disabled.has(name)
  });
  pluginResults.then(list => {
    lastPluginResults = list;
    list.forEach(p => {
      if (p.error) console.error('[plugin:' + p.name + '] load error:', p.error);
      else console.log('[plugin:' + p.name + '] loaded');
    });
  }).catch(e => console.error('[plugin] load error:', e));

  if (monitor) monitor.stop();
  // 动态 snapshot 门面：每次轮询都读取最新传感器（含插件异步注册的）
  const dynamicSensors = { snapshot: () => getSensors().snapshot() };
  monitor = createMonitor({
    sensors: dynamicSensors,
    pollIntervalMs: config.pollIntervalMs,
    getRules: getEffectiveRules,
    onEvent: (e) => {
      if (e.type === 'alert') {
        triggerLetter({ severity: e.alert.severity, title: e.alert.label, description: e.alert.description, sound: e.alert.sound });
      } else if (e.type === 'recovery') {
        triggerLetter({ severity: 'PositiveEvent', title: e.recovery.label, description: e.recovery.description });
      }
    }
  });
  monitor.start();
}

function makePluginApiFor(name) {
  return {
    registerSensor(sensorName, fn) { registry.sensors[sensorName] = { name: sensorName, read: fn }; },
    registerRule(r) {
      if (!r.id) r.id = 'plugin-' + Math.random().toString(36).slice(2, 8);
      const i = registry.customRules.findIndex(x => x.id === r.id);
      if (i >= 0) registry.customRules[i] = r;
      else registry.customRules.push(r);
    },
    letter(payload) { triggerLetter(payload); },
    on(evt, cb) {
      if (typeof cb !== 'function') return;
      const m = registry.pluginConfigHandlers[name] || (registry.pluginConfigHandlers[name] = {});
      (m[evt] || (m[evt] = [])).push(cb);
    },
    getState: async () => { try { return await getSensors().snapshot(); } catch { return {}; } },
    setInterval(fn, ms) { return setInterval(fn, ms); },
    registerConfig(schema) {
      assertSchema(schema);
      registry.pluginConfigs[name] = schema;
    },
    getConfig() {
      return getPluginConfig(registry.pluginConfigs[name], config.pluginConfig && config.pluginConfig[name]);
    },
    // 配置表单 button 字段的动作处理：插件注册 action，设置窗点按钮时调用，返回文本显示在按钮旁
    registerAction(action, fn) {
      const m = registry.pluginActions[name] || (registry.pluginActions[name] = {});
      m[action] = fn;
    },
    logger: { info: (...a) => console.log('[plugin]', ...a), warn: (...a) => console.warn('[plugin]', ...a), error: (...a) => console.error('[plugin]', ...a) }
  };
}

function initUpdater() {
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true; // dev 模式用 dev-app-update.yml
  updater = createUpdater({
    autoUpdater,
    isEnabled: () => !!(config.update && config.update.enabled),
    onStatus: (st) => sendToSettings('update:status', st),
    onDownloaded: () => triggerLetter({
      severity: 'NeutralEvent',
      title: 'RimLetter 新版本已下载',
      description: '重启应用后自动安装；也可在设置 → 常规 → 点「立即重启安装」。'
    })
  });
  updater.init();
  updater.scheduleInitialCheck();
}

// 覆盖层鼠标穿透守卫：整窗平时点击穿透，悬停信件时临时可交互。
// Windows 上 forward 切换可能丢失 mouseleave，导致可交互状态残留、整屏被挡。
// 悬停检测权威在渲染层（elementFromPoint，同一坐标空间，规避跨进程坐标差异），
// 主进程只做状态切换 + 超时看门狗兜底（渲染层无响应时强制恢复穿透）。
function ensureOverlayGuard() {
  if (!overlayGuard) {
    overlayGuard = createOverlayMouseGuard({
      setClickThrough: () => {
        if (!mainWindow) return;
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
        // 同步渲染层复位悬停态，避免其内部 hovered 残留
        mainWindow.webContents.send('overlay:mouse-leave-force');
      },
      setInteractive: () => { if (mainWindow) mainWindow.setIgnoreMouseEvents(false, { forward: true }); },
      timeoutMs: 3000,
      intervalMs: 1000
    });
  }
  return overlayGuard;
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  mainWindow = new BrowserWindow({
    width, height,
    x: 0, y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, '..', 'renderer', 'preload.js'), contextIsolation: true }
  });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.once('ready-to-show', () => {
    // 透明无边框窗口有时不立即应用鼠标穿透（Windows 已知问题），首帧后再断言一次
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayGuard) { overlayGuard.stop(); overlayGuard = null; }
  });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 680,
    height: 640,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    backgroundColor: '#15191d',
    show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'renderer', 'preload.js'), contextIsolation: true }
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    // 与覆盖层同级置顶（screen-saver），保证设置窗在覆盖层之上、可正常点击
    settingsWin.setAlwaysOnTop(true, 'screen-saver');
    settingsWin.show();
    settingsWin.focus();
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

function createTray() {
  const iconPath = path.join(ASSETS, 'raw', 'LetterUnopened.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('RimLetter 边缘信使');
  tray.on('click', openSettings);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '设置', click: openSettings },
    { label: '测试播报', click: () => triggerLetter({ severity: 'ThreatSmall', title: '测试播报', description: '这是一封测试信' }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

// ---- IPC ----
ipcMain.handle('app:info', () => ({
  name: 'RimLetter 边缘信使',
  version: app.getVersion(),
  author: 'NothingCooker',
  authorUrl: 'https://github.com/NothingCooker',
  social: 'https://space.bilibili.com/514132068'
}));
ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('autostart:set', (e, enable) => {
  // 开发模式（npm start）execPath 是裸 electron.exe，需显式传 app 路径参数，
  // 否则开机启动的是裸 electron → 打开 Electron 欢迎页而非主程序
  app.setLoginItemSettings(buildAutostartOptions(enable, {
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath()
  }));
  return !!enable;
});
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (e, patch) => {
  config = { ...config, ...patch };
  saveConfig(configDir, config);
  send('config:changed', config);
  return config;
});
ipcMain.handle('config:reset', () => {
  const { DEFAULT_CONFIG } = require('./config');
  config = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), api: config.api }; // 保留已生成的 token
  saveConfig(configDir, config);
  reloadEverything();
  send('config:changed', config);
  return config;
});
ipcMain.handle('rules:set', (e, rules) => {
  config.rules = rules;
  saveConfig(configDir, config);
  send('config:changed', config);
  return config.rules;
});
ipcMain.handle('letter:test', (e, severity) => triggerLetter({ severity, title: '测试播报', description: '这是来自设置窗口的测试信' }));
ipcMain.handle('plugins:reload', () => { reloadEverything(); return { sensors: Object.keys(registry.sensors), customRules: registry.customRules, configs: Object.keys(registry.pluginConfigs) }; });
// 配置表单 button 字段：调用插件注册的 action，返回 { ok, result | error }
ipcMain.handle('plugins:action', async (e, name, action) => {
  const fn = (registry.pluginActions[name] || {})[action];
  if (typeof fn !== 'function') return { ok: false, error: '插件未注册该动作: ' + action };
  try {
    const result = await fn();
    return { ok: true, result: result == null ? '' : String(result) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
function setPluginConfig(name, values) {
  const schema = registry.pluginConfigs[name];
  if (!schema) return { ok: false, error: '插件无配置定义' };
  config.pluginConfig = config.pluginConfig || {};
  config.pluginConfig[name] = normalizeConfig(schema, values);
  saveConfig(configDir, config);
  const handlers = (registry.pluginConfigHandlers[name] || {})['config'] || [];
  for (const cb of handlers) {
    try { cb(config.pluginConfig[name]); } catch (e) { console.error('[plugin:' + name + '] config handler error:', e); }
  }
  send('config:changed', config);
  return { ok: true, values: config.pluginConfig[name] };
}

function getPluginList() {
  const fs = require('node:fs');
  const dir = path.join(configDir, 'plugins');
  if (!fs.existsSync(dir)) return [];
  const disabled = new Set((config.plugins && config.plugins.disabled) || []);
  const loadedMap = {};
  for (const p of lastPluginResults) loadedMap[p.name] = p;
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => {
    const name = f.replace(/\.js$/, '');
    const schema = registry.pluginConfigs[name] || null;
    return {
      name,
      file: f,
      enabled: !disabled.has(name),
      loaded: !!(loadedMap[name] && loadedMap[name].loaded),
      error: loadedMap[name] ? loadedMap[name].error : null,
      configSchema: schema,
      configValues: schema ? getPluginConfig(schema, config.pluginConfig && config.pluginConfig[name]) : null
    };
  });
}
ipcMain.handle('plugins:list', () => getPluginList());
ipcMain.handle('plugins:setConfig', (e, name, values) => setPluginConfig(name, values));
ipcMain.handle('plugins:toggle', (e, name, enabled) => {
  const disabled = (config.plugins && config.plugins.disabled) || [];
  if (enabled) config.plugins.disabled = disabled.filter(n => n !== name);
  else if (!disabled.includes(name)) config.plugins.disabled = [...disabled, name];
  saveConfig(configDir, config);
  reloadEverything();
  return getPluginList();
});
ipcMain.handle('plugins:preview', (e, name) => {
  const fs = require('node:fs');
  const fp = path.join(configDir, 'plugins', name + '.js');
  try { return { name, source: fs.readFileSync(fp, 'utf-8') }; }
  catch { return { name, source: '', error: '无法读取插件文件' }; }
});
ipcMain.handle('plugins:dir', () => {
  const fs = require('node:fs');
  const { shell } = require('electron');
  const dir = path.join(configDir, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return dir;
});
ipcMain.handle('state:get', async () => { try { return await getSensors().snapshot(); } catch { return {}; } });
ipcMain.handle('settings:close', () => { if (settingsWin) settingsWin.close(); });
ipcMain.on('overlay:mouseover', (e, over) => ensureOverlayGuard().onHover(over));
ipcMain.handle('update:state', () => updater ? updater.getState() : { code: 'idle' });
ipcMain.handle('update:check', () => updater ? updater.checkNow() : null);
ipcMain.handle('update:install', () => { if (updater) updater.quitAndInstall(); return true; });

app.whenReady().then(() => {
  configDir = app.getPath('userData');
  config = loadConfig(configDir);
  createWindow();
  createTray();
  reloadEverything();
  initUpdater();

  if (config.api.enabled) {
    apiServer = createApiServer({
      token: config.api.token,
      cors: config.api.cors,
      onLetter: triggerLetter,
      getState: async () => { try { return await getSensors().snapshot(); } catch { return {}; } },
      getRules: getEffectiveRules,
      addRule: (r) => { config.rules.push(r); saveConfig(configDir, config); return { ok: true }; },
      updateRule: (id, r) => { const i = config.rules.findIndex(x => x.id === id); if (i >= 0) config.rules[i] = { ...config.rules[i], ...r }; saveConfig(configDir, config); return { ok: true }; },
      deleteRule: (id) => { config.rules = config.rules.filter(x => x.id !== id); saveConfig(configDir, config); return { ok: true }; },
      reload: () => { reloadEverything(); return { ok: true }; }
    });
    apiServer.start(config.api.port);
    console.log('API 已启动 http://127.0.0.1:' + config.api.port + '  token=' + config.api.token);
  }
});

app.on('window-all-closed', () => { /* 常驻后台 */ });
app.on('before-quit', () => { if (monitor) monitor.stop(); if (apiServer) apiServer.stop(); });
