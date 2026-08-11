// src/main/overlayMouse.js
// 覆盖层鼠标穿透守卫（可注入依赖的小状态机，便于单测）。
//
// 背景：覆盖层平时整窗点击穿透（setIgnoreMouseEvents(true, {forward:true})），
// 鼠标悬停信件时才临时可交互。Windows 上 forward 切换可能丢失 mouseleave，
// 导致「可交互」状态残留 → 整个全屏透明窗口挡住所有点击（机器相关的锁死 bug）。
// 守卫在主进程周期性核对光标是否仍在任一信件矩形内，一旦不在就强制恢复穿透，
// 把任何残留的锁死自愈为最多一个轮询周期。
function createOverlayMouseGuard({
  setClickThrough,  // 恢复点击穿透（主进程调用 setIgnoreMouseEvents(true)）
  setInteractive,   // 进入可交互（主进程调用 setIgnoreMouseEvents(false)）
  getCursor,        // 返回 { x, y } 屏幕坐标（DIP）
  getLetterRects,   // 返回当前信件矩形列表 [{ x, y, w, h }]（屏幕坐标，DIP）
  intervalMs = 400  // 可交互期间核对周期
}) {
  let over = false;
  let timer = null;

  function pointInRect(cursor, r) {
    return r && cursor.x >= r.x && cursor.x <= r.x + r.w && cursor.y >= r.y && cursor.y <= r.y + r.h;
  }

  // 一个核对周期：光标已不在任何信件上 → 强制恢复穿透，返回 true（供调用方打日志/通知渲染层）
  function tick() {
    if (!over) return false;
    const cursor = getCursor();
    if (!cursor) return false; // 拿不到光标时保守保持现状，下一个周期再判
    const rects = getLetterRects();
    const stillOver = Array.isArray(rects) && rects.some(r => pointInRect(cursor, r));
    if (stillOver) return false;
    over = false;
    if (timer) { clearInterval(timer); timer = null; }
    setClickThrough();
    return true;
  }

  function start() {
    if (!timer) timer = setInterval(tick, intervalMs);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    // 渲染层报告悬停状态变化（mouseenter/mouseleave 或强制定位后的复位）
    onHover(hovering) {
      over = !!hovering;
      if (over) { setInteractive(); start(); }
      else { stop(); setClickThrough(); }
    },
    isInteractive() { return over; },
    tick,
    stop
  };
}

module.exports = { createOverlayMouseGuard };
