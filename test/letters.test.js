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

const { formatLetter } = require('../src/main/letters');

test('formatLetter 生成渲染层可用的信对象', () => {
  const L = formatLetter('ThreatBig', 'CPU 占用过高', 'CPU 已持续 85% 以上', { value: 92, threshold: 85 });
  assert.equal(L.severity, 'ThreatBig');
  assert.equal(L.tintFile, 'letter-ThreatBig.png');
  assert.equal(L.color, '204,115,115');
  assert.equal(L.flashColor, '255,85,85');
  assert.equal(L.bounce, true);
  assert.equal(L.dismissMs, 20000);
});

test('formatLetter 恢复类信使用 recoveryDismissMs', () => {
  const L = formatLetter('PositiveEvent', '恢复正常', 'x', {}, 10000);
  assert.equal(L.dismissMs, 10000);
});
