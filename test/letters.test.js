const { test } = require('node:test');
const assert = require('node:assert');
const { LETTERDEFS, severityTint } = require('../src/main/letterdefs');

test('LETTERDEFS 含 5 级紧急度且颜色来自游戏', () => {
  assert.equal(LETTERDEFS.ThreatBig.color, '204,115,115');
  assert.equal(LETTERDEFS.ThreatBig.flashColor, '255,85,85');
  assert.equal(LETTERDEFS.ThreatBig.bounce, true);
  assert.equal(LETTERDEFS.ThreatBig.flashInterval, 6);
  assert.equal(LETTERDEFS.PositiveEvent.color, '120,176,216');
});

test('severityTint 返回对应染色图文件名', () => {
  assert.equal(severityTint('ThreatBig'), 'letter-ThreatBig.png');
  assert.throws(() => severityTint('Nope'));
});
