const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSafeId, buildChannelUrls, buildPurgeUrl, parseManifest, createMarket } = require('../src/main/market');

test('isSafeId 接受字母数字下划线连字符', () => {
  assert.equal(isSafeId('weather'), true);
  assert.equal(isSafeId('a-b_c1'), true);
  assert.equal(isSafeId('ABC123'), true);
});

test('isSafeId 拒绝路径穿越与非法字符', () => {
  assert.equal(isSafeId('..'), false);
  assert.equal(isSafeId('a/b'), false);
  assert.equal(isSafeId('a b'), false);
  assert.equal(isSafeId('a.js'), false);
  assert.equal(isSafeId(''), false);
  assert.equal(isSafeId(null), false);
  assert.equal(isSafeId(123), false);
});

test('buildChannelUrls 生成 jsdelivr 与 raw 两种 URL', () => {
  const urls = buildChannelUrls('o/plugins', 'main', 'plugin-x/plugin-x.js');
  assert.equal(urls[0].name, 'jsdelivr');
  assert.equal(urls[0].url, 'https://cdn.jsdelivr.net/gh/o/plugins@main/plugin-x/plugin-x.js');
  assert.equal(urls[1].name, 'raw');
  assert.equal(urls[1].url, 'https://raw.githubusercontent.com/o/plugins/main/plugin-x/plugin-x.js');
});

test('parseManifest 解析合法清单并归一字段', () => {
  const text = JSON.stringify({
    version: 1,
    plugins: [{ id: 'weather', name: '天气', desc: '描述', author: 'A', file: 'plugin-weather/plugin-weather.js', version: '1.0.0' }]
  });
  const plugins = parseManifest(text);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, 'weather');
  assert.equal(plugins[0].file, 'plugin-weather/plugin-weather.js');
  assert.equal(plugins[0].name, '天气');
});

test('parseManifest 缺少 name 时回退用 id', () => {
  const text = JSON.stringify({ version: 1, plugins: [{ id: 'x', file: 'x/x.js' }] });
  const plugins = parseManifest(text);
  assert.equal(plugins[0].name, 'x');
});

test('parseManifest 非 JSON / 缺 plugins / 非法条目均抛错', () => {
  assert.throws(() => parseManifest('not json'), /JSON/);
  assert.throws(() => parseManifest('{"a":1}'), /plugins/);
  assert.throws(() => parseManifest('{"plugins":[]}'), /plugins/);
  assert.throws(() => parseManifest('{"plugins":[{"id":"a/b","file":"x"}]}'), /非法/);
  assert.throws(() => parseManifest('{"plugins":[{"id":"ok","file":""}]}'), /非法/);
});

test('parseManifest 条目 null 抛错', () => {
  assert.throws(() => parseManifest('{"plugins":[null]}'), /非法/);
});

test('parseManifest 条目缺 file 抛错', () => {
  assert.throws(() => parseManifest('{"plugins":[{"id":"ok"}]}'), /file 缺失/);
});

test('parseManifest 条目 file 非字符串抛错', () => {
  assert.throws(() => parseManifest('{"plugins":[{"id":"ok","file":123}]}'), /file 缺失/);
});

// ===== createMarket =====

function makeMarket({ repo = 'o/plugins', branch = 'main', fetchImpl, pluginsDir, now }) {
  const state = { market: { repo, branch }, plugins: { disabled: ['old'] } };
  const saved = [];
  let changed = 0;
  const market = createMarket({
    getConfig: () => state,
    setConfig: (cfg) => saved.push(cfg),
    configDir: path.dirname(pluginsDir),
    fetch: fetchImpl,
    now,
    purgeDelayMs: 0,
    onChanged: () => { changed++; }
  });
  return { market, changed: () => changed, saved: () => saved };
}

// 按路径路由的 fetch mock：route[path] = {ok, text} 或 {error}，忽略 query（cb 破缓存后缀）
function routeFetch(route) {
  return async (url) => {
    const r = route[url.split('?')[0]];
    if (!r) throw new Error('fetch not stubbed: ' + url);
    if (r.error) throw r.error;
    return { ok: r.ok !== false, status: r.status || 200, text: async () => r.text };
  };
}

const MANIFEST = JSON.stringify({ version: 1, plugins: [
  { id: 'weather', name: '天气', desc: 'd', author: 'A', file: 'plugin-weather/plugin-weather.js', version: '1.0.0' }
]});

test('list 经 jsdelivr 拉取清单并标已安装', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'weather.js'), 'module.exports=()=>{}');
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fetchImpl = routeFetch({ [urls[0].url]: { text: MANIFEST } });
  const { market } = makeMarket({ fetchImpl, pluginsDir: path.join(dir, 'plugins') });
  const list = await market.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'weather');
  assert.equal(list[0].installed, true);
  assert.equal(list[0].channel, 'jsdelivr');
});

test('每次 list 都携带唯一 cb（防本机/代理缓存；CDN 缓存须靠 refresh 的 purge）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => MANIFEST }; };
  const { market } = makeMarket({ fetchImpl, pluginsDir, now: () => String(seen.length) });
  await market.list();
  await market.list();
  assert.equal(seen.length, 2);
  assert.ok(seen[0].startsWith(urls[0].url), '首次走 jsdelivr 通道');
  assert.ok(seen[0].includes('?cb='), 'jsdelivr 请求携带唯一 cb');
  assert.notEqual(seen[0], seen[1], '两次刷新 cb 不同');
});

test('list 的 jsdelivr 失败时回退 raw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fetchImpl = routeFetch({
    [urls[0].url]: { error: new Error('jsdelivr down') },
    [urls[1].url]: { text: MANIFEST }
  });
  const { market } = makeMarket({ fetchImpl, pluginsDir: path.join(dir, 'plugins') });
  const list = await market.list();
  assert.equal(list[0].channel, 'raw');
});

test('install 下载 .js 落位并启用 + 触发 onChanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fileUrls = buildChannelUrls('o/plugins', 'main', 'plugin-weather/plugin-weather.js');
  const fetchImpl = routeFetch({
    [urls[0].url]: { text: MANIFEST },
    [fileUrls[0].url]: { text: 'module.exports=async()=>{};' }
  });
  const { market, changed } = makeMarket({ fetchImpl, pluginsDir });
  const res = await market.install('weather');
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(pluginsDir, 'weather.js'), 'utf-8'), 'module.exports=async()=>{};');
  assert.equal(changed(), 1);
  assert.ok(!fs.existsSync(path.join(pluginsDir, '.tmp-weather.js')), '临时文件已清理');
});

test('install 非法 id 直接拒绝，且不触发 onChanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const { market, changed } = makeMarket({ fetchImpl: async () => { throw new Error('不应调用'); }, pluginsDir: path.join(dir, 'plugins') });
  await assert.rejects(() => market.install('../evil'), /非法插件 id/);
  assert.equal(changed(), 0);
});

test('install 市场不存在的 id 拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fetchImpl = routeFetch({ [urls[0].url]: { text: MANIFEST } });
  const { market } = makeMarket({ fetchImpl, pluginsDir: path.join(dir, 'plugins') });
  await assert.rejects(() => market.install('nope'), /市场不存在/);
});

test('uninstall 删除文件并触发 onChanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'weather.js'), 'x');
  const { market, changed } = makeMarket({ fetchImpl: async () => { throw new Error('uninstall 不应下载'); }, pluginsDir });
  await market.uninstall('weather');
  assert.ok(!fs.existsSync(path.join(pluginsDir, 'weather.js')));
  assert.equal(changed(), 1);
});

test('updateAll 重装所有已安装插件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'weather.js'), 'old');
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fileUrls = buildChannelUrls('o/plugins', 'main', 'plugin-weather/plugin-weather.js');
  const fetchImpl = routeFetch({
    [urls[0].url]: { text: MANIFEST },
    [fileUrls[0].url]: { text: 'new-content' }
  });
  const { market } = makeMarket({ fetchImpl, pluginsDir });
  const results = await market.updateAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(fs.readFileSync(path.join(pluginsDir, 'weather.js'), 'utf-8'), 'new-content');
});

test('install 下载失败时无残留临时文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fileUrls = buildChannelUrls('o/plugins', 'main', 'plugin-weather/plugin-weather.js');
  const fetchImpl = routeFetch({
    [urls[0].url]: { text: MANIFEST },
    [urls[1].url]: { text: MANIFEST },
    [fileUrls[0].url]: { error: new Error('down') },
    [fileUrls[1].url]: { error: new Error('down') }
  });
  const { market } = makeMarket({ fetchImpl, pluginsDir });
  await assert.rejects(() => market.install('weather'), /下载失败/);
  assert.ok(!fs.existsSync(path.join(pluginsDir, '.tmp-weather.js')));
});

test('install 会通过 setConfig 持久化启用状态', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fileUrls = buildChannelUrls('o/plugins', 'main', 'plugin-weather/plugin-weather.js');
  const fetchImpl = routeFetch({
    [urls[0].url]: { text: MANIFEST },
    [fileUrls[0].url]: { text: 'x' }
  });
  const { market, saved } = makeMarket({ fetchImpl, pluginsDir });
  await market.install('weather');
  assert.ok(saved().length >= 1, 'setConfig 被调用');
  const persisted = saved()[saved().length - 1];
  assert.ok(!persisted.plugins.disabled.includes('weather'), 'weather 从 disabled 移除');
  assert.ok(persisted.plugins.disabled.includes('old'), '其它禁用项保留');
});

test('updateAll 单项失败不中断且记录 error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'weather.js'), 'old');
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const fileUrls = buildChannelUrls('o/plugins', 'main', 'plugin-weather/plugin-weather.js');
  const fetchImpl = routeFetch({
    [urls[0].url]: { text: MANIFEST },
    [urls[1].url]: { text: MANIFEST },
    [fileUrls[0].url]: { error: new Error('down') },
    [fileUrls[1].url]: { error: new Error('down') }
  });
  const { market } = makeMarket({ fetchImpl, pluginsDir });
  const results = await market.updateAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.ok(results[0].error.includes('down'));
});

// ===== purge 破缓存 =====

test('buildPurgeUrl 生成按文件路径清理 jsDelivr 缓存的 URL', () => {
  assert.equal(
    buildPurgeUrl('o/plugins', 'main', 'plugins.json'),
    'https://purge.jsdelivr.net/gh/o/plugins@main/plugins.json'
  );
});

test('refresh 先按文件路径 purge jsDelivr 缓存再拉清单', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const purgeUrl = buildPurgeUrl('o/plugins', 'main', 'plugins.json');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.split('?')[0]);
    if (url.startsWith(purgeUrl)) return { ok: true, status: 200, text: async () => '' };
    if (url.startsWith(urls[0].url)) return { ok: true, status: 200, text: async () => MANIFEST };
    throw new Error('unexpected: ' + url);
  };
  const { market } = makeMarket({ fetchImpl, pluginsDir: path.join(dir, 'plugins') });
  const list = await market.refresh();
  assert.equal(calls[0], purgeUrl, '先 purge');
  assert.equal(calls[1], urls[0].url, '再走 jsdelivr 拉清单');
  assert.equal(list[0].id, 'weather');
});

test('refresh 在 purge 失败时仍正常拉取清单', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const purgeUrl = buildPurgeUrl('o/plugins', 'main', 'plugins.json');
  const fetchImpl = routeFetch({
    [purgeUrl]: { error: new Error('purge down') },
    [urls[0].url]: { text: MANIFEST }
  });
  const { market } = makeMarket({ fetchImpl, pluginsDir: path.join(dir, 'plugins') });
  const list = await market.refresh();
  assert.equal(list[0].id, 'weather');
});

test('普通 list 不触发 purge（只在显式 refresh 时清理 CDN 缓存）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-mkt-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  const urls = buildChannelUrls('o/plugins', 'main', 'plugins.json');
  const purgeUrl = buildPurgeUrl('o/plugins', 'main', 'plugins.json');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.split('?')[0]);
    return { ok: true, status: 200, text: async () => MANIFEST };
  };
  const { market } = makeMarket({ fetchImpl, pluginsDir: path.join(dir, 'plugins') });
  await market.list();
  assert.ok(!calls.includes(purgeUrl), '普通 list 不应调用 purge');
});
