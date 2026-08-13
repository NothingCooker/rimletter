const { test } = require('node:test');
const assert = require('node:assert');
const { isSafeId, buildChannelUrls, parseManifest } = require('../src/main/market');

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
