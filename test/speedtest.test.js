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

test('fetchManifest body 阶段停滞超时返回 ok:false', async () => {
  let rejectText;
  const textPromise = new Promise((_, rej) => { rejectText = rej; });
  const fetch = (url, opts) => new Promise((resolve) => {
    opts.signal.addEventListener('abort', () => rejectText(new Error('aborted')));
    resolve({ ok: true, status: 200, text: () => textPromise });
  });
  const r = await fetchManifest(fetch, 'u', 50);
  assert.equal(r.ok, false);
});

const { measureThroughput, rankChannels } = require('../src/main/speedtest');

function streamBody(bytes) {
  return new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); }
  });
}

test('measureThroughput 计算吞吐', async () => {
  const fetch = async () => ({ ok: true, status: 200, body: streamBody(1024 * 1024) });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024 * 1024, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 1024 * 1024);
  assert.ok(r.mbps > 0);
});

test('measureThroughput 0 字节返回 ok:false', async () => {
  const fetch = async () => ({ ok: true, status: 200, body: streamBody(0) });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024, timeoutMs: 5000 });
  assert.equal(r.ok, false);
});

test('measureThroughput HTTP 非 2xx 返回 ok:false', async () => {
  const fetch = async () => ({ ok: false, status: 403 });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024, timeoutMs: 5000 });
  assert.equal(r.ok, false);
});

test('measureThroughput 超时返回 ok:false', async () => {
  const fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024, timeoutMs: 20 });
  assert.equal(r.ok, false);
});

test('rankChannels 按吞吐降序，失败沉底', () => {
  const channels = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
  const byLabel = { a: { ok: true, mbps: 5 }, b: { ok: false }, c: { ok: true, mbps: 9 } };
  assert.deepEqual(rankChannels(channels, byLabel).map(c => c.label), ['c', 'a', 'b']);
});

test('rankChannels 同速保原序', () => {
  const channels = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
  const byLabel = { a: { ok: true, mbps: 5 }, b: { ok: true, mbps: 5 }, c: { ok: false } };
  assert.deepEqual(rankChannels(channels, byLabel).map(c => c.label), ['a', 'b', 'c']);
});

test('rankChannels 全失败保原序', () => {
  const channels = [{ label: 'a' }, { label: 'b' }];
  const byLabel = { a: { ok: false }, b: { ok: false } };
  assert.deepEqual(rankChannels(channels, byLabel).map(c => c.label), ['a', 'b']);
});

test('measureThroughput body 阶段停滞超时返回 ok:false', async () => {
  let rejectRead;
  const pending = new Promise((_, rej) => { rejectRead = rej; });
  const reader = { read: () => pending, cancel: async () => {} };
  const body = { getReader: () => reader, _rejectRead: () => rejectRead(new Error('aborted')) };
  const fetch = (url, opts) => new Promise((resolve) => {
    opts.signal.addEventListener('abort', () => body._rejectRead());
    resolve({ ok: true, status: 200, body });
  });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024 * 1024, timeoutMs: 50 });
  assert.equal(r.ok, false);
});

test('measureThroughput 服务器忽略 Range 时仍按 chunkBytes 截断', async () => {
  const body = new ReadableStream({
    start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); }
  });
  const fetch = async () => ({ ok: true, status: 200, body });
  const r = await measureThroughput(fetch, 'u', { chunkBytes: 1024 * 1024, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.ok(r.bytes <= 1024 * 1024 * 2, '应停在 chunkBytes 附近，不读满 5MB');
});

test('rankChannels 无测速结果的通道按失败沉底', () => {
  const channels = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
  const byLabel = { a: { ok: true, mbps: 5 }, b: { ok: true, mbps: 9 } }; // c 缺失
  assert.deepEqual(rankChannels(channels, byLabel).map(c => c.label), ['b', 'a', 'c']);
});

test('rankChannels 不改动原数组', () => {
  const channels = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
  const byLabel = { a: { ok: true, mbps: 5 }, b: { ok: true, mbps: 9 }, c: { ok: true, mbps: 7 } };
  const before = channels.map(c => c.label);
  rankChannels(channels, byLabel);
  assert.deepEqual(channels.map(c => c.label), before);
});
