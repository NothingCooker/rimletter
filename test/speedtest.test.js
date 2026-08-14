const { test } = require('node:test');
const assert = require('node:assert');
const { buildChannelProbeUrls, fetchManifest, parsePath } = require('../src/main/speedtest');

test('buildChannelProbeUrls 生成 proxy + github 探测 URL', () => {
  const urls = buildChannelProbeUrls({ proxyChannels: ['https://p1'], publishRepo: 'o/r', arch: 'x64' });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].label, 'p1');
  assert.equal(urls[0].manifestUrl, 'https://p1/https://github.com/o/r/releases/latest/download/latest.yml');
  assert.equal(urls[0].installBase, 'https://p1/https://github.com/o/r/releases/latest/download');
  assert.equal(urls[1].label, 'github');
  assert.equal(urls[1].manifestUrl, 'https://github.com/o/r/releases/latest/download/latest.yml');
});

test('arm64 用 latest-arm64.yml', () => {
  const urls = buildChannelProbeUrls({ proxyChannels: [], publishRepo: 'o/r', arch: 'arm64' });
  assert.equal(urls[0].manifestUrl, 'https://github.com/o/r/releases/latest/download/latest-arm64.yml');
});

test('无 proxyChannels 时仅原生 github', () => {
  const urls = buildChannelProbeUrls({ publishRepo: 'o/r', arch: 'x64' });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].label, 'github');
});

test('parsePath 取顶层 path', () => {
  const yml = 'version: 0.3.4\npath: RimLetter-Setup-x64.exe\nsha512: abc\n';
  assert.equal(parsePath(yml), 'RimLetter-Setup-x64.exe');
});

test('parsePath 无顶层 path 时 fallback files - url', () => {
  const yml = 'version: 0.3.4\nfiles:\n  - url: RimLetter-Setup-ia32.exe\n    sha512: x\n';
  assert.equal(parsePath(yml), 'RimLetter-Setup-ia32.exe');
});

test('parsePath 无 path 返回 null', () => {
  assert.equal(parsePath('version: 0.3.4\n'), null);
});

test('parsePath fallback 跳过 blockmap 选安装包', () => {
  const yml = 'version: 0.3.4\nfiles:\n  - url: App-Setup-x64.exe.blockmap\n    sha512: x\n  - url: App-Setup-x64.exe\n    sha512: y\n';
  assert.equal(parsePath(yml), 'App-Setup-x64.exe');
});

test('fetchManifest 解析成功清单', async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => 'path: App.exe\n' });
  const r = await fetchManifest(fetch, 'u', 1000);
  assert.deepEqual(r, { ok: true, path: 'App.exe' });
});

test('fetchManifest HTTP 失败返回 ok:false', async () => {
  const fetch = async () => ({ ok: false, status: 429 });
  const r = await fetchManifest(fetch, 'u', 1000);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('429'));
});

test('fetchManifest 超时返回 ok:false', async () => {
  const fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const r = await fetchManifest(fetch, 'u', 20);
  assert.equal(r.ok, false);
});
