const { test } = require('node:test');
const assert = require('node:assert');
const { createOverlayMouseGuard } = require('../src/main/overlayMouse');

// 可注入时钟，便于测试看门狗超时逻辑
function makeGuard(overrides = {}) {
  const calls = { clickThrough: 0, interactive: 0 };
  let t = 0;
  const guard = createOverlayMouseGuard({
    setClickThrough: () => { calls.clickThrough++; },
    setInteractive: () => { calls.interactive++; },
    timeoutMs: 3000,
    intervalMs: 1000,
    now: () => t,
    ...overrides
  });
  return { guard, calls, setNow: n => { t = n; } };
}

test('悬停进入可交互；重复 keepalive 不重复触发 setInteractive', (t) => {
  const g = makeGuard();
  g.guard.onHover(true);
  assert.strictEqual(g.calls.interactive, 1, '首次悬停应进入可交互');
  g.guard.onHover(true); // keepalive
  g.guard.onHover(true); // keepalive
  assert.strictEqual(g.calls.interactive, 1, '重复 keepalive 不应重复 setInteractive');
  assert.strictEqual(g.calls.clickThrough, 0);
  t.after(() => g.guard.stop());
});

test('正常离开恢复穿透，且只切换一次（不触发 IPC 乒乓）', (t) => {
  const g = makeGuard();
  g.guard.onHover(true);
  g.guard.onHover(false);
  assert.strictEqual(g.calls.clickThrough, 1);
  g.guard.onHover(false); // 渲染层收到强制通知后的回执，此时已是穿透态
  g.guard.onHover(false);
  assert.strictEqual(g.calls.clickThrough, 1, '重复 false 不应再次发穿透通知');
  assert.strictEqual(g.guard.isInteractive(), false);
  t.after(() => g.guard.stop());
});

test('看门狗：超时无消息（渲染层无响应）→ 强制恢复穿透', (t) => {
  const g = makeGuard();
  g.guard.onHover(true);
  g.setNow(1000); // 1s < 3s 超时
  assert.strictEqual(g.guard.tick(), false, '未超时不应强制');
  g.setNow(4000); // 4s > 3s 超时
  assert.strictEqual(g.guard.tick(), true, '超时应强制恢复穿透');
  assert.strictEqual(g.calls.clickThrough, 1);
  assert.strictEqual(g.guard.isInteractive(), false);
  t.after(() => g.guard.stop());
});

test('看门狗：keepalive 刷新时间戳，活跃悬停不被误杀', (t) => {
  const g = makeGuard();
  g.guard.onHover(true);
  // 渲染层每 ~800ms keepalive 一次
  g.setNow(800);  g.guard.onHover(true);
  g.setNow(1600); g.guard.onHover(true);
  g.setNow(2400); g.guard.onHover(true);
  g.setNow(3000); // 距上次 keepalive 仅 600ms
  assert.strictEqual(g.guard.tick(), false, 'keepalive 保持活跃，不应强制');
  assert.strictEqual(g.calls.clickThrough, 0);
  t.after(() => g.guard.stop());
});

test('硬上限：即使渲染层持续 keepalive 保活，到点也强制穿透（结构上杜绝锁死）', (t) => {
  const g = makeGuard();
  g.guard.onHover(true); // interactiveSince = 0
  // 渲染层一直保活（每 800ms keepalive），软超时永远不会触发
  for (let m = 800; m < 14000; m += 800) { g.setNow(m); g.guard.onHover(true); }
  // now = 13600 < hardCapMs(15000)
  assert.strictEqual(g.guard.tick(), false, '未到硬上限前保活有效');
  g.setNow(16000); // 超过 15000
  assert.strictEqual(g.guard.tick(), true, '硬上限到点必须强制穿透');
  assert.strictEqual(g.calls.clickThrough, 1);
  assert.strictEqual(g.guard.isInteractive(), false);
  t.after(() => g.guard.stop());
});

test('非交互状态 tick 不动作', (t) => {
  const g = makeGuard();
  assert.strictEqual(g.guard.tick(), false);
  assert.strictEqual(g.calls.clickThrough, 0);
  assert.strictEqual(g.guard.isInteractive(), false);
  t.after(() => g.guard.stop());
});

test('stop() 后不再周期核对', (t) => {
  const g = makeGuard();
  g.guard.onHover(true);
  g.guard.stop();
  g.setNow(100000);
  // 手工 tick 仍会检查并恢复（幂等），但 interval 已被清掉，事件循环可退出
  assert.strictEqual(g.guard.tick(), true);
  assert.strictEqual(g.calls.clickThrough, 1);
});
