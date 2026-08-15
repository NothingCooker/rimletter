// src/main/config.js
const fs = require('node:fs');
const path = require('node:path');

const SEVERITIES = ['ThreatBig', 'ThreatSmall', 'NegativeEvent', 'NeutralEvent', 'PositiveEvent'];

const DEFAULT_CONFIG = {
  pollIntervalMs: 2000,
  autoDismissMs: 20000,
  recoveryDismissMs: 10000,
  recoveryNotifications: true, // 是否播报「已恢复正常」信（关闭后告警状态仍正常复位，只是不再广播恢复信）
  api: { enabled: true, port: 17301, token: 'auto', host: '127.0.0.1', cors: false },
  // settings.alwaysOnTop：设置窗是否置顶（关闭后像普通窗口一样可被遮挡；覆盖层仍置顶不受影响）
  settings: { alwaysOnTop: true },
  // appearance.position：新信弹出位置。side 为上方（top）/ 下方（bottom），
  // 指新信出现在已有信堆栈的上方还是下方（bottom = 原版：最新信在堆栈最下方）；
  // offsetX/offsetY 为堆栈距右缘 / 上缘的边距（px）。letterGap 为信间距（px）。
  // 默认值与原版一致：右上角、右 26 上 64、间距 30、新信在下方。
  appearance: { iconSize: 64, position: { side: 'bottom', offsetX: 26, offsetY: 64 }, letterGap: 30 },
  sound: { enabled: true, volume: 0.25 },
  update: { enabled: true, proxyChannels: ['https://ghproxy.net', 'https://gh-proxy.com'], speedTest: true },
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

// 旧默认更新通道：gh.ddlc.top 已于 2026-08-14 起全站 HTTP 429 失效。
// 老用户 config.json 里若存的是这套旧默认值（从未自定义过通道），加载时自动迁移为新列表。
const OLD_UPDATE_CHANNELS = ['https://gh.ddlc.top', 'https://ghproxy.net'];

// 返回是否发生了迁移；调用方据此决定是否持久化。
function migrateConfig(cfg) {
  let changed = false;
  const channels = cfg && cfg.update && cfg.update.proxyChannels;
  if (Array.isArray(channels) && JSON.stringify(channels) === JSON.stringify(OLD_UPDATE_CHANNELS)) {
    cfg.update.proxyChannels = [...DEFAULT_CONFIG.update.proxyChannels];
    changed = true;
  }
  // 旧版 appearance.position.anchor 是四角落（top-right 等），现改为 side（新信在堆栈上方/下方），
  // 水平固定右侧。anchor 含 bottom 视为下方，其余视为上方。
  const pos = cfg && cfg.appearance && cfg.appearance.position;
  if (pos && pos.anchor && !pos.side) {
    pos.side = pos.anchor.indexOf('bottom') === 0 ? 'bottom' : 'top';
    delete pos.anchor;
    changed = true;
  }
  return changed;
}

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
      // 迁移必须在 deepMerge 之前对原始配置执行：
      // 否则新默认值（如 position.side）会被 merge 进旧配置，导致「用户没设置过」的
      // 判断失效（例：旧 anchor 四角落无法识别为待迁移项）。
      const migrated = migrateConfig(raw);
      const cfg = deepMerge(defaults, raw);
      if (migrated) saveConfig(dir, cfg);
      return cfg;
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

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig, SEVERITIES, migrateConfig, OLD_UPDATE_CHANNELS };
