// src/main/config.js
const fs = require('node:fs');
const path = require('node:path');

const SEVERITIES = ['ThreatBig', 'ThreatSmall', 'NegativeEvent', 'NeutralEvent', 'PositiveEvent'];

const DEFAULT_CONFIG = {
  pollIntervalMs: 2000,
  autoDismissMs: 20000,
  recoveryDismissMs: 10000,
  recoveryNotifications: true, // 是否播报「已恢复正常」信（关闭后告警状态仍正常复位，只是不再广播恢复信）
  api: { enabled: true, port: 17301, token: 'auto', cors: false },
  appearance: { iconSize: 64 },
  sound: { enabled: true, volume: 0.25 },
  update: { enabled: true, proxyChannels: ['https://gh.ddlc.top', 'https://ghproxy.net'] },
  market: { repo: 'NothingCooker/rimletter-official-plugins', branch: 'main' },
  log: { level: 'info' }, // 日志级别：debug | info | warn | error
  plugins: { disabled: ['example'] }, // example 为演示插件，默认禁用，可在设置中启用
  rules: [
    { id: 'builtin-cpu', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 5000, severity: 'ThreatBig', label: 'CPU 占用过高', description: 'CPU 已持续 85% 以上超过 5 秒', sound: 'auto', enabled: true, recoverPct: 5 },
    { id: 'builtin-gpu-temp', sensor: 'gpu', metric: 'temp', operator: '>', threshold: 85, durationMs: 5000, severity: 'ThreatSmall', label: '显卡过热', description: 'GPU 温度已持续 85°C 以上', sound: 'auto', enabled: true, recoverPct: 5 },
    { id: 'builtin-gpu-load', sensor: 'gpu', metric: 'load', operator: '>', threshold: 95, durationMs: 5000, severity: 'ThreatSmall', label: '显卡满载', description: 'GPU 占用已持续 95% 以上', sound: 'auto', enabled: true, recoverPct: 5 },
    { id: 'builtin-mem', sensor: 'mem', metric: 'usedPct', operator: '>', threshold: 90, durationMs: 10000, severity: 'NegativeEvent', label: '内存吃紧', description: '内存占用率已持续 10 秒高于 90%', sound: 'auto', enabled: true, recoverPct: 5 },
    { id: 'builtin-disk', sensor: 'disk', metric: 'freeGB', operator: '<', threshold: 10, durationMs: 0, severity: 'NeutralEvent', label: '磁盘空间不足', description: '磁盘剩余空间不足 10GB', sound: 'auto', enabled: true, recoverPct: 5 }
  ]
};

function configPath(dir) {
  return path.join(dir, 'config.json');
}

function deepMerge(base, override) {
  if (override === undefined) return base;
  if (base && typeof base === 'object' && !Array.isArray(base) &&
      override && typeof override === 'object' && !Array.isArray(override)) {
    const out = { ...base };
    for (const k of Object.keys(override)) out[k] = deepMerge(base[k], override[k]);
    return out;
  }
  return override;
}

function loadConfig(dir) {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    if (fs.existsSync(configPath(dir))) {
      const raw = JSON.parse(fs.readFileSync(configPath(dir), 'utf-8'));
      return deepMerge(defaults, raw);
    }
  } catch (e) { /* 损坏则回退默认 */ }
  if (defaults.api.token === 'auto') {
    defaults.api.token = Math.random().toString(36).slice(2, 12);
    saveConfig(dir, defaults);
  }
  return defaults;
}

function saveConfig(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2), 'utf-8');
}

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig, SEVERITIES };
