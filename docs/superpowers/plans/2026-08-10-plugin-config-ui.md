# 插件配置界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件通过声明式 schema 注册配置表单，在设置窗口「插件管理」页签内可视化配置并持久化。

**Architecture:** 纯配置逻辑（schema 校验 / 默认值合并 / 类型归一）放 `src/main/plugins.js` 导出（可单测）；主进程 `makePluginApiFor(name)` 提供名字绑定的 `registerConfig`/`getConfig`/`on('config')`；`plugins:list` 附带 schema+values，新增 `plugins:setConfig` IPC；渲染层 `settings.js` 从 schema 渲染表单并复用 `rw-*` 控件。

**Tech Stack:** Electron 主进程（CommonJS）、原生渲染层（无框架）、`node:test` 单测。

---

## 文件结构

- Modify `src/main/plugins.js` — 新增纯函数 `assertSchema` / `normalizeConfig` / `getPluginConfig`（`loadPlugins` 不变）
- Modify `src/main/main.js` — `makePluginApiFor(name)`、`registry` 扩展、`setPluginConfig`、IPC、`plugins:list` 扩展、`registerRule` upsert
- Modify `src/renderer/preload.js` — 暴露 `setPluginConfig`
- Modify `src/renderer/settings.js` — 插件列表加「配置」按钮 + `renderPluginConfigForm`
- Modify `plugins/example.js` — 演示 registerConfig/getConfig/on('config')
- Modify `test/plugins.test.js` — 纯函数 + 集成测试
- Modify `CLAUDE.md` / `PROJECT.md` — 更新插件配置文档

---

### Task 1: 纯函数 normalizeConfig / getPluginConfig（TDD）

**Files:**
- Modify: `test/plugins.test.js`
- Modify: `src/main/plugins.js`

- [ ] **Step 1: 写失败测试**

在 `test/plugins.test.js` 顶部 import 增加：

```js
const { loadPlugins, normalizeConfig, getPluginConfig } = require('../src/main/plugins');
```

在文件末尾 `makeApi` 之后追加以下测试与新的 `makeApi`（替换旧 `makeApi`）：

```js
test('normalizeConfig 缺键填默认、剔除未知键', () => {
  const schema = { fields: [{ key: 'h', label: '小时', type: 'number', default: 23 }] };
  assert.deepEqual(normalizeConfig(schema, { extra: 1 }), { h: 23 });
});

test('normalizeConfig 各类型归一', () => {
  const schema = { fields: [
    { key: 'n', label: '数', type: 'number', default: 5, min: 0, max: 10 },
    { key: 'b', label: '开', type: 'bool', default: false },
    { key: 's', label: '选', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' },
    { key: 't', label: '文', type: 'text', default: 'x' },
    { key: 'sl', label: '滑', type: 'slider', default: 50, min: 0, max: 100 }
  ]};
  const out = normalizeConfig(schema, { n: 99, b: 1, s: 'z', t: 'y', sl: 150 });
  assert.deepEqual(out, { n: 10, b: true, s: 'a', t: 'y', sl: 100 });
});

test('normalizeConfig 非法 schema 抛错', () => {
  assert.throws(() => normalizeConfig({ fields: [] }, {}), /fields 必须是非空数组/);
  assert.throws(() => normalizeConfig({ fields: [{ key: 'x', label: 'X', type: 'color' }] }, {}), /类型不支持/);
  assert.throws(() => normalizeConfig({ fields: [{ key: 's', label: '滑', type: 'slider' }] }, {}), /需 min\/max/);
});

test('getPluginConfig 合并默认值与存储值；无 schema 返回 null', () => {
  const schema = { fields: [
    { key: 'h', label: '小时', type: 'number', default: 23 },
    { key: 'b', label: '开', type: 'bool', default: true }
  ]};
  assert.deepEqual(getPluginConfig(schema, { h: 22 }), { h: 22, b: true });
  assert.deepEqual(getPluginConfig(schema, {}), { h: 23, b: true });
  assert.equal(getPluginConfig(null, {}), null);
});

test('插件注册配置表单 schema 被记录', async () => {
  const dir = mkDir();
  fs.writeFileSync(path.join(dir, 'c.js'), `
    module.exports = async ({ api }) => {
      api.registerConfig({ fields: [{ key: 'h', label: '小时', type: 'number', default: 23 }] });
    };
  `);
  const registry = { configs: {} };
  const result = await loadPlugins({ pluginsDir: dir, apiFactory: makeApi(registry) });
  assert.equal(result.length, 1);
  assert.equal(registry.configs.c.fields[0].key, 'h');
});

function makeApi(registry) {
  return (name) => ({
    registerSensor(n, fn) { registry.sensors[n] = fn; },
    registerRule(r) { registry.rules.push(r); },
    registerConfig(s) { registry.configs[name] = s; },
    getConfig() { return getPluginConfig(registry.configs[name] || null, {}); },
    letter() {}, on() {}, getState: async () => ({}), setInterval() {},
    logger: { info() {}, warn() {}, error() {} }
  });
}
```

注意：旧 `makeApi` 返回 `() => ({...})`（忽略 name），新 `makeApi` 返回 `(name) => ({...})`。`loadPlugins` 本就以 `apiFactory(name)` 调用，故既有测试兼容（既有测试传的 registry 无 `configs` 键，但那些插件不调用 `registerConfig`，不受影响）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/plugins.test.js`
Expected: 失败于 `normalizeConfig is not a function` / `getPluginConfig is not a function`（新增用例红；既有 3 个用例绿）。

- [ ] **Step 3: 实现纯函数**

在 `src/main/plugins.js` 的 `loadPlugins` 之前插入，并把导出改为：

```js
const FIELD_TYPES = ['text', 'number', 'bool', 'select', 'slider'];

function assertSchema(schema) {
  if (!schema || typeof schema !== 'object') throw new Error('registerConfig: schema 必须是对象');
  if (!Array.isArray(schema.fields) || schema.fields.length === 0) throw new Error('registerConfig: fields 必须是非空数组');
  const seen = new Set();
  for (const f of schema.fields) {
    if (!f || typeof f !== 'object') throw new Error('registerConfig: 字段必须是对象');
    if (typeof f.key !== 'string' || !f.key) throw new Error('registerConfig: 字段缺 key');
    if (seen.has(f.key)) throw new Error('registerConfig: 字段 key 重复: ' + f.key);
    seen.add(f.key);
    if (typeof f.label !== 'string' || !f.label) throw new Error('registerConfig: 字段 ' + f.key + ' 缺 label');
    if (!FIELD_TYPES.includes(f.type)) throw new Error('registerConfig: 字段 ' + f.key + ' 类型不支持: ' + f.type);
    if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) throw new Error('registerConfig: select 字段 ' + f.key + ' 需非空 options');
    if (f.type === 'slider' && (typeof f.min !== 'number' || typeof f.max !== 'number')) throw new Error('registerConfig: slider 字段 ' + f.key + ' 需 min/max');
  }
}

function coerceField(f, value) {
  if (value === undefined || value === null || value === '') return f.default;
  switch (f.type) {
    case 'number':
    case 'slider': {
      const n = Number(value);
      if (Number.isNaN(n)) return f.default;
      let v = n;
      if (typeof f.min === 'number' && v < f.min) v = f.min;
      if (typeof f.max === 'number' && v > f.max) v = f.max;
      return v;
    }
    case 'bool': return !!value;
    case 'select': return (f.options || []).some(o => o.value === value) ? value : f.default;
    case 'text': return String(value);
    default: return f.default;
  }
}

// 类型归一：缺键填默认、剔除 schema 外键、各类型转换/clamp
function normalizeConfig(schema, values) {
  assertSchema(schema);
  const out = {};
  for (const f of schema.fields) out[f.key] = coerceField(f, values ? values[f.key] : undefined);
  return out;
}

// 插件配置实际值（schema 默认值 ∪ 存储值）；无 schema 返回 null
function getPluginConfig(schema, stored) {
  if (!schema) return null;
  return normalizeConfig(schema, stored || {});
}
```

```js
module.exports = { loadPlugins, FIELD_TYPES, assertSchema, normalizeConfig, getPluginConfig };
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test test/plugins.test.js`
Expected: 8 个用例全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins.js test/plugins.test.js
git commit -m "feat: 插件配置纯函数 normalizeConfig/getPluginConfig（+测试）"
```

---

### Task 2: 主进程插件配置 API（main.js）

**Files:**
- Modify: `src/main/main.js`

- [ ] **Step 1: 导入纯函数 + 扩展 registry**

`src/main/main.js:9` 改为：

```js
const { loadPlugins, assertSchema, normalizeConfig, getPluginConfig } = require('./plugins');
```

`src/main/main.js:21` 改为：

```js
let registry = { sensors: {}, customRules: [], pluginConfigs: {}, pluginConfigHandlers: {} };
```

- [ ] **Step 2: reloadEverything 重置 registry + 用名字绑定的 apiFactory**

`src/main/main.js:56` 改为：

```js
  registry = { sensors: {}, customRules: [], pluginConfigs: {}, pluginConfigHandlers: {} };
```

`src/main/main.js:57-63` 改为：

```js
  const disabled = new Set((config.plugins && config.plugins.disabled) || []);
  const pluginResults = loadPlugins({
    pluginsDir: path.join(configDir, 'plugins'),
    apiFactory: name => makePluginApiFor(name),
    filter: name => !disabled.has(name)
  });
```

（删除 `const pluginApi = makePluginApi();` 那行，`makePluginApiFor` 见 Step 3。）

- [ ] **Step 3: makePluginApi 重写为名字绑定的 makePluginApiFor**

把 `src/main/main.js:90-103` 整个 `makePluginApi` 函数替换为：

```js
function makePluginApiFor(name) {
  return {
    registerSensor(sensorName, fn) { registry.sensors[sensorName] = { name: sensorName, read: fn }; },
    registerRule(r) {
      if (!r.id) r.id = 'plugin-' + Math.random().toString(36).slice(2, 8);
      const i = registry.customRules.findIndex(x => x.id === r.id);
      if (i >= 0) registry.customRules[i] = r;
      else registry.customRules.push(r);
    },
    letter(payload) { triggerLetter(payload); },
    on(evt, cb) {
      if (typeof cb !== 'function') return;
      const m = registry.pluginConfigHandlers[name] || (registry.pluginConfigHandlers[name] = {});
      (m[evt] || (m[evt] = [])).push(cb);
    },
    getState: async () => { try { return await getSensors().snapshot(); } catch { return {}; } },
    setInterval(fn, ms) { return setInterval(fn, ms); },
    registerConfig(schema) {
      assertSchema(schema);
      registry.pluginConfigs[name] = schema;
    },
    getConfig() {
      return getPluginConfig(registry.pluginConfigs[name], config.pluginConfig && config.pluginConfig[name]);
    },
    logger: { info: (...a) => console.log('[plugin]', ...a), warn: (...a) => console.warn('[plugin]', ...a), error: (...a) => console.error('[plugin]', ...a) }
  };
}
```

注意：`registerRule` 改为**按 id upsert**（同 id 覆盖），使插件能在 `on('config')` 里安全重注册规则。

- [ ] **Step 4: 语法检查**

Run: `node --check src/main/main.js`
Expected: 无输出（成功）。

- [ ] **Step 5: Commit**

```bash
git add src/main/main.js
git commit -m "feat: 主进程插件配置 API（registerConfig/getConfig/on config，registerRule upsert）"
```

---

### Task 3: setPluginConfig + IPC + plugins:list 扩展 + preload

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/renderer/preload.js`

- [ ] **Step 1: 新增 setPluginConfig 工具函数**

在 `src/main/main.js` 的 `getPluginList` 函数之前插入：

```js
function setPluginConfig(name, values) {
  const schema = registry.pluginConfigs[name];
  if (!schema) return { ok: false, error: '插件无配置定义' };
  config.pluginConfig = config.pluginConfig || {};
  config.pluginConfig[name] = normalizeConfig(schema, values);
  saveConfig(configDir, config);
  const handlers = (registry.pluginConfigHandlers[name] || {})['config'] || [];
  for (const cb of handlers) {
    try { cb(config.pluginConfig[name]); } catch (e) { console.error('[plugin:' + name + '] config handler error:', e); }
  }
  send('config:changed', config);
  return { ok: true, values: config.pluginConfig[name] };
}
```

- [ ] **Step 2: plugins:list 附带 configSchema / configValues**

把 `src/main/main.js:219-236` 的 `getPluginList` 返回对象改为：

```js
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => {
    const name = f.replace(/\.js$/, '');
    const schema = registry.pluginConfigs[name] || null;
    return {
      name,
      file: f,
      enabled: !disabled.has(name),
      loaded: !!(loadedMap[name] && loadedMap[name].loaded),
      error: loadedMap[name] ? loadedMap[name].error : null,
      configSchema: schema,
      configValues: schema ? getPluginConfig(schema, config.pluginConfig && config.pluginConfig[name]) : null
    };
  });
```

- [ ] **Step 3: 新增 plugins:setConfig IPC + plugins:reload 返回扩展**

在 `src/main/main.js` 的 `plugins:list` handler 之后（约 237 行）插入：

```js
ipcMain.handle('plugins:setConfig', (e, name, values) => setPluginConfig(name, values));
```

把 `plugins:reload` handler（约 218 行）改为：

```js
ipcMain.handle('plugins:reload', () => { reloadEverything(); return { sensors: Object.keys(registry.sensors), customRules: registry.customRules, configs: Object.keys(registry.pluginConfigs) }; });
```

- [ ] **Step 4: preload 暴露 setPluginConfig**

`src/renderer/preload.js:16`（`openPluginsDir` 之后）插入：

```js
  setPluginConfig: (name, values) => ipcRenderer.invoke('plugins:setConfig', name, values),
```

- [ ] **Step 5: 语法检查**

Run: `node --check src/main/main.js && node --check src/renderer/preload.js`
Expected: 均无输出（成功）。

- [ ] **Step 6: Commit**

```bash
git add src/main/main.js src/renderer/preload.js
git commit -m "feat: 插件配置 IPC setPluginConfig + plugins:list 附带 schema/values"
```

---

### Task 4: 渲染层插件配置表单（settings.js）

**Files:**
- Modify: `src/renderer/settings.js`

- [ ] **Step 1: renderPlugins 表格加「配置」按钮 + 表单容器**

把 `src/renderer/settings.js:266-288` 的 `renderPlugins` 后半段（从 `list.innerHTML = ...` 到 `list.querySelectorAll('[data-preview]')...` 结束）替换为：

```js
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
```

- [ ] **Step 2: 新增 renderPluginConfigForm 函数**

在 `renderPlugins` 函数之后插入：

```js
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
    }
  });

  document.getElementById('cfg-save').addEventListener('click', async () => {
    await window.rimletter.setPluginConfig(plugin.name, values);
    renderPlugins();
  });
  document.getElementById('cfg-cancel').addEventListener('click', () => renderPlugins());
}
```

说明：字段控件用数字 `data-i` 定位（非插件内容），避免 schema 的 key 含引号破坏选择器；插件提供的 title/label/option label 全部 `esc()` 转义；slider 只在「保存」时提交（拖动实时改标签）。

- [ ] **Step 3: 语法检查**

Run: `node --check src/renderer/settings.js`
Expected: 无输出（成功）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/settings.js
git commit -m "feat: 设置窗口插件配置表单渲染（5 字段类型）"
```

---

### Task 5: 示例插件演示配置

**Files:**
- Modify: `plugins/example.js`

- [ ] **Step 1: 重写 example.js**

把 `plugins/example.js` 整体替换为：

```js
// plugins/example.js —— 示例插件：注册配置表单 + 自定义传感器 + 规则 + 主动播报
// 把此文件复制到 userData/plugins/ 目录（设置窗口「打开插件目录」可直达）。
// 默认禁用（config.plugins.disabled 含 example），需在 设置→插件管理 中启用。
module.exports = async ({ api, logger }) => {
  // 1) 声明配置表单：设置 → 插件管理 → 本插件的「配置」按钮
  api.registerConfig({
    title: '深夜提醒设置',
    fields: [
      { key: 'hour', label: '提醒小时', type: 'slider', default: 23, min: 0, max: 23, step: 1, unit: '点' },
      { key: 'enabled', label: '启用提醒', type: 'bool', default: true },
      { key: 'severity', label: '紧急度', type: 'select', options: [
        { value: 'NeutralEvent', label: '中性' },
        { value: 'NegativeEvent', label: '负面' },
        { value: 'PositiveEvent', label: '正面' }
      ], default: 'NeutralEvent' },
      { key: 'message', label: '提醒文案', type: 'text', default: '已经到点了，早点休息', placeholder: '留空用默认' }
    ]
  });

  // 2) 读取当前配置（默认值已合并），注册自定义传感器
  let cfg = api.getConfig();
  api.registerSensor('clock', async () => ({ value: new Date().getHours() }));

  // 3) 注册规则：深夜（cfg.hour 点后）提醒。registerRule 按 id 去重，可安全重复调用
  function applyRule() {
    api.registerRule({
      id: 'plugin-clock-night',
      sensor: 'clock',
      metric: 'value',
      operator: '>=',
      threshold: cfg.hour,
      durationMs: 0,
      severity: cfg.severity,
      label: '深夜提醒',
      description: '已经 ' + cfg.hour + ' 点了，' + cfg.message,
      sound: 'auto',
      enabled: cfg.enabled
    });
  }
  applyRule();

  // 4) 配置变化时重注册规则并打日志
  api.on('config', next => {
    cfg = next;
    applyRule();
    logger.info('深夜提醒已更新为 ' + cfg.hour + ' 点');
  });

  // 5) 主动播报示例（取消注释以启用）
  // api.letter({ severity: 'PositiveEvent', title: '示例插件已加载', description: '这是插件主动触发的播报' });

  logger.info('示例插件已加载');
};
```

- [ ] **Step 2: 语法检查**

Run: `node --check plugins/example.js`
Expected: 无输出（成功）。

- [ ] **Step 3: Commit**

```bash
git add plugins/example.js
git commit -m "docs: example 插件演示 registerConfig 配置表单"
```

---

### Task 6: 全量验证 + 文档更新

**Files:**
- Modify: `CLAUDE.md`
- Modify: `PROJECT.md`

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部通过（既有 50 + 新增 5 = 55 用例）。

- [ ] **Step 2: 手动验证清单（npm start）**

`npm start` 后：
1. 设置 → 插件管理：example 插件行出现「配置」按钮。
2. 点击展开表单：slider（提醒小时，拖动实时变数值）、bool（启用提醒）、select（紧急度）、text（提醒文案）渲染正确。
3. 改「提醒小时」为 22 → 保存 → 提示收起、列表刷新；检查 `%APPDATA%\rimletter\config.json` 中 `pluginConfig.example.hour === 22`。
4. 重启应用 → 设置 → 插件管理 → 配置：值保留为 22。
5. 主进程日志出现 `[plugin:example] 深夜提醒已更新为 22 点`（`on('config')` 回调触发）。
6. 规则引擎：告警规则页签可见 `plugin-clock-night` 规则，阈值随配置联动。
7. 关闭插件 → 无「配置」按钮；重新启用恢复。

- [ ] **Step 3: 更新 CLAUDE.md 实现状态**

在 `CLAUDE.md` 的「实现状态」清单追加一行：

```markdown
- ✅ 插件配置界面：插件可声明式注册配置表单（registerConfig/getConfig/on('config')，text/number/bool/select/slider 5 种字段），设置→插件管理内展开编辑，持久化到 config.json 的 pluginConfig 命名空间
```

并把「代码结构」的 `plugins.js` 行改为：

```markdown
src/main/plugins.js     插件加载器 + 配置纯函数（normalizeConfig/getPluginConfig）
```

- [ ] **Step 4: 更新 PROJECT.md 插件文档**

在 `PROJECT.md` 插件 API 列表处补充：

```markdown
- `api.registerConfig({title, fields})` — 声明配置表单（text/number/bool/select/slider），设置→插件管理内展开编辑
- `api.getConfig()` — 读取当前插件配置（默认值已合并）
- `api.on('config', cb)` — 配置变更回调
```

- [ ] **Step 5: 提交文档**

```bash
git add CLAUDE.md PROJECT.md
git commit -m "docs: 插件配置界面文档（registerConfig/getConfig/on config）"
```

---

## Self-Review 记录

- **Spec 覆盖**：registerConfig/getConfig/on('config') → Task 2、3；存储 pluginConfig → Task 3；5 字段渲染 → Task 4；示例插件 → Task 5；测试 → Task 1；registerRule upsert → Task 2；文档 → Task 6。✅
- **占位符扫描**：所有步骤含完整代码与命令。✅
- **类型一致性**：`normalizeConfig(schema, values)` / `getPluginConfig(schema, stored)` / `setPluginConfig(name, values)` / `renderPluginConfigForm(plugin)` 前后一致；`data-role`/`data-i` 约定统一。✅
