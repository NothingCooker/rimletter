// src/main/letters.js
const { LETTERDEFS } = require('./letterdefs');
const { DEFAULT_CONFIG } = require('./config');

function formatLetter(severity, label, description, extra = {}, dismissMs = DEFAULT_CONFIG.autoDismissMs) {
  // 未知 severity 回退中性（如 HA 等外部 payload 传错值）：染色/音效/紧急度整体按 NeutralEvent，
  // 避免 def 为 undefined 抛错。severity 字段也写回有效值，渲染层观感一致。
  const eff = LETTERDEFS[severity] ? severity : 'NeutralEvent';
  const def = LETTERDEFS[eff];
  // sound 为空或 'auto'（哨兵：使用紧急度默认音效）时回退 def.sound，
  // 避免 triggerLetter 恒传 { sound: sound || undefined } 把默认音效覆盖成 undefined
  const { sound, ...rest } = extra;
  return {
    id: Math.random().toString(36).slice(2, 10),
    severity: eff,
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
