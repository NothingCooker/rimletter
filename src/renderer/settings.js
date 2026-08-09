// src/renderer/settings.js
let config = null;
let editingRuleId = null; // null = 新增

const SEVERITIES = [
  { key: 'ThreatBig', label: '重大威胁', color: '#cc7373' },
  { key: 'ThreatSmall', label: '威胁', color: '#cc9b7d' },
  { key: 'NegativeEvent', label: '负面', color: '#ccc487' },
  { key: 'NeutralEvent', label: '中性', color: '#afb0b9' },
  { key: 'PositiveEvent', label: '正面(恢复正常)', color: '#78b0d8' }
];
const SENSOR_METRICS = {
  cpu:  [{ k: 'load',    label: '占用率 %' }],
  mem:  [{ k: 'usedPct', label: '占用率 %' }],
  disk: [{ k: 'freeGB',  label: '剩余空间 GB' }],
  gpu:  [{ k: 'temp',    label: '温度 °C' }, { k: 'load', label: '占用率 %' }]
};
const OPERATORS = ['>', '>=', '<', '<='];

function switchTab(name) {
  document.querySelectorAll('.rw-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  ['general', 'rules', 'plugins'].forEach(n => document.getElementById('pane-' + n).classList.toggle('on', n === name));
}
window.switchTab = switchTab;

function closeSettings() { window.rimletter.closeSettings(); }
window.closeSettings = closeSettings;

async function init() {
  try {
    if (!window.rimletter) throw new Error('preload 未注入 window.rimletter（检查 preload.js 路径）');
    config = await window.rimletter.getConfig();
    renderGeneral();
    renderRules();
    renderPlugins();
  } catch (e) {
    const pane = document.getElementById('pane-general');
    if (pane) pane.innerHTML = '<div style="color:#ff8888;font-size:12px">初始化出错：' + esc(e.message || e) + '</div>';
    throw e;
  }
}
init();

// ============ 常规设置 ============
function renderGeneral() {
  const el = document.getElementById('pane-general');
  const iconPct = ((config.appearance && config.appearance.iconSize || 64) - 32) / (128 - 32) * 100;
  el.innerHTML =
    sliderRow('轮询间隔', 'pollIntervalMs', config.pollIntervalMs, 1000, 10000, '毫秒') +
    sliderRow('自动消失', 'autoDismissMs', config.autoDismissMs, 5000, 60000, '毫秒') +
    '<div class="rw-sep"></div>' +
    '<div class="rw-row"><span class="rw-lbl">信图标大小</span>' +
      '<div class="rw-slider" data-target="appearance.iconSize" data-min="32" data-max="128" data-step="4">' +
        '<div class="rw-thumb" style="left:' + iconPct + '%"></div></div>' +
      '<span class="rw-gray" id="val-appearance.iconSize">' + (config.appearance && config.appearance.iconSize || 64) + ' px</span></div>' +
    '<div class="rw-sep"></div>' +
    '<div class="rw-row"><span class="rw-lbl">音效</span>' +
      '<span class="rw-cb' + (config.sound.enabled ? ' on' : '') + '" data-toggle="sound.enabled"></span>' +
      '<span class="rw-gray">' + (config.sound.enabled ? '开启' : '关闭') + '</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">音量</span>' +
      '<div class="rw-slider" data-target="sound.volume" data-min="0" data-max="1" data-step="0.05">' +
        '<div class="rw-thumb" style="left:' + (config.sound.volume * 100) + '%"></div></div>' +
      '<span class="rw-gray" id="val-sound.volume">' + Math.round(config.sound.volume * 100) + '%</span></div>';
  bindSliders(el);
  el.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('click', () => {
    const path = cb.dataset.toggle;
    const cur = getPath(config, path);
    setPath(config, path, !cur);
    persistConfig();
    cb.classList.toggle('on', !cur);
    cb.nextElementSibling.textContent = !cur ? '开启' : '关闭';
  }));
}

function sliderRow(label, key, value, min, max, unit) {
  const pct = (value - min) / (max - min) * 100;
  return '<div class="rw-row"><span class="rw-lbl">' + label + '</span>' +
    '<div class="rw-slider" data-target="' + key + '" data-min="' + min + '" data-max="' + max + '" data-step="' + (max - min) / 100 + '">' +
    '<div class="rw-thumb" style="left:' + pct + '%"></div></div>' +
    '<span class="rw-gray" id="val-' + key + '">' + value + ' ' + unit + '</span></div>';
}

// ============ 告警规则 ============
function renderRules() {
  const el = document.getElementById('pane-rules');
  let rows = '<table class="rw-rule"><tr><th></th><th>传感器</th><th>条件</th><th>紧急度</th><th>标题</th><th style="width:110px"></th></tr>';
  for (const r of config.rules) {
    const sev = SEVERITIES.find(s => s.key === r.severity) || SEVERITIES[3];
    rows += '<tr><td><span class="rw-cb' + (r.enabled ? ' on' : '') + '" data-id="' + r.id + '" data-enable></span></td>' +
      '<td>' + sensorLabel(r.sensor) + '</td>' +
      '<td>' + metricLabel(r) + ' ' + r.operator + ' ' + r.threshold + (r.durationMs > 0 ? ' 持续 ' + (r.durationMs / 1000) + 's' : '') + '</td>' +
      '<td><span class="rw-dot" style="background:' + sev.color + '"></span>' + sev.label + '</td>' +
      '<td>' + esc(r.label) + '</td>' +
      '<td><button class="rw-btn small" data-edit="' + r.id + '">编辑</button> <button class="rw-btn small" data-del="' + r.id + '">删</button></td></tr>';
  }
  rows += '</table>';
  el.innerHTML = rows +
    '<div style="margin-top:10px"><button class="rw-btn" id="add-rule">＋ 添加规则</button></div>' +
    '<div id="rule-editor" class="rw-editor" style="display:none"></div>';

  el.querySelectorAll('[data-enable]').forEach(cb => cb.addEventListener('click', () => {
    const r = config.rules.find(x => x.id === cb.dataset.id);
    if (!r) return;
    r.enabled = !r.enabled;
    persistRules();
    cb.classList.toggle('on', r.enabled);
  }));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditor(b.dataset.edit)));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    config.rules = config.rules.filter(x => x.id !== b.dataset.del);
    persistRules();
    renderRules();
  }));
  document.getElementById('add-rule').addEventListener('click', () => openEditor(null));
}

function openEditor(id) {
  editingRuleId = id;
  const r = id ? config.rules.find(x => x.id === id) : defaultRule();
  const box = document.getElementById('rule-editor');
  const sensorOpts = Object.keys(SENSOR_METRICS).map(s => '<option value="' + s + '"' + (r.sensor === s ? ' selected' : '') + '>' + sensorLabel(s) + '</option>').join('');
  const metricOpts = (SENSOR_METRICS[r.sensor] || SENSOR_METRICS.cpu).map(m =>
    '<option value="' + m.k + '"' + (r.metric === m.k ? ' selected' : '') + '>' + m.label + '</option>').join('');
  const opOpts = OPERATORS.map(o => '<option' + (r.operator === o ? ' selected' : '') + '>' + o + '</option>').join('');
  const sevOpts = SEVERITIES.map(s => '<option value="' + s.key + '"' + (r.severity === s.key ? ' selected' : '') + '>' + s.label + '</option>').join('');
  box.style.display = 'block';
  box.innerHTML =
    '<div style="font-size:12px;color:#e8ecf1;font-weight:600;margin-bottom:6px">✏ ' + (id ? '编辑规则' : '添加规则') + '</div>' +
    '<div class="rw-row"><span class="rw-lbl">传感器</span><select class="rw-select" id="ed-sensor">' + sensorOpts + '</select>' +
      '<span class="rw-lbl">指标</span><select class="rw-select" id="ed-metric">' + metricOpts + '</select>' +
      '<span class="rw-lbl">比较</span><select class="rw-select" id="ed-op">' + opOpts + '</select>' +
      '<input class="rw-input" id="ed-threshold" value="' + r.threshold + '" style="width:60px"></div>' +
    '<div class="rw-row"><span class="rw-lbl">持续时长</span><input class="rw-input" id="ed-duration" value="' + (r.durationMs / 1000) + '" style="width:50px">' +
      '<span class="rw-gray">秒（0=立即，防瞬时尖峰误报）</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">紧急度</span><select class="rw-select" id="ed-sev">' + sevOpts + '</select></div>' +
    '<div class="rw-row"><span class="rw-lbl">标题</span><input class="rw-input" id="ed-label" value="' + esc(r.label) + '" style="width:220px"></div>' +
    '<div class="rw-row"><span class="rw-lbl">描述</span><input class="rw-input" id="ed-desc" value="' + esc(r.description || '') + '" style="width:220px"></div>' +
    '<div class="rw-row"><span class="rw-lbl">音效</span><input class="rw-input" id="ed-sound" value="' + esc(r.sound || 'auto') + '" style="width:220px"><span class="rw-gray">auto=游戏原声</span></div>' +
    '<div class="rw-row" style="margin-top:10px;gap:10px">' +
    '<button class="rw-btn" id="ed-save">保存</button>' +
    '<button class="rw-btn" id="ed-cancel">取消</button></div>';

  document.getElementById('ed-sensor').addEventListener('change', e => {
    const s = e.target.value;
    document.getElementById('ed-metric').innerHTML = (SENSOR_METRICS[s] || []).map(m =>
      '<option value="' + m.k + '">' + m.label + '</option>').join('');
  });
  document.getElementById('ed-save').addEventListener('click', () => {
    const obj = {
      id: editingRuleId || 'custom-' + Date.now().toString(36),
      sensor: val('ed-sensor'), metric: val('ed-metric'), operator: val('ed-op'),
      threshold: Number(val('ed-threshold')) || 0,
      durationMs: (Number(val('ed-duration')) || 0) * 1000,
      severity: val('ed-sev'), label: val('ed-label') || '未命名', description: val('ed-desc'),
      sound: val('ed-sound') || 'auto', enabled: true
    };
    if (editingRuleId) {
      const i = config.rules.findIndex(x => x.id === editingRuleId);
      if (i >= 0) config.rules[i] = { ...config.rules[i], ...obj };
    } else {
      config.rules.push(obj);
    }
    persistRules();
    renderRules();
  });
  document.getElementById('ed-cancel').addEventListener('click', () => renderRules());
}

function defaultRule() {
  return { id: '', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 5000, severity: 'NegativeEvent', label: '新规则', description: '', sound: 'auto', enabled: true };
}
function val(id) { return document.getElementById(id).value; }
function sensorLabel(s) { return { cpu: 'CPU', mem: '内存', disk: '磁盘', gpu: 'GPU' }[s] || s; }
function metricLabel(r) { const m = (SENSOR_METRICS[r.sensor] || []).find(x => x.k === r.metric); return m ? m.label : r.metric; }

// ============ 插件管理 ============
const PLUGIN_DOCS = [
  ['api.registerSensor(name, fn)', '注册自定义传感器。fn 异步返回 { value } 或 { value, unit }，会出现在规则引擎的传感器下拉里。'],
  ['api.registerRule(rule)', '注册规则，结构同内置规则：{sensor, metric, operator, threshold, durationMs, severity, label, description, sound, enabled}。'],
  ['api.letter({severity, title, description, sound})', '主动触发一封播报。'],
  ['api.on(event, handler)', '订阅事件：alert（告警）、recovered（恢复）、rule。'],
  ['api.getState()', '读取当前全部传感器实时值（Promise）。'],
  ['api.setInterval(fn, ms)', '定时器，应用退出自动清理。'],
  ['logger.info/warn/error(...)', '带插件名前缀的日志。']
];

async function renderPlugins() {
  const el = document.getElementById('pane-plugins');
  el.innerHTML =
    '<div style="margin-bottom:8px">' +
    '<button class="rw-btn" id="plug-reload">⟳ 重新加载插件</button> ' +
    '<button class="rw-btn" id="plug-dir">📂 打开插件目录</button> ' +
    '<button class="rw-btn" id="plug-docs">📖 插件开发文档</button></div>' +
    '<div id="plug-docs-box" style="display:none;margin-bottom:10px"></div>' +
    '<div id="plug-list" style="font-size:12px;color:#c8d0da">加载中…</div>';

  document.getElementById('plug-reload').addEventListener('click', async () => {
    await window.rimletter.reloadPlugins();
    renderPlugins();
  });
  document.getElementById('plug-dir').addEventListener('click', () => window.rimletter.openPluginsDir());
  document.getElementById('plug-docs').addEventListener('click', () => {
    const box = document.getElementById('plug-docs-box');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    box.innerHTML = docsHtml();
  });

  const plugs = await window.rimletter.listPlugins();
  const list = document.getElementById('plug-list');
  if (!plugs.length) {
    list.innerHTML = '<div style="color:#7f8a96">暂无插件。用「打开插件目录」放置 .js 插件，再点「重新加载」。</div>';
    return;
  }
  list.innerHTML = '<table class="rw-rule">' +
    '<tr><th>启用</th><th>插件</th><th>状态</th><th style="width:150px">操作</th></tr>' +
    plugs.map(p =>
      '<tr><td><span class="rw-cb' + (p.enabled ? ' on' : '') + '" data-toggle="' + esc(p.name) + '"></span></td>' +
      '<td><b>' + esc(p.name) + '</b></td>' +
      '<td>' + (p.error ? '<span style="color:#ff8888">错误: ' + esc(p.error) + '</span>' : (p.loaded ? '<span style="color:#8fce8f">已加载</span>' : '<span style="color:#c8a0a0">未加载</span>')) + '</td>' +
      '<td><button class="rw-btn small" data-preview="' + esc(p.name) + '">预览</button></td></tr>'
    ).join('') + '</table>' +
    '<div id="plug-preview" class="rw-editor" style="display:none;margin-top:10px"></div>';

  list.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('click', async () => {
    const name = cb.dataset.toggle;
    const nowEnabled = !cb.classList.contains('on');
    await window.rimletter.togglePlugin(name, nowEnabled);
    renderPlugins();
  }));
  list.querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', async () => {
    const pv = document.getElementById('plug-preview');
    const src = await window.rimletter.previewPlugin(b.dataset.preview);
    pv.style.display = 'block';
    pv.innerHTML = '<div style="font-size:12px;color:#e8ecf1;font-weight:600;margin-bottom:6px">📄 ' + esc(src.name) + '.js 源码</div>' +
      '<pre style="margin:0;font-size:11px;color:#9fd8a8;background:rgb(10,13,16);padding:10px;border-radius:4px;overflow:auto;max-height:300px;white-space:pre-wrap">' + esc(src.source || src.error || '') + '</pre>';
  }));
}

function docsHtml() {
  return '<div class="rw-editor" style="color:#d8dee6">' +
    '<div style="font-size:13px;color:#fff;font-weight:600;margin-bottom:8px">📖 插件开发文档</div>' +
    '<div style="font-size:12px;color:#9aa5b1;margin-bottom:10px">插件 = plugins/ 目录下的一个 .js 文件，导出 async ({ api, logger }) => { ... }。' +
    '启用的插件在启动和「重新加载」时执行；注册的传感器会出现在规则下拉里。</div>' +
    PLUGIN_DOCS.map(d => '<div style="margin:6px 0"><code style="color:#9fd8a8;background:rgb(10,13,16);padding:2px 6px;border-radius:3px;font-size:11px">' + d[0] + '</code>' +
      '<div style="color:#a8b3c0;font-size:12px;margin-top:2px">' + d[1] + '</div></div>').join('') +
    '<pre style="margin:10px 0 0;font-size:11px;color:#9fd8a8;background:rgb(10,13,16);padding:10px;border-radius:4px;overflow:auto;white-space:pre-wrap">' +
    'module.exports = async ({ api, logger }) => {\n' +
    "  api.registerSensor('myApp', async () => ({ value: 42 }));\n" +
    '  api.registerRule({ sensor: \'myApp\', metric: \'value\', operator: \'>\', threshold: 40, severity: \'NegativeEvent\', label: \'超载\', description: \'...\', sound: \'auto\', enabled: true });\n' +
    "  api.letter({ severity: 'PositiveEvent', title: '你好', description: '插件主动播报' });\n" +
    '  logger.info(\'插件已加载\');\n' +
    '};</pre></div>';
}

// ============ 通用 ============
function bindSliders(scope) {
  scope.querySelectorAll('.rw-slider').forEach(slider => {
    const target = slider.dataset.target, min = Number(slider.dataset.min), max = Number(slider.dataset.max), step = Number(slider.dataset.step);
    const thumb = slider.querySelector('.rw-thumb');
    function setFromClientX(x) {
      const rect = slider.getBoundingClientRect();
      let pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      thumb.style.left = (pct * 100) + '%';
      const raw = min + pct * (max - min);
      const value = step ? Math.round(raw / step) * step : raw;
      setPath(config, target, value);
      const label = document.getElementById('val-' + target);
      if (label) label.textContent = fmtValue(target, value);
      persistConfig();
    }
    slider.addEventListener('mousedown', e => {
      setFromClientX(e.clientX);
      const move = ev => setFromClientX(ev.clientX);
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  });
}
function fmtValue(target, v) {
  if (target === 'sound.volume') return Math.round(v * 100) + '%';
  if (target === 'appearance.iconSize') return v + ' px';
  return Math.round(v) + ' ms';
}
function setPath(obj, pathStr, value) {
  const parts = pathStr.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}
function getPath(obj, pathStr) {
  return pathStr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function persistConfig() { window.rimletter.setConfig(config); }
function persistRules() { window.rimletter.setRules(config.rules); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function runTest() {
  const seq = ['ThreatBig', 'ThreatSmall', 'NegativeEvent', 'NeutralEvent', 'PositiveEvent'];
  const sev = seq[Math.floor(Math.random() * seq.length)];
  window.rimletter.testLetter(sev);
}
async function restoreDefaults() {
  if (!confirm('恢复默认配置？自定义规则将被清空。')) return;
  config = await window.rimletter.resetConfig();
  renderGeneral();
  renderRules();
  renderPlugins();
}
window.runTest = runTest;
window.restoreDefaults = restoreDefaults;
