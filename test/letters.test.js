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

const { formatLetter, dismissMsFor } = require('../src/main/letters');

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

test('formatLetter 无自定义音效时回退到紧急度默认音效', () => {
  // 模拟 main.js triggerLetter 恒传 { sound: sound || undefined } 的路径
  const L = formatLetter('ThreatBig', 'CPU 占用过高', 'x', { sound: undefined });
  assert.equal(L.sound, 'LetterArrive_BadUrgentBig');
});

test('formatLetter 的 auto 哨兵解析为紧急度默认音效', () => {
  // 内置规则 sound 默认 'auto'，应解析成对应紧急度原声音效名，而不是当文件名播放 auto.wav
  const L = formatLetter('PositiveEvent', '恢复正常', 'x', { sound: 'auto' });
  assert.equal(L.sound, 'LetterArrive_Good');
});

test('formatLetter 自定义音效优先于紧急度默认', () => {
  const L = formatLetter('ThreatSmall', 'x', 'y', { sound: 'MyCustom' });
  assert.equal(L.sound, 'MyCustom');
});

test('formatLetter 未知 severity 回退 NeutralEvent（外部 payload 传错值不抛错）', () => {
  const L = formatLetter('BogusSeverity', 'x', 'y');
  assert.equal(L.severity, 'NeutralEvent');
  assert.equal(L.tintFile, 'letter-NeutralEvent.png');
  assert.equal(L.sound, 'LetterArrive');
  assert.equal(L.color, '175,176,185');
});

test('formatLetter 原型链键（constructor/__proto__）不误入，仍回退 NeutralEvent', () => {
  const L = formatLetter('constructor', 'x', 'y');
  assert.equal(L.severity, 'NeutralEvent');
  assert.equal(L.tintFile, 'letter-NeutralEvent.png');
  const L2 = formatLetter('__proto__', 'x', 'y');
  assert.equal(L2.severity, 'NeutralEvent');
});

test('dismissMsFor 显式 dismissMs 优先，否则告警/恢复信分别取 live 配置', () => {
  const cfg = { autoDismissMs: 20000, recoveryDismissMs: 10000 };
  assert.equal(dismissMsFor(cfg, {}), 20000);                 // 告警信 → autoDismissMs
  assert.equal(dismissMsFor(cfg, { recovery: true }), 10000); // 恢复信 → recoveryDismissMs
  assert.equal(dismissMsFor(cfg, { dismissMs: 5000 }), 5000);
  assert.equal(dismissMsFor(cfg, { dismissMs: 5000, recovery: true }), 5000);
});

test('dismissMsFor 配置缺失时回退 DEFAULT_CONFIG', () => {
  assert.equal(dismissMsFor({}, {}), 20000);
  assert.equal(dismissMsFor({}, { recovery: true }), 10000);
  assert.equal(dismissMsFor(undefined, {}), 20000);
});
