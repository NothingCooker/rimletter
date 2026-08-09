// src/main/letters.js
const { LETTERDEFS } = require('./letterdefs');
const { DEFAULT_CONFIG } = require('./config');

function formatLetter(severity, label, description, extra = {}, dismissMs = DEFAULT_CONFIG.autoDismissMs) {
  const def = LETTERDEFS[severity];
  // sound 为空或 'auto'（哨兵：使用紧急度默认音效）时回退 def.sound，
  // 避免 triggerLetter 恒传 { sound: sound || undefined } 把默认音效覆盖成 undefined
  const { sound, ...rest } = extra;
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
    sound: (sound && sound !== 'auto') ? sound : def.sound,
    dismissMs,
    arrivedAt: Date.now(),
    ...rest
  };
}

module.exports = { formatLetter };
