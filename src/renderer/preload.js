// src/renderer/preload.js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rimletter', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enable) => ipcRenderer.invoke('autostart:set', enable),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  setRules: (rules) => ipcRenderer.invoke('rules:set', rules),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  testLetter: (severity) => ipcRenderer.invoke('letter:test', severity),
  reloadPlugins: () => ipcRenderer.invoke('plugins:reload'),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  togglePlugin: (name, enabled) => ipcRenderer.invoke('plugins:toggle', name, enabled),
  previewPlugin: (name) => ipcRenderer.invoke('plugins:preview', name),
  openPluginsDir: () => ipcRenderer.invoke('plugins:dir'),
  getState: () => ipcRenderer.invoke('state:get'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  onLetter: (cb) => ipcRenderer.on('letter:new', (_e, letter) => cb(letter)),
  onOpenSettings: (cb) => ipcRenderer.on('settings:open', () => cb()),
  onConfigChange: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg)),
  setMouseOver: (over) => ipcRenderer.send('overlay:mouseover', over)
});
