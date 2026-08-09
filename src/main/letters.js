// src/main/letters.js
const { LETTERDEFS } = require('./letterdefs');
const { DEFAULT_CONFIG } = require('./config');

function formatLetter(severity, label, description, extra = {}, dismissMs = DEFAULT_CONFIG.autoDismissMs) {
  const def = LETTERDEFS[severity];
  return {
    id: Math.random().toString(36).slice(2, 10),
    severity,
    label,
    description,
    tintFile: def.tintFile,
    color: def.color,
    flashColor: def.flashColor,
    flashInterval: def.flashInterval,
    bounce: def.bounce,
    sound: def.sound,
    dismissMs,
    arrivedAt: Date.now(),
    ...extra
  };
}

module.exports = { formatLetter };
