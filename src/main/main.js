// src/main/main.js
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('node:path');
const { loadConfig, saveConfig } = require('./config');
const { createSensors } = require('./sensors');
const { createMonitor } = require('./monitor');
const { formatLetter } = require('./letters');
const { createApiServer } = require('./api');
const { loadPlugins } = require('./plugins');

let mainWindow = null;
let settingsWin = null;
let tray = null;
let config = null;
let configDir = null;
let monitor = null;
let apiServer = null;
let registry = { sensors: {}, customRules: [] };

const ASSETS = path.join(__dirname, '..', '..', 'assets');

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
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
  registry = { sensors: {}, customRules: [] };
  const pluginApi = makePluginApi();
  loadPlugins({
    pluginsDir: path.join(configDir, 'plugins'),
    apiFactory: () => pluginApi
  }).forEach(p => {
    if (p.error) console.error('[plugin:' + p.name + '] load error:', p.error);
    else console.log('[plugin:' + p.name + '] loaded');
  });

  if (monitor) monitor.stop();
  monitor = createMonitor({
    sensors: getSensors(),
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

function makePluginApi() {
  return {
    registerSensor(name, fn) { registry.sensors[name] = { name, read: fn }; },
    registerRule(r) {
      if (!r.id) r.id = 'plugin-' + Math.random().toString(36).slice(2, 8);
      registry.customRules.push(r);
    },
    letter(payload) { triggerLetter(payload); },
    on() {},
    getState: async () => { try { return await getSensors().snapshot(); } catch { return {}; } },
    setInterval(fn, ms) { return setInterval(fn, ms); },
    logger: { info: (...a) => console.log('[plugin]', ...a), warn: (...a) => console.warn('[plugin]', ...a), error: (...a) => console.error('[plugin]', ...a) }
  };
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
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.on('closed', () => { mainWindow = null; });
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
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

function createTray() {
  const iconPath = path.join(ASSETS, 'raw', 'LetterUnopened.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('RimLetter 边缘信使');
  tray.on('click', openSettings);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '⚙ 设置', click: openSettings },
    { label: '测试播报', click: () => triggerLetter({ severity: 'ThreatSmall', title: '测试播报', description: '这是一封测试信' }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

// ---- IPC ----
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (e, patch) => {
  config = { ...config, ...patch };
  saveConfig(configDir, config);
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
ipcMain.handle('plugins:reload', () => { reloadEverything(); return { sensors: Object.keys(registry.sensors), customRules: registry.customRules }; });
ipcMain.handle('plugins:list', () => {
  const fs = require('node:fs');
  const dir = path.join(configDir, 'plugins');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => ({ name: f.replace(/\.js$/, ''), file: f }));
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
ipcMain.on('overlay:mouseover', (e, over) => { if (mainWindow) mainWindow.setIgnoreMouseEvents(!over, { forward: true }); });

app.whenReady().then(() => {
  configDir = app.getPath('userData');
  config = loadConfig(configDir);
  createWindow();
  createTray();
  reloadEverything();

  if (config.api.enabled) {
    apiServer = createApiServer({
      token: config.api.token,
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
