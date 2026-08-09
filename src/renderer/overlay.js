// src/renderer/overlay.js
const stack = document.getElementById('stack');
const tooltip = document.getElementById('tooltip');
let hovered = false;
let config = { sound: { enabled: true, volume: 0.7 }, appearance: { iconSize: 64 } };

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
    '<img class="icon" src="../../assets/letter/' + L.tintFile + '" draggable="false">' +
    '<div class="label"><div class="bg"></div><span>' + escapeHtml(L.label) + '</span></div>';
  stack.appendChild(el);

  // 到达闪光 + 音效
  spawnFlash(L, el, L.flashColor, 0.55, 0.7);
  playSound(L.sound);

  // 周期性闪光（flashInterval 秒）
  const intervalId = setInterval(() => {
    if (!el.parentNode) { clearInterval(intervalId); return; }
    spawnFlash(L, el, L.flashColor, 0.3, 0.6);
  }, (L.flashInterval || 90) * 1000);

  // 交互
  el.addEventListener('mouseenter', () => { hovered = true; window.rimletter.setMouseOver(true); });
  el.addEventListener('mouseleave', () => { hovered = false; window.rimletter.setMouseOver(false); tooltip.classList.add('hidden'); });
  el.addEventListener('mousemove', (e) => showTooltip(e, L));
  el.addEventListener('click', () => dismiss(el, intervalId));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); playSound('Click'); dismiss(el, intervalId); });

  // 自动消失
  setTimeout(() => { if (el.parentNode) dismiss(el, intervalId); }, L.dismissMs || 20000);

  // 超出 6 封折叠为聚合提示
  while (stack.children.length > 6) {
    const first = stack.firstChild;
    if (first === el) break;
    first.remove();
  }
}

function spawnFlash(L, el, flashColor, peakAlpha, scale) {
  const flash = document.createElement('div');
  flash.className = 'flash';
  flash.style.background = 'radial-gradient(circle, rgba(' + flashColor + ',' + peakAlpha + ') 0%, rgba(' + flashColor + ',' + (peakAlpha * 0.3) + ') 40%, transparent 70%)';
  const rect = el.getBoundingClientRect();
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
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 480);
  if (hovered) { hovered = false; window.rimletter.setMouseOver(false); }
  tooltip.classList.add('hidden');
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
