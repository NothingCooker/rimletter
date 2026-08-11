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

// 上报所有信件矩形给主进程守卫（节流）。窗口铺满主屏且通常位于 (0,0)，
// 为兼容多屏/偏移，加 screenX/screenY 换算为屏幕坐标（DIP，与 getCursorScreenPoint 一致）。
let rectTimer = null;
function reportRectsSoon() {
  if (rectTimer) return;
  rectTimer = setTimeout(() => {
    rectTimer = null;
    const ox = window.screenX || 0, oy = window.screenY || 0;
    const rects = [...stack.children].map(el => {
      const r = el.getBoundingClientRect();
      return { x: r.left + ox, y: r.top + oy, w: r.width, h: r.height };
    });
    window.rimletter.setLetterRects(rects);
  }, 100);
}

// 图标尺寸由 config.appearance.iconSize 驱动
const STYLE = document.createElement('style');
document.head.appendChild(STYLE);
function applyIconSize(px) {
  const size = Math.max(24, Math.min(160, Number(px) || 64));
  STYLE.textContent = '.letter .icon{width:' + size + 'px;height:' + Math.round(size * 50 / 64) + 'px}';
}

function playSound(name) {
  if (!config.sound || config.sound.enabled === false) return;
  if (!name) return;
  const audio = new Audio('../../assets/sounds/' + name + '.wav');
  audio.volume = (config.sound.volume != null ? config.sound.volume : 0.7);
  audio.play().catch(() => { /* 音效缺失或不可用则静音 */ });
}

function spawnLetter(L) {
  const el = document.createElement('div');
  el.className = 'letter' + (L.bounce ? ' bounce' : '');
  el.innerHTML =
    '<div class="letter-inner">' +
    '<img class="icon" src="../../assets/letter/' + L.tintFile + '" draggable="false">' +
    '<div class="label"><div class="bg"></div><span>' + escapeHtml(L.label) + '</span></div>' +
    '</div>';
  stack.appendChild(el);
  reportRectsSoon();

  // 到达闪光 + 音效
  spawnFlash(L, el, L.flashColor, 0.55, 0.7);
  playSound(L.sound);

  // fall 动画结束后清除动画：forwards 填充会压制后续 FLIP 设置的 inline transform
  el.addEventListener('animationend', (e) => {
    if (e.animationName === 'fall') {
      el.style.animation = 'none';
      el.style.opacity = '1';
      reportRectsSoon();
    }
  });

  // 周期性闪光（flashInterval 秒）
  const intervalId = setInterval(() => {
    if (!el.parentNode) { clearInterval(intervalId); return; }
    spawnFlash(L, el, L.flashColor, 0.3, 0.6);
  }, (L.flashInterval || 90) * 1000);

  // 交互
  el.addEventListener('mouseenter', () => { setHovered(el, true); reportRectsSoon(); });
  el.addEventListener('mouseleave', () => { setHovered(el, false); tooltip.classList.add('hidden'); reportRectsSoon(); });
  el.addEventListener('mousemove', (e) => { showTooltip(e, L); reportRectsSoon(); });
  el.addEventListener('click', () => dismiss(el, intervalId));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); playSound('Click'); dismiss(el, intervalId); });

  // 自动消失
  setTimeout(() => { if (el.parentNode) dismiss(el, intervalId); }, L.dismissMs || 20000);

  // 超出 6 封折叠为聚合提示
  while (stack.children.length > 6) {
    const first = stack.firstChild;
    if (first === el) break;
    // 直接摘除不走 dismiss（无动画/音效），但要安全处理悬停态：
    // 否则光标停在被摘掉的信上时 mouseleave 永不触发 → 整屏锁死
    setHovered(first, false);
    first.remove();
  }
  reportRectsSoon();
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
  reportRectsSoon();
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
        reportRectsSoon(); // FLIP 结束后信件已移到新位置，更新守卫用矩形
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
}).catch(() => {});
window.rimletter.onConfigChange(cfg => {
  config = cfg;
  applyIconSize(cfg.appearance && cfg.appearance.iconSize);
});
window.rimletter.onLetter(L => spawnLetter(L));
// 主进程守卫检测到光标已不在信件上（mouseleave 可能被丢弃）时，强制同步复位渲染层悬停态
window.rimletter.onMouseLeaveForce(() => {
  if (hoveredEl) hoveredEl = null;
  window.rimletter.setMouseOver(false); // 与主进程穿透状态对齐（幂等）
  tooltip.classList.add('hidden');
  reportRectsSoon();
});
