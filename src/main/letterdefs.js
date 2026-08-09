// src/main/letterdefs.js
// 数值取自游戏 Data/Core/Defs/Misc/LetterDefs/StandardLetters.xml
const LETTERDEFS = {
  ThreatBig:       { color: '204,115,115', flashColor: '255,85,85',   flashInterval: 6,  bounce: true,  tintFile: 'letter-ThreatBig.png',  sound: 'LetterArrive_BadUrgentBig' },
  ThreatSmall:     { color: '204,155,125', flashColor: '255,155,95',  flashInterval: 16, bounce: true,  tintFile: 'letter-ThreatSmall.png',  sound: 'LetterArrive_BadUrgent' },
  NegativeEvent:   { color: '204,196,135', flashColor: '210,198,106', flashInterval: 40, bounce: false, tintFile: 'letter-NegativeEvent.png', sound: 'LetterArrive_BadUrgentSmall' },
  NeutralEvent:    { color: '175,176,185', flashColor: '160,170,180', flashInterval: 90, bounce: false, tintFile: 'letter-NeutralEvent.png',  sound: 'LetterArrive' },
  PositiveEvent:   { color: '120,176,216', flashColor: '106,179,231', flashInterval: 90, bounce: false, tintFile: 'letter-PositiveEvent.png', sound: 'LetterArrive_Good' }
};

function severityTint(severity) {
  const def = LETTERDEFS[severity];
  if (!def) throw new Error('unknown severity: ' + severity);
  return def.tintFile;
}

module.exports = { LETTERDEFS, severityTint };
