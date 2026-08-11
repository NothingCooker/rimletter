// src/main/overlayMouse.js
// 覆盖层鼠标穿透守卫（看门狗版，可注入依赖便于单测）。
//
// 背景：覆盖层平时整窗点击穿透（setIgnoreMouseEvents(true, {forward:true})），
// 鼠标悬停信件时才临时可交互。Windows 上 forward 切换可能丢失 mouseleave，
// 导致「可交互」状态残留 → 整个全屏透明窗口挡住所有点击（机器相关的锁死 bug）。
//
// 设计：悬停检测的权威放在渲染层（elementFromPoint，同一 CSS 像素空间，不受
// 跨进程坐标差异影响；主进程的 getCursorScreenPoint 在缩放/多屏下可能和 DOM
// rect 不在同一坐标空间）。主进程守卫只做：
//   1. 渲染层报告悬停 → 进入可交互；报告离开 → 恢复穿透（带状态切换防抖）
//   2. 看门狗：软超时（timeoutMs 无消息，渲染层崩溃兜底）+ 硬上限（hardCapMs，
//      无论渲染层如何保活，可交互状态至多持续这么久）→ 强制恢复穿透。
//      硬上限保证即使 forward 事件完全停摆、渲染层被陈旧坐标「骗」着持续保活，
//      也绝不可能永久锁死整屏。
function createOverlayMouseGuard({
  setClickThrough,  // 恢复点击穿透（主进程调用 setIgnoreMouseEvents(true)）
  setInteractive,   // 进入可交互（主进程调用 setIgnoreMouseEvents(false)）
  timeoutMs = 3000,  // 软超时：超过该时长无任何消息即强制穿透
  hardCapMs = 15000, // 硬上限：可交互状态至多持续这么久（结构性杜绝锁死）
  intervalMs = 1000, // 看门狗核对周期
  now = () => Date.now()
}) {
  let over = false;
  let timer = null;
  let lastMsgAt = null;
  let interactiveSince = null;

  function force() {
    over = false;
    stop();
    setClickThrough();
  }

  function tick() {
    if (!over) return false;
    // 硬上限优先：与渲染层保活无关，到点必强制穿透
    if (interactiveSince != null && now() - interactiveSince >= hardCapMs) {
      force();
      return true;
    }
    if (lastMsgAt == null) return false;
    if (now() - lastMsgAt < timeoutMs) return false;
    // 软超时：渲染层可能已无响应，强制恢复穿透（自愈）
    force();
    return true;
  }

  function start() {
    if (!timer) timer = setInterval(tick, intervalMs);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    // 渲染层报告悬停状态。重复报告同一状态（渲染层悬停中每 ~800ms 的 keepalive）
    // 只更新时间戳、不做多余切换；只有状态真切换才调用 setInteractive/setClickThrough，
    // 避免 setClickThrough 的「强制通知」与渲染层回执互相触发成 IPC 乒乓。
    onHover(hovering) {
      const wasOver = over;
      over = !!hovering;
      if (over) {
        lastMsgAt = now();
        if (!wasOver) { interactiveSince = now(); setInteractive(); }
        start();
      } else {
        stop();
        interactiveSince = null;
        if (wasOver) setClickThrough();
      }
    },
    isInteractive() { return over; },
    tick,
    stop
  };
}

module.exports = { createOverlayMouseGuard };
