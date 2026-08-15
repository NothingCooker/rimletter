// src/renderer/overlay.js
const stack = document.getElementById('stack');
const tooltip = document.getElementById('tooltip');
let hoveredEl = null;   // 当前悬停的信件元素（全局布尔不够：dismiss 时要区分具体是哪封信）
let config = { sound: { enabled: true, volume: 0.7 }, appearance: { iconSize: 64 } };

// 悬停态变更：只在「同一封信」上切换，避免 A 消失时误复位 B 的悬停态
function setHovered(el, on) {
  if (on) {
    hoveredEl = el;
    window.rimletter.setMouseOver(true);
  } else if (hoveredEl === el) {
    hoveredEl = null;
    window.rimletter.setMouseOver(false);
  }
}

// 光标位置：window 级 mousemove 持续更新。forward 转发让窗口点击穿透时也能收到
// 坐标，因此这里始终是「当前光标位置」（渲染层同一 CSS 像素空间，无跨进程换算）。
let lastX = 0, lastY = 0;
window.addEventListener('mousemove', (e) => { lastX = e.clientX; lastY = e.clientY; });

// 自愈式悬停核对（悬停权威）：主进程不做跨进程几何比对——Windows 缩放/多屏下
// getCursorScreenPoint 与 getBoundingClientRect 坐标空间可能不一致，曾导致守卫误判、
// 悬停失效。渲染层用 elementFromPoint 在自身坐标空间周期性核对光标是否在信件上：
// 既是权威，也能兜底被丢弃的 mouseleave；悬停中每 ~800ms 发一次 keepalive 喂主进程看门狗。
let lastKeepaliveAt = 0;
function checkHover() {
  const target = document.elementFromPoint(lastX, lastY);
  const letter = target && target.closest ? target.closest('.letter') : null;
  if (letter) {
    if (hoveredEl !== letter) setHovered(letter, true);
    const now = Date.now();
    if (now - lastKeepaliveAt > 800) { lastKeepaliveAt = now; window.rimletter.setMouseOver(true); }
  } else if (hoveredEl) {
    setHovered(hoveredEl, false); // mouseleave 被丢弃时的兜底
  }
}
// 性能优化：悬停检测按需启停——无信件时停止 interval，避免空窗口每 250ms 做 elementFromPoint
let hoverCheckId = null;
function startHoverCheck() { if (!hoverCheckId) hoverCheckId = setInterval(checkHover, 250); }
function stopHoverCheck() { if (hoverCheckId) { clearInterval(hoverCheckId); hoverCheckId = null; } }

// 图标尺寸由 config.appearance.iconSize 驱动
const STYLE = document.createElement('style');
document.head.appendChild(STYLE);
function applyIconSize(px) {
  const size = Math.max(24, Math.min(160, Number(px) || 64));
  STYLE.textContent = '.letter .icon{width:' + size + 'px;height:' + Math.round(size * 50 / 64) + 'px}';
}

// 信堆栈位置由 config.appearance.position 驱动：堆栈固定在屏幕右侧，
// offsetX/offsetY 为距右缘 / 上缘的边距（px）。side（top/bottom）决定新信插到堆栈上方还是下方，
// 见 spawnLetter。inline 覆盖 ui.css 里的默认右上角。
function applyPosition(pos) {
  pos = pos || {};
  const ox = Math.max(0, Math.min(2000, Number(pos.offsetX) || 0));
  const oy = Math.max(0, Math.min(2000, Number(pos.offsetY) || 0));
  const s = stack.style;
  s.top = oy + 'px';
  s.right = ox + 'px';
  s.bottom = '';
  s.left = '';
  s.flexDirection = 'column';
  s.alignItems = 'flex-end';
}

// 信间距由 config.appearance.letterGap 驱动（px）
function applyLetterGap(px) {
  const gap = Math.max(0, Math.min(200, Number(px) == null ? 30 : px));
  stack.style.gap = gap + 'px';
}

function playSound(name) {
  if (!config.sound || config.sound.enabled === false) return;
  if (!name) return;
  const audio = new Audio('../../assets/sounds/' + name + '.wav');
  audio.volume = (config.sound.volume != null ? config.sound.volume : 0.7);
  audio.play().catch(() => { /* 音效缺失或不可用则静音 */ });
}

function spawnLetter(L) {
  startHoverCheck(); // 有信件才跑悬停检测
  // 新信弹出位置：side = top 插到堆栈上方（最新信在最上面），bottom 追加到堆栈下方（原版）
  const atTop = !!(config.appearance && config.appearance.position && config.appearance.position.side === 'top');
  const el = document.createElement('div');
  el.className = 'letter' + (L.bounce ? ' bounce' : '');
  el.innerHTML =
    '<div class="letter-inner">' +
    '<img class="icon" src="../../assets/letter/' + L.tintFile + '" draggable="false">' +
    '<div class="label"><div class="bg"></div><span>' + escapeHtml(L.label) + '</span></div>' +
    '</div>';
  if (atTop) {
    // 新信插到顶部，旧信被顶下——FLIP：记录旧位置 → 插入 → 过渡回原位
    const before = [...stack.children].map(l => [l, l.getBoundingClientRect().top]);
    stack.insertBefore(el, stack.firstChild);
    // Invert + Play：先固定回旧位置（视觉不动），再过渡回原位 = 旧信平滑下移补位
    requestAnimationFrame(() => {
      before.forEach(([l, top]) => {
        const d = top - l.getBoundingClientRect().top;
        if (!d) return;
        l.style.transition = 'none';
        l.style.transform = 'translateY(' + d + 'px)';
        void l.offsetHeight; // 强制重排，让初始 transform 生效
        l.style.transition = 'transform .4s cubic-bezier(.2,.8,.3,1.15)';
        l.style.transform = 'translateY(0)';
        l.addEventListener('transitionend', function done(e) {
          if (e.propertyName !== 'transform') return;
          l.style.transition = '';
          l.style.transform = '';
          l.removeEventListener('transitionend', done);
        });
      });
    });
  } else {
    stack.appendChild(el);
  }

  // 到达闪光 + 音效
  spawnFlash(L, el, L.flashColor, 0.55, 0.7);
  playSound(L.sound);

  // fall 动画结束后清除动画：forwards 填充会压制后续 FLIP 设置的 inline transform
  el.addEventListener('animationend', (e) => {
    if (e.animationName === 'fall') {
      el.style.animation = 'none';
      el.style.opacity = '1';
    }
  });

  // 周期性闪光（flashInterval 秒）
  const intervalId = setInterval(() => {
    if (!el.parentNode) { clearInterval(intervalId); return; }
    spawnFlash(L, el, L.flashColor, 0.3, 0.6);
  }, (L.flashInterval || 90) * 1000);

  // 交互
  el.addEventListener('mouseenter', () => { setHovered(el, true); });
  el.addEventListener('mouseleave', () => { setHovered(el, false); tooltip.classList.add('hidden'); });
  el.addEventListener('mousemove', (e) => showTooltip(e, L));
  el.addEventListener('click', () => dismiss(el, intervalId));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); playSound('Click'); dismiss(el, intervalId); });

  // 自动消失
  setTimeout(() => { if (el.parentNode) dismiss(el, intervalId); }, L.dismissMs || 20000);

  // 超出 6 封折叠为聚合提示（移除最老的一封：bottom 模式最老在顶部，top 模式最老在底部）
  while (stack.children.length > 6) {
    const oldest = atTop ? stack.lastChild : stack.firstChild;
    if (oldest === el) break;
    // 直接摘除不走 dismiss（无动画/音效），但要安全处理悬停态：
    // 否则光标停在被摘掉的信上时 mouseleave 永不触发 → 整屏锁死
    setHovered(oldest, false);
    oldest.remove();
  }
}

function spawnFlash(L, el, flashColor, peakAlpha, scale) {
  const flash = document.createElement('div');
  flash.className = 'flash';
  flash.style.background = 'radial-gradient(circle, rgba(' + flashColor + ',' + peakAlpha + ') 0%, rgba(' + flashColor + ',' + (peakAlpha * 0.3) + ') 40%, transparent 70%)';
  const iconEl = el.querySelector('.icon');
  const rect = iconEl ? iconEl.getBoundingClientRect() : el.getBoundingClientRect();
  flash.style.left = (rect.left + rect.width / 2) + 'px';
  flash.style.top = (rect.top + rect.height / 2) + 'px';
  const d = Math.max(window.innerWidth, window.innerHeight) * scale;
  flash.style.width = d + 'px';
  flash.style.height = d + 'px';
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 1000);
}

function dismiss(el, intervalId) {
  clearInterval(intervalId);
  setHovered(el, false); // 只复位「这一封」信的悬停态，别误动另一封被悬停的信
  tooltip.classList.add('hidden');

  // FLIP：记录其余信当前纵向位置
  const siblings = [...stack.children].filter(x => x !== el);
  const from = new Map(siblings.map(l => [l, l.getBoundingClientRect().top]));

  // 被点掉的信立即移出布局（让缺口马上合拢），用 fixed ghost 在原位淡出
  const rect = el.getBoundingClientRect();
  const ghost = el.cloneNode(true);
  ghost.classList.add('leaving');
  ghost.style.animation = ''; // 清掉克隆自原元素的 inline animation，让 .leaving 的 bye 生效
  ghost.style.opacity = '1';
  ghost.style.position = 'fixed';
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  ghost.style.width = el.offsetWidth + 'px';
  ghost.style.height = el.offsetHeight + 'px';
  ghost.style.margin = '0';
  ghost.style.zIndex = '20';
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  el.remove();
  // 性能优化：信件全部消失后停止悬停检测并通知主进程隐藏覆盖层窗口（空闲零合成开销）
  if (stack.children.length === 0) {
    stopHoverCheck();
    window.rimletter.notifyEmpty();
  }
  setTimeout(() => ghost.remove(), 520);

  // Invert：把其余信固定回旧位置（视觉不动）
  siblings.forEach(l => {
    const d = from.get(l) - l.getBoundingClientRect().top;
    if (d !== 0) l.style.transform = 'translateY(' + d + 'px)';
  });

  // Play：非线性过渡回原位 = 上移补位
  requestAnimationFrame(() => requestAnimationFrame(() => {
    siblings.forEach(l => {
      if (!l.style.transform) return;
      l.style.transition = 'transform .5s cubic-bezier(.2,.8,.3,1.15)';
      l.style.transform = 'translateY(0)';
      l.addEventListener('transitionend', function done(e) {
        if (e.propertyName !== 'transform') return;
        l.style.transition = '';
        l.style.transform = '';
        l.removeEventListener('transitionend', done);
      });
    });
  }));
}

function showTooltip(e, L) {
  tooltip.innerHTML =
    '<b>' + escapeHtml(L.label) + '</b>' +
    '<div class="m">' +
    (L.description ? '<div>' + escapeHtml(L.description) + '</div>' : '') +
    (L.value != null ? '<div>当前值：<b style="color:#fff">' + Math.round(L.value * 100) / 100 + '</b></div>' : '') +
    (L.threshold != null ? '<div>阈值：' + escapeHtml(L.operator) + ' ' + L.threshold + '</div>' : '') +
    '<div style="color:#7f8a96;margin-top:4px">点击/右键关闭 · ' + Math.round((L.dismissMs || 20000) / 1000) + ' 秒后自动消失</div>' +
    '</div>';
  tooltip.classList.remove('hidden');
  let x = e.clientX - 320, y = e.clientY - 20;
  if (x < 10) x = 10;
  if (y < 10) y = 10;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 接线 ----
window.rimletter.getConfig().then(cfg => {
  config = cfg;
  applyIconSize(cfg.appearance && cfg.appearance.iconSize);
  applyPosition(cfg.appearance && cfg.appearance.position);
  applyLetterGap(cfg.appearance && cfg.appearance.letterGap);
}).catch(() => {});
window.rimletter.onConfigChange(cfg => {
  config = cfg;
  applyIconSize(cfg.appearance && cfg.appearance.iconSize);
  applyPosition(cfg.appearance && cfg.appearance.position);
  applyLetterGap(cfg.appearance && cfg.appearance.letterGap);
});
window.rimletter.onLetter(L => spawnLetter(L));
// 主进程守卫（看门狗超时兜底）强制恢复穿透时，同步复位渲染层悬停态。
// 仅在确实悬停时才回发，避免与主进程的 setClickThrough 通知互相触发成 IPC 乒乓。
window.rimletter.onMouseLeaveForce(() => {
  const wasHovering = !!hoveredEl;
  if (hoveredEl) hoveredEl = null;
  if (wasHovering) window.rimletter.setMouseOver(false);
  tooltip.classList.add('hidden');
});
