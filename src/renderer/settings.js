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
let pluginSensorMetrics = {}; // { sensorName: [{k,label}] } 从最新传感器快照推断（内置之外的新键）
const OPERATORS = ['>', '>=', '<', '<='];

function switchTab(name) {
  document.querySelectorAll('.rw-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  ['general', 'rules', 'plugins', 'market', 'about'].forEach(n => document.getElementById('pane-' + n).classList.toggle('on', n === name));
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
    renderMarketPane();
    renderAbout();
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
  const curLogLevel = (config.log && config.log.level) || 'info';
  el.innerHTML =
    sliderRow('轮询间隔', 'pollIntervalMs', config.pollIntervalMs, 1000, 10000, '毫秒') +
    sliderRow('自动消失', 'autoDismissMs', config.autoDismissMs, 5000, 60000, '毫秒') +
    '<div class="rw-sep"></div>' +
    '<div class="rw-row"><span class="rw-lbl">信图标大小</span>' +
      '<div class="rw-slider" data-target="appearance.iconSize" data-min="32" data-max="128" data-step="4">' +
        '<div class="rw-thumb" style="left:' + iconPct + '%"></div></div>' +
      '<span class="rw-gray" id="val-appearance.iconSize">' + (config.appearance && config.appearance.iconSize || 64) + ' px</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">开机自启</span>' +
      '<span class="rw-cb" id="autostart-cb"></span>' +
      '<span class="rw-gray" id="autostart-label">…</span></div>' +
    '<div class="rw-sep"></div>' +
    '<div class="rw-row"><span class="rw-lbl">音效</span>' +
      '<span class="rw-cb' + (config.sound.enabled ? ' on' : '') + '" data-toggle="sound.enabled"></span>' +
      '<span class="rw-gray">' + (config.sound.enabled ? '开启' : '关闭') + '</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">音量</span>' +
      '<div class="rw-slider" data-target="sound.volume" data-min="0" data-max="1" data-step="0.05">' +
        '<div class="rw-thumb" style="left:' + (config.sound.volume * 100) + '%"></div></div>' +
      '<span class="rw-gray" id="val-sound.volume">' + Math.round(config.sound.volume * 100) + '%</span></div>' +
    '<div class="rw-sep"></div>' +
    '<div class="rw-row"><span class="rw-lbl">恢复正常播报</span>' +
      '<span class="rw-cb' + (config.recoveryNotifications ? ' on' : '') + '" data-toggle="recoveryNotifications"></span>' +
      '<span class="rw-gray">' + (config.recoveryNotifications ? '开启' : '关闭') + '</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">日志级别</span>' +
      '<select class="rw-select" id="log-level">' + ['debug', 'info', 'warn', 'error'].map(l =>
        '<option' + (curLogLevel === l ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
      '<span class="rw-gray">写入 userData/logs/rimletter.log，重启生效</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">API 绑定地址</span>' +
      '<input class="rw-input" id="api-host" value="' + esc((config.api && config.api.host) || '127.0.0.1') + '" style="width:110px">' +
      '<span class="rw-gray">局域网推送时改 0.0.0.0，重启生效</span></div>' +
    '<div class="rw-sep"></div>' +
    '<div class="rw-row"><span class="rw-lbl">自动更新</span>' +
      '<span class="rw-cb' + (config.update.enabled ? ' on' : '') + '" data-toggle="update.enabled"></span>' +
      '<span class="rw-gray">' + (config.update.enabled ? '开启' : '关闭') + '</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">更新前测速</span>' +
      '<span class="rw-cb' + (config.update.speedTest ? ' on' : '') + '" data-toggle="update.speedTest"></span>' +
      '<span class="rw-gray">' + (config.update.speedTest ? '开启' : '关闭') + '</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">更新状态</span>' +
      '<span class="rw-gray" id="update-status">…</span>' +
      '<button class="rw-btn" id="update-check-btn">立即检查</button>' +
      '<button class="rw-btn" id="update-install-btn" style="display:none">立即重启安装</button></div>';
  bindSliders(el);
  el.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('click', () => {
    const path = cb.dataset.toggle;
    const cur = getPath(config, path);
    setPath(config, path, !cur);
    persistConfig();
    cb.classList.toggle('on', !cur);
    cb.nextElementSibling.textContent = !cur ? '开启' : '关闭';
  }));

  // 日志级别选择（重启生效）
  const logLevelEl = document.getElementById('log-level');
  if (logLevelEl) logLevelEl.addEventListener('change', () => {
    config.log = config.log || {};
    config.log.level = logLevelEl.value;
    persistConfig();
  });

  // API 绑定地址（重启生效；只接受主机名/IP 形态，非法输入回退原值）
  const apiHostEl = document.getElementById('api-host');
  if (apiHostEl) apiHostEl.addEventListener('change', () => {
    const v = (apiHostEl.value || '').trim();
    if (!v || !/^[A-Za-z0-9._:-]+$/.test(v)) { apiHostEl.value = (config.api && config.api.host) || '127.0.0.1'; return; }
    config.api = config.api || {};
    config.api.host = v;
    persistConfig();
  });

  // 自动更新状态与按钮
  const statusEl = document.getElementById('update-status');
  const installBtn = document.getElementById('update-install-btn');
  document.getElementById('update-check-btn').addEventListener('click', async () => {
    await window.rimletter.checkForUpdate();
    window.rimletter.getUpdateState().then(showUpdateStatus);
  });
  installBtn.addEventListener('click', () => window.rimletter.installUpdate());
  window.rimletter.getUpdateState().then(showUpdateStatus);
  window.rimletter.onUpdateStatus(showUpdateStatus);
  function showUpdateStatus(st) {
    if (!statusEl) return;
    const map = {
      idle: '未检查',
      speedtesting: '正在测速(通道 ' + (st.current || 0) + '/' + (st.total || 0) + ')…',
      checking: st.channel ? '正在通过「' + st.channel + '」检查更新…' : '正在检查更新…',
      uptodate: '已是最新版本',
      'update-available': '发现新版本 v' + (st.version || '?') + '，正在下载…',
      downloading: '正在下载…',
      downloaded: '新版本 v' + (st.version || '?') + ' 已下载，重启后安装',
      disabled: '自动更新已关闭',
      error: '检查失败：' + (st.error || '未知错误')
    };
    statusEl.textContent = map[st.code] || st.code;
    installBtn.style.display = (st.code === 'downloaded') ? '' : 'none';
  }

  // 开机自启开关
  const autoCb = document.getElementById('autostart-cb');
  const autoLabel = document.getElementById('autostart-label');
  window.rimletter.getAutostart().then(on => {
    autoCb.classList.toggle('on', on);
    autoLabel.textContent = on ? '开启（登录 Windows 时自动启动）' : '关闭';
  });
  autoCb.addEventListener('click', async () => {
    const on = !autoCb.classList.contains('on');
    const ok = await window.rimletter.setAutostart(on);
    autoCb.classList.toggle('on', ok);
    autoLabel.textContent = ok ? '开启（登录 Windows 时自动启动）' : '关闭';
  });
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
      '<td>' + metricLabel(r) + ' ' + r.operator + ' ' + r.threshold + (r.durationMs > 0 ? ' 持续 ' + (r.durationMs / 1000) + 's' : '') + (r.recoverPct > 0 ? ' 回落 ' + r.recoverPct + '%' : '') + '</td>' +
      '<td><span class="rw-dot" style="background:' + sev.color + '"></span>' + sev.label + '</td>' +
      '<td>' + esc(r.label) + '</td>' +
      '<td><button class="rw-btn small" data-edit="' + r.id + '">编辑</button> <button class="rw-btn small" data-del="' + r.id + '">删</button></td></tr>';
  }
  rows += '</table>';
  el.innerHTML = rows +
    '<div style="margin-top:10px"><button class="rw-btn" id="add-rule">＋ 添加规则</button></div>' +
    '<div id="rule-editor" class="rw-editor" style="display:none"></div>' +
    '<div style="margin-top:10px;font-size:11px;color:#7f8a96">提示：GPU 温度/占用监控仅支持 NVIDIA 显卡（通过 nvidia-smi 读取）。</div>';

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

async function openEditor(id) {
  editingRuleId = id;
  const r = id ? config.rules.find(x => x.id === id) : defaultRule();
  renderRuleEditor(r);          // 同步渲染（用当前缓存的插件传感器指标，首次为空则只含内置），不阻塞
  refreshPluginSensorMetrics(); // 后台刷新插件传感器指标，完成后原地更新下拉、保留当前选中
}

function renderRuleEditor(r) {
  const allMetrics = { ...SENSOR_METRICS, ...pluginSensorMetrics };
  const box = document.getElementById('rule-editor');
  const sensorOpts = Object.keys(allMetrics).map(s => '<option value="' + s + '"' + (r.sensor === s ? ' selected' : '') + '>' + sensorLabel(s) + '</option>').join('');
  const metricOpts = (allMetrics[r.sensor] || allMetrics.cpu).map(m =>
    '<option value="' + m.k + '"' + (r.metric === m.k ? ' selected' : '') + '>' + m.label + '</option>').join('');
  const opOpts = OPERATORS.map(o => '<option' + (r.operator === o ? ' selected' : '') + '>' + o + '</option>').join('');
  const sevOpts = SEVERITIES.map(s => '<option value="' + s.key + '"' + (r.severity === s.key ? ' selected' : '') + '>' + s.label + '</option>').join('');
  box.style.display = 'block';
  box.innerHTML =
    '<div style="font-size:12px;color:#e8ecf1;font-weight:600;margin-bottom:6px">✏ ' + (editingRuleId ? '编辑规则' : '添加规则') + '</div>' +
    '<div class="rw-row"><span class="rw-lbl">传感器</span><select class="rw-select" id="ed-sensor">' + sensorOpts + '</select>' +
      '<span class="rw-lbl">指标</span><select class="rw-select" id="ed-metric">' + metricOpts + '</select>' +
      '<span class="rw-lbl">比较</span><select class="rw-select" id="ed-op">' + opOpts + '</select>' +
      '<input class="rw-input" id="ed-threshold" value="' + r.threshold + '" style="width:60px"></div>' +
    '<div class="rw-row" id="ed-gpu-hint" style="' + (r.sensor === 'gpu' ? '' : 'display:none') + ';font-size:11px;color:#c8a06a">' +
      '<span class="rw-lbl" style="width:auto">⚠ GPU 温度/占用仅支持 NVIDIA 显卡</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">持续时长</span><input class="rw-input" id="ed-duration" value="' + (r.durationMs / 1000) + '" style="width:50px">' +
      '<span class="rw-gray">秒（0=立即，防瞬时尖峰误报）</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">回落门槛</span><input class="rw-input" id="ed-recover-pct" value="' + (r.recoverPct != null ? r.recoverPct : 5) + '" style="width:50px">' +
      '<span class="rw-gray">%（告警后数值需降到阈值以下此比例才允许再次告警/发恢复信，防频繁交替）</span></div>' +
    '<div class="rw-row"><span class="rw-lbl">紧急度</span><select class="rw-select" id="ed-sev">' + sevOpts + '</select></div>' +
    '<div class="rw-row"><span class="rw-lbl">标题</span><input class="rw-input" id="ed-label" value="' + esc(r.label) + '" style="width:220px"></div>' +
    '<div class="rw-row"><span class="rw-lbl">描述</span><input class="rw-input" id="ed-desc" value="' + esc(r.description || '') + '" style="width:220px"></div>' +
    '<div class="rw-row"><span class="rw-lbl">音效</span><input class="rw-input" id="ed-sound" value="' + esc(r.sound || 'auto') + '" style="width:220px"><span class="rw-gray">auto=游戏原声</span></div>' +
    '<div class="rw-row" style="margin-top:10px;gap:10px">' +
    '<button class="rw-btn" id="ed-save">保存</button>' +
    '<button class="rw-btn" id="ed-cancel">取消</button></div>';

  document.getElementById('ed-sensor').addEventListener('change', e => {
    const s = e.target.value;
    document.getElementById('ed-metric').innerHTML = ({ ...SENSOR_METRICS, ...pluginSensorMetrics }[s] || []).map(m =>
      '<option value="' + m.k + '">' + m.label + '</option>').join('');
    const hint = document.getElementById('ed-gpu-hint');
    if (hint) hint.style.display = (s === 'gpu') ? '' : 'none';
  });
  document.getElementById('ed-save').addEventListener('click', () => {
    const obj = {
      id: editingRuleId || 'custom-' + Date.now().toString(36),
      sensor: val('ed-sensor'), metric: val('ed-metric'), operator: val('ed-op'),
      threshold: Number(val('ed-threshold')) || 0,
      durationMs: (Number(val('ed-duration')) || 0) * 1000,
      recoverPct: Number(val('ed-recover-pct')) || 0,
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

async function refreshPluginSensorMetrics() {
  let next = {};
  try {
    const st = await window.rimletter.getState();
    if (st && typeof st === 'object') {
      for (const [name, data] of Object.entries(st)) {
        if (SENSOR_METRICS[name] || !data || typeof data !== 'object' || Array.isArray(data)) continue;
        next[name] = Object.keys(data).filter(k => !Array.isArray(data[k])).map(k => ({ k, label: k }));
      }
    }
  } catch (e) { next = {}; }
  if (JSON.stringify(next) === JSON.stringify(pluginSensorMetrics)) return;
  pluginSensorMetrics = next;
  // 编辑器仍开着时原地更新下拉，保留当前选中
  const sensorEl = document.getElementById('ed-sensor');
  if (!sensorEl) return;
  const curSensor = sensorEl.value;
  const allMetrics = { ...SENSOR_METRICS, ...pluginSensorMetrics };
  sensorEl.innerHTML = Object.keys(allMetrics).map(s => '<option value="' + s + '"' + (s === curSensor ? ' selected' : '') + '>' + sensorLabel(s) + '</option>').join('');
  const metricEl = document.getElementById('ed-metric');
  if (metricEl) {
    const curMetric = metricEl.value;
    metricEl.innerHTML = (allMetrics[curSensor] || []).map(m =>
      '<option value="' + m.k + '"' + (m.k === curMetric ? ' selected' : '') + '>' + m.label + '</option>').join('');
  }
}

function defaultRule() {
  return { id: '', sensor: 'cpu', metric: 'load', operator: '>', threshold: 85, durationMs: 5000, recoverPct: 5, severity: 'NegativeEvent', label: '新规则', description: '', sound: 'auto', enabled: true };
}
function val(id) { return document.getElementById(id).value; }
function sensorLabel(s) { return { cpu: 'CPU', mem: '内存', disk: '磁盘', gpu: 'GPU' }[s] || s; }
function metricLabel(r) { const m = (SENSOR_METRICS[r.sensor] || []).find(x => x.k === r.metric); return m ? m.label : r.metric; }

// ============ 插件管理 ============
const PLUGIN_DOCS = [
  ['api.registerSensor(name, fn)', '注册自定义传感器。fn 异步返回 { value } 或 { value, unit }，会出现在规则引擎的传感器下拉里。'],
  ['api.registerRule(rule)', '注册规则，结构同内置规则：{sensor, metric, operator, threshold, durationMs, recoverPct, severity, label, description, sound, enabled}（recoverPct 为回落门槛%，默认 5，0=不设）。'],
  ['api.letter({severity, title, description, sound})', '主动触发一封播报。'],
  ['api.on(event, handler)', '订阅事件：alert（告警）、recovered（恢复）、rule。'],
  ['api.getState()', '读取当前全部传感器实时值（Promise）。'],
  ['api.setInterval(fn, ms)', '定时器，应用退出自动清理。'],
  ['api.registerConfig({title, fields})', '声明配置表单（显示在 插件管理 → 配置）。字段类型：text / number / bool / select / slider / button。'],
  ['api.getConfig()', '读取当前插件配置（默认值已合并）。'],
  ['api.registerAction(action, fn)', '注册配置表单 button 字段的动作：点按钮时调用 fn()，返回的字符串显示在按钮旁（key 与字段 key 对应）。'],
  ['logger.info/warn/error(...)', '带插件名前缀的日志。']
];

async function renderPlugins() {
  const el = document.getElementById('pane-plugins');
  el.innerHTML =
    '<div style="margin-bottom:8px">' +
    '<button class="rw-btn" id="plug-reload">重新加载插件</button> ' +
    '<button class="rw-btn" id="plug-dir">打开插件目录</button> ' +
    '<button class="rw-btn" id="plug-docs">插件开发文档</button></div>' +
    '<div id="plug-docs-box" style="display:none;margin-bottom:10px"></div>' +
    '<div class="rw-sep"></div>' +
    '<div style="font-size:13px;color:#fff;font-weight:600;margin:8px 0">已安装插件</div>' +
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

  renderLocalPlugins();
}

// 插件市场独立页签：刷新/更新全部 + 清单。按钮在此绑定（renderMarket 可能提前 return 导致漏绑）
async function renderMarketPane() {
  const el = document.getElementById('pane-market');
  el.innerHTML =
    '<div style="margin-bottom:8px">' +
    '<button class="rw-btn" id="mkt-refresh">刷新市场</button> ' +
    '<button class="rw-btn" id="mkt-update-all">更新全部</button></div>' +
    '<div id="mkt-list" style="font-size:12px;color:#c8d0da">加载中…</div>' +
    '<div style="margin:8px 0;font-size:11px;color:#7f8a96">⚠ 插件将获得本机完全执行权限，仅从官方仓库安装可信插件。</div>';

  document.getElementById('mkt-refresh').addEventListener('click', renderMarket);
  document.getElementById('mkt-update-all').addEventListener('click', async () => {
    const btn = document.getElementById('mkt-update-all');
    btn.textContent = '更新中…';
    try {
      const res = await window.rimletter.updateAllPlugins();
      if (res && res.error && !Array.isArray(res)) { alert('更新失败：' + res.error); }
      renderMarketPane();
      renderPlugins();
    } catch (e) { alert('更新失败：' + (e.message || e)); btn.textContent = '更新全部'; }
  });

  renderMarket();
}

async function renderLocalPlugins() {
  const plugs = await window.rimletter.listPlugins();
  const list = document.getElementById('plug-list');
  if (!plugs.length) {
    list.innerHTML = '<div style="color:#7f8a96">暂无插件。用「打开插件目录」放置 .js 插件，再点「重新加载」。</div>';
    return;
  }
  list.innerHTML = '<table class="rw-rule">' +
    '<tr><th>启用</th><th>插件</th><th>状态</th><th style="width:190px">操作</th></tr>' +
    plugs.map(p =>
      '<tr><td><span class="rw-cb' + (p.enabled ? ' on' : '') + '" data-toggle="' + esc(p.name) + '"></span></td>' +
      '<td><b>' + esc(p.name) + '</b></td>' +
      '<td>' + (p.error ? '<span style="color:#ff8888">错误: ' + esc(p.error) + '</span>' : (p.loaded ? '<span style="color:#8fce8f">已加载</span>' : '<span style="color:#c8a0a0">未加载</span>')) + '</td>' +
      '<td><button class="rw-btn small" data-preview="' + esc(p.name) + '">预览</button>' +
      (p.configSchema ? ' <button class="rw-btn small" data-config="' + esc(p.name) + '">配置</button>' : '') + '</td></tr>'
    ).join('') + '</table>' +
    '<div id="plug-preview" class="rw-editor" style="display:none;margin-top:10px"></div>' +
    '<div id="plug-config" class="rw-editor" style="display:none;margin-top:10px"></div>';

  list.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('click', async () => {
    const name = cb.dataset.toggle;
    const nowEnabled = !cb.classList.contains('on');
    await window.rimletter.togglePlugin(name, nowEnabled);
    renderPlugins();
  }));
  list.querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', async () => {
    document.getElementById('plug-config').style.display = 'none';
    const pv = document.getElementById('plug-preview');
    const src = await window.rimletter.previewPlugin(b.dataset.preview);
    pv.style.display = 'block';
    pv.innerHTML = '<div style="font-size:12px;color:#e8ecf1;font-weight:600;margin-bottom:6px">' + esc(src.name) + '.js 源码</div>' +
      '<pre style="margin:0;font-size:11px;color:#9fd8a8;background:rgb(10,13,16);padding:10px;border-radius:4px;overflow:auto;max-height:300px;white-space:pre-wrap">' + esc(src.source || src.error || '') + '</pre>';
  }));
  list.querySelectorAll('[data-config]').forEach(b => b.addEventListener('click', () => {
    document.getElementById('plug-preview').style.display = 'none';
    const p = plugs.find(x => x.name === b.dataset.config);
    if (p) renderPluginConfigForm(p);
  }));
}

async function renderMarket() {
  const box = document.getElementById('mkt-list');
  let data;
  try {
    data = await window.rimletter.listMarket();
  } catch (e) {
    box.innerHTML = '<span style="color:#ff8888">市场加载失败：' + esc(e.message || e) + '</span>';
    return;
  }
  if (!data || !Array.isArray(data)) {
    box.innerHTML = '<span style="color:#ff8888">' + esc((data && data.error) || '市场不可用') + '</span>';
    return;
  }
  if (!data.length) {
    box.innerHTML = '<span style="color:#7f8a96">官方仓库暂无插件。</span>';
    return;
  }
  box.innerHTML = '<table class="rw-rule">' +
    '<tr><th>插件</th><th>说明</th><th>状态</th><th style="width:180px">操作</th></tr>' +
    data.map(p =>
      '<tr><td><b>' + esc(p.name) + '</b></td>' +
      '<td>' + esc(p.desc) + '</td>' +
      '<td>' + (p.installed ? '<span style="color:#8fce8f">已安装</span>' : '<span style="color:#7f8a96">未安装</span>') + '</td>' +
      '<td>' +
        (p.installed
          ? '<button class="rw-btn small" data-mkt-update="' + esc(p.id) + '">更新</button> ' +
            '<button class="rw-btn small" data-mkt-uninstall="' + esc(p.id) + '">卸载</button>'
          : '<button class="rw-btn small" data-mkt-install="' + esc(p.id) + '">安装</button>') +
      '</td></tr>').join('') + '</table>';

  box.querySelectorAll('[data-mkt-install]').forEach(b => b.addEventListener('click', async () => {
    b.textContent = '…';
    try {
      const res = await window.rimletter.installPlugin(b.dataset.mktInstall);
      if (res && res.ok === false) throw new Error(res.error || '安装失败');
      renderMarket();
      renderPlugins();
    } catch (e) { b.textContent = '失败'; alert('安装失败：' + (e.message || e)); }
  }));
  box.querySelectorAll('[data-mkt-update]').forEach(b => b.addEventListener('click', async () => {
    b.textContent = '…';
    try {
      const res = await window.rimletter.installPlugin(b.dataset.mktUpdate);
      if (res && res.ok === false) throw new Error(res.error || '更新失败');
      renderMarket();
      renderPlugins();
    } catch (e) { b.textContent = '失败'; alert('更新失败：' + (e.message || e)); }
  }));
  box.querySelectorAll('[data-mkt-uninstall]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('卸载插件「' + b.dataset.mktUninstall + '」？将删除其 .js 文件。')) return;
    try {
      const res = await window.rimletter.uninstallPlugin(b.dataset.mktUninstall);
      if (res && res.ok === false) throw new Error(res.error || '卸载失败');
      renderMarket();
      renderPlugins();
    } catch (e) { alert('卸载失败：' + (e.message || e)); }
  }));
}

function renderPluginConfigForm(plugin) {
  const schema = plugin.configSchema;
  const fields = schema.fields;
  const values = {};
  fields.forEach(f => { values[f.key] = (plugin.configValues && plugin.configValues[f.key] !== undefined) ? plugin.configValues[f.key] : f.default; });
  const box = document.getElementById('plug-config');
  box.style.display = 'block';
  let html = '<div style="font-size:12px;color:#e8ecf1;font-weight:600;margin-bottom:6px">⚙ ' + esc(schema.title || plugin.name) + ' 配置</div>';
  fields.forEach((f, i) => {
    const cur = values[f.key];
    if (f.type === 'bool') {
      html += '<div class="rw-row"><span class="rw-lbl">' + esc(f.label) + '</span>' +
        '<span class="rw-cb' + (cur ? ' on' : '') + '" data-i="' + i + '" data-role="bool"></span>' +
        '<span class="rw-gray" data-i="' + i + '" data-role="bool-label">' + (cur ? '开启' : '关闭') + '</span></div>';
    } else if (f.type === 'select') {
      html += '<div class="rw-row"><span class="rw-lbl">' + esc(f.label) + '</span>' +
        '<select class="rw-select" data-i="' + i + '" data-role="select">' +
        f.options.map(o => '<option value="' + esc(o.value) + '"' + (o.value === cur ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
        '</select></div>';
    } else if (f.type === 'text') {
      html += '<div class="rw-row"><span class="rw-lbl">' + esc(f.label) + '</span>' +
        '<input class="rw-input" data-i="' + i + '" data-role="text" value="' + esc(cur) + '"' + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '></div>';
    } else if (f.type === 'number') {
      html += '<div class="rw-row"><span class="rw-lbl">' + esc(f.label) + '</span>' +
        '<input class="rw-input" data-i="' + i + '" data-role="number" value="' + esc(cur) + '" style="width:80px"' +
        (typeof f.min === 'number' ? ' min="' + f.min + '"' : '') + (typeof f.max === 'number' ? ' max="' + f.max + '"' : '') + '></div>';
    } else if (f.type === 'slider') {
      const min = f.min, max = f.max;
      const step = f.step || (max - min) / 100;
      const pct = Math.max(0, Math.min(1, (cur - min) / (max - min))) * 100;
      html += '<div class="rw-row"><span class="rw-lbl">' + esc(f.label) + '</span>' +
        '<div class="rw-slider" data-i="' + i + '" data-role="slider" data-min="' + min + '" data-max="' + max + '" data-step="' + step + '">' +
        '<div class="rw-thumb" style="left:' + pct + '%"></div></div>' +
        '<span class="rw-gray" data-i="' + i + '" data-role="slider-label">' + cur + (f.unit ? ' ' + f.unit : '') + '</span></div>';
    } else if (f.type === 'button') {
      html += '<div class="rw-row"><span class="rw-lbl">' + esc(f.label) + '</span>' +
        '<button class="rw-btn" data-i="' + i + '" data-role="button">' + esc(f.buttonText || '执行') + '</button></div>' +
        '<div class="rw-row rw-btnresult"><span class="rw-gray" data-i="' + i + '" data-role="button-result"></span></div>';
    }
  });
  html += '<div class="rw-row" style="margin-top:10px;gap:10px">' +
    '<button class="rw-btn" id="cfg-save">保存</button>' +
    '<button class="rw-btn" id="cfg-cancel">取消</button></div>';
  box.innerHTML = html;

  function elByRole(role, i) { return box.querySelector('[data-role="' + role + '"][data-i="' + i + '"]'); }

  fields.forEach((f, i) => {
    if (f.type === 'bool') {
      elByRole('bool', i).addEventListener('click', function () {
        values[f.key] = !values[f.key];
        this.classList.toggle('on', values[f.key]);
        elByRole('bool-label', i).textContent = values[f.key] ? '开启' : '关闭';
      });
    } else if (f.type === 'select') {
      elByRole('select', i).addEventListener('change', e => { values[f.key] = e.target.value; });
    } else if (f.type === 'text') {
      elByRole('text', i).addEventListener('change', e => { values[f.key] = e.target.value; });
    } else if (f.type === 'number') {
      elByRole('number', i).addEventListener('change', e => { values[f.key] = Number(e.target.value); });
    } else if (f.type === 'slider') {
      const slider = elByRole('slider', i);
      const thumb = slider.querySelector('.rw-thumb');
      const min = Number(slider.dataset.min), max = Number(slider.dataset.max), step = Number(slider.dataset.step);
      const label = elByRole('slider-label', i);
      function setFromClientX(x) {
        const rect = slider.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
        thumb.style.left = (pct * 100) + '%';
        const raw = min + pct * (max - min);
        const value = step ? Math.round(raw / step) * step : raw;
        values[f.key] = value;
        label.textContent = value + (f.unit ? ' ' + f.unit : '');
      }
      slider.addEventListener('mousedown', e => {
        setFromClientX(e.clientX);
        const move = ev => setFromClientX(ev.clientX);
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    } else if (f.type === 'button') {
      elByRole('button', i).addEventListener('click', async () => {
        const res = elByRole('button-result', i);
        res.textContent = '…';
        try {
          const r = await window.rimletter.runPluginAction(plugin.name, f.key);
          res.textContent = r.ok ? r.result : '⚠ ' + r.error;
        } catch (err) {
          res.textContent = '⚠ 调用失败';
        }
      });
    }
  });

  document.getElementById('cfg-save').addEventListener('click', async () => {
    // button 字段无存储值，保存时排除
    const saveValues = {};
    for (const f of fields) if (f.type !== 'button') saveValues[f.key] = values[f.key];
    await window.rimletter.setPluginConfig(plugin.name, saveValues);
    renderPlugins();
  });
  document.getElementById('cfg-cancel').addEventListener('click', () => renderPlugins());
}

// ============ 关于 ============
async function renderAbout() {
  const el = document.getElementById('pane-about');
  let info;
  try { info = await window.rimletter.getAppInfo(); } catch { info = { name: 'RimLetter 边缘信使', version: '?', author: 'NothingCooker', social: 'https://space.bilibili.com/514132068' }; }
  el.innerHTML =
    '<div style="text-align:center;padding:30px 20px">' +
    '<div style="font-size:16px;font-weight:600;color:#fff;margin-bottom:6px">' + esc(info.name) + '</div>' +
    '<div class="rw-gray" style="display:inline-block">版本 ' + esc(info.version) + '</div>' +
    '<div class="rw-sep"></div>' +
    '<div style="font-size:13px;color:#c8d0da;margin:8px 0">参考《边缘世界》(RimWorld) 右侧 Letter 播报的桌面功能性摆件</div>' +
    '<div style="margin:14px 0"><a href="' + esc(info.authorUrl || 'https://github.com/NothingCooker') + '" class="rw-btn" target="_blank" rel="noopener" style="text-decoration:none">GitHub 作者：' + esc(info.author) + '</a></div>' +
    '<div><a href="' + esc(info.social) + '" class="rw-btn" target="_blank" rel="noopener" style="text-decoration:none">Bilibili：space.bilibili.com/514132068</a></div>' +
    '<div style="font-size:11px;color:#7f8a96;margin-top:20px">素材提取自用户自有的游戏，仅供个人使用</div>' +
    '</div>';
}

function docsHtml() {
  return '<div class="rw-editor" style="color:#d8dee6">' +
    '<div style="font-size:13px;color:#fff;font-weight:600;margin-bottom:8px">插件开发文档</div>' +
    '<div style="font-size:12px;color:#9aa5b1;margin-bottom:10px">插件 = plugins/ 目录下的一个 .js 文件，导出 async ({ api, logger }) => { ... }。' +
    '启用的插件在启动和「重新加载」时执行；注册的传感器会出现在规则下拉里。</div>' +
    PLUGIN_DOCS.map(d => '<div style="margin:6px 0"><code style="color:#9fd8a8;background:rgb(10,13,16);padding:2px 6px;border-radius:3px;font-size:11px">' + d[0] + '</code>' +
      '<div style="color:#a8b3c0;font-size:12px;margin-top:2px">' + d[1] + '</div></div>').join('') +
    '<pre style="margin:10px 0 0;font-size:11px;color:#9fd8a8;background:rgb(10,13,16);padding:10px;border-radius:4px;overflow:auto;white-space:pre-wrap">' +
    'module.exports = async ({ api, logger }) => {\n' +
    "  api.registerSensor('myApp', async () => ({ value: 42 }));\n" +
    '  api.registerRule({ sensor: \'myApp\', metric: \'value\', operator: \'>\', threshold: 40, severity: \'NegativeEvent\', label: \'超载\', description: \'...\', sound: \'auto\', enabled: true });\n' +
    "  api.letter({ severity: 'PositiveEvent', title: '你好', description: '插件主动播报' });\n" +
    '  // 配置表单（text/number/bool/select/slider/button 六种字段）\n' +
    '  api.registerConfig({ title: \'示例\', fields: [\n' +
    "    { key: 'url', label: '地址', type: 'text' },\n" +
    "    { key: 'test', label: '测试', type: 'button', buttonText: '点我' }\n" +
    '  ] });\n' +
    "  api.registerAction('test', async () => '按钮点击结果（显示在按钮旁）');\n" +
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
  renderMarketPane();
}
window.runTest = runTest;
window.restoreDefaults = restoreDefaults;
