const { test } = require('node:test');
const assert = require('node:assert');
const { createOverlayMouseGuard } = require('../src/main/overlayMouse');

function makeGuard({ cursor = { x: 100, y: 100 }, rects = [] } = {}) {
  const calls = { clickThrough: 0, interactive: 0 };
  let cur = cursor;
  let letters = rects;
  const guard = createOverlayMouseGuard({
    setClickThrough: () => { calls.clickThrough++; },
    setInteractive: () => { calls.interactive++; },
    getCursor: () => cur,
    getLetterRects: () => letters,
    intervalMs: 50
  });
  return { guard, calls, setCursor: c => { cur = c; }, setRects: r => { letters = r; } };
}

// 守卫可交互期间有内部 interval，测试结束必须 stop()，否则进程不退出
function withGuard(t, opts) {
  const g = makeGuard(opts);
  t.after(() => g.guard.stop());
  return g;
}

test('悬停信件时进入可交互，光标仍在信件内则不强制恢复', (t) => {
  const g = withGuard(t, { cursor: { x: 30, y: 30 }, rects: [{ x: 0, y: 0, w: 64, h: 50 }] });
  g.guard.onHover(true);
  assert.strictEqual(g.calls.interactive, 1, '悬停 → 应进入可交互');
  assert.strictEqual(g.calls.clickThrough, 0, '悬停时不应触发穿透');
  const forced = g.guard.tick();
  assert.strictEqual(forced, false, '光标仍在信件内 → 不强制恢复');
  assert.strictEqual(g.calls.clickThrough, 0);
});

test('光标离开信件区域（mouseleave 被丢弃的场景）→ tick 强制恢复穿透', (t) => {
  const g = withGuard(t, { cursor: { x: 30, y: 30 }, rects: [{ x: 0, y: 0, w: 64, h: 50 }] });
  g.guard.onHover(true);
  g.setCursor({ x: 500, y: 500 }); // 光标已移到屏幕别处，但 mouseleave 事件丢了
  const forced = g.guard.tick();
  assert.strictEqual(forced, true, '光标不在任何信件上 → 应强制恢复');
  assert.strictEqual(g.calls.clickThrough, 1);
  assert.strictEqual(g.guard.isInteractive(), false, '强制恢复后不再可交互');
});

test('光标在多个信件之一上时保持可交互', (t) => {
  const g = withGuard(t, { cursor: { x: 200, y: 100 }, rects: [
    { x: 0, y: 0, w: 64, h: 50 },
    { x: 180, y: 80, w: 64, h: 50 }
  ] });
  g.guard.onHover(true);
  assert.strictEqual(g.guard.tick(), false);
  assert.strictEqual(g.calls.clickThrough, 0);
});

test('无信件矩形时强制恢复（防止悬停态残留时无参照物）', (t) => {
  const g = withGuard(t, { cursor: { x: 30, y: 30 }, rects: [] });
  g.guard.onHover(true);
  assert.strictEqual(g.guard.tick(), true);
  assert.strictEqual(g.calls.clickThrough, 1);
});

test('onHover(false)（正常 mouseleave）直接恢复穿透并停表', (t) => {
  const g = withGuard(t, { cursor: { x: 30, y: 30 }, rects: [{ x: 0, y: 0, w: 64, h: 50 }] });
  g.guard.onHover(true);
  g.guard.onHover(false);
  assert.strictEqual(g.calls.clickThrough, 1);
  assert.strictEqual(g.guard.isInteractive(), false);
  assert.strictEqual(g.guard.tick(), false, '停表后 tick 不再触发恢复');
});

test('矩形边界判定为闭区间（光标在边界上算在信件内）', (t) => {
  const g = withGuard(t, { cursor: { x: 64, y: 50 }, rects: [{ x: 0, y: 0, w: 64, h: 50 }] });
  g.guard.onHover(true);
  assert.strictEqual(g.guard.tick(), false, '右/下边界应算在内');
  g.setCursor({ x: 65, y: 50 });
  assert.strictEqual(g.guard.tick(), true, '越过右边界应强制恢复');
});

test('stop() 后不再周期核对（interval 被清掉）', (t) => {
  const g = withGuard(t, { cursor: { x: 500, y: 500 }, rects: [{ x: 0, y: 0, w: 64, h: 50 }] });
  g.guard.onHover(true);
  g.guard.stop();
  // 手工 tick 仍会检查并恢复（幂等），但 interval 已被清掉，事件循环可退出
  assert.strictEqual(g.guard.tick(), true);
  assert.strictEqual(g.calls.clickThrough, 1);
});
