const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG, loadConfig, saveConfig, migrateConfig, OLD_UPDATE_CHANNELS } = require('../src/main/config');

test('DEFAULT_CONFIG 有完整默认值', () => {
  assert.equal(DEFAULT_CONFIG.pollIntervalMs, 2000);
  assert.ok(DEFAULT_CONFIG.rules.length >= 5);
  assert.equal(DEFAULT_CONFIG.api.enabled, true);
});

test('loadConfig 目录无文件时返回默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  assert.equal(cfg.pollIntervalMs, 2000);
});

test('saveConfig 后 loadConfig 能读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.pollIntervalMs = 5000;
  saveConfig(dir, cfg);
  const back = loadConfig(dir);
  assert.equal(back.pollIntervalMs, 5000);
});

test('loadConfig 文件损坏时回退默认且不抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken json');
  const cfg = loadConfig(dir);
  assert.equal(cfg.pollIntervalMs, 2000);
});

test('update.enabled 默认开启', () => {
  assert.equal(DEFAULT_CONFIG.update.enabled, true);
});

test('update.enabled 可持久化关闭', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.update.enabled = false;
  saveConfig(dir, cfg);
  const again = loadConfig(dir);
  assert.equal(again.update.enabled, false);
});

test('update.proxyChannels 默认含 ghproxy.net 与 gh-proxy.com（失效的 gh.ddlc.top 已移除）', () => {
  assert.deepEqual(DEFAULT_CONFIG.update.proxyChannels, ['https://ghproxy.net', 'https://gh-proxy.com']);
});

test('旧默认 proxyChannels（含失效 gh.ddlc.top）自动迁移为新列表并持久化', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ update: { enabled: true, proxyChannels: OLD_UPDATE_CHANNELS } }));
  const cfg = loadConfig(dir);
  assert.deepEqual(cfg.update.proxyChannels, DEFAULT_CONFIG.update.proxyChannels);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
  assert.deepEqual(onDisk.update.proxyChannels, DEFAULT_CONFIG.update.proxyChannels);
});

test('用户自定义 proxyChannels 不被迁移覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ update: { enabled: true, proxyChannels: ['https://custom.mirror'] } }));
  const cfg = loadConfig(dir);
  assert.deepEqual(cfg.update.proxyChannels, ['https://custom.mirror']);
});

test('migrateConfig 对非旧默认列表返回 false 且不改写', () => {
  const cfg = { update: { proxyChannels: ['https://a', 'https://b'] } };
  assert.equal(migrateConfig(cfg), false);
  assert.deepEqual(cfg.update.proxyChannels, ['https://a', 'https://b']);
});

test('market 默认指向官方插件仓库 main 分支', () => {
  assert.equal(DEFAULT_CONFIG.market.repo, 'NothingCooker/rimletter-official-plugins');
  assert.equal(DEFAULT_CONFIG.market.branch, 'main');
});

test('market 配置可持久化覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.market.repo = 'me/plugins';
  saveConfig(dir, cfg);
  const again = loadConfig(dir);
  assert.equal(again.market.repo, 'me/plugins');
});

test('settings.alwaysOnTop 默认开启（设置窗置顶）', () => {
  assert.equal(DEFAULT_CONFIG.settings.alwaysOnTop, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.settings.alwaysOnTop = false;
  saveConfig(dir, cfg);
  assert.equal(loadConfig(dir).settings.alwaysOnTop, false);
});

test('appearance 默认：新信在下方 + 边距默认 + 信间距 30', () => {
  assert.deepEqual(DEFAULT_CONFIG.appearance.position, { side: 'bottom', offsetX: 26, offsetY: 64 });
  assert.equal(DEFAULT_CONFIG.appearance.letterGap, 30);
});

test('旧配置无 appearance.position/letterGap 时自动补默认且不覆盖已有 iconSize', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ appearance: { iconSize: 96 } }));
  const cfg = loadConfig(dir);
  assert.equal(cfg.appearance.iconSize, 96);
  assert.deepEqual(cfg.appearance.position, { side: 'bottom', offsetX: 26, offsetY: 64 });
  assert.equal(cfg.appearance.letterGap, 30);
});

test('旧规则 sensor:gpu 自动迁移为 nvidia-gpu（内置传感器改名）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ rules: [
    { id: 'a', sensor: 'gpu', metric: 'temp', enabled: true },
    { id: 'b', sensor: 'cpu', metric: 'load', enabled: true }
  ] }));
  const cfg = loadConfig(dir);
  assert.equal(cfg.rules.find(x => x.id === 'a').sensor, 'nvidia-gpu');
  assert.equal(cfg.rules.find(x => x.id === 'b').sensor, 'cpu');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
  assert.equal(onDisk.rules.find(x => x.id === 'a').sensor, 'nvidia-gpu');
  // 新默认内置规则直接就是 nvidia-gpu
  assert.equal(DEFAULT_CONFIG.rules.find(r => r.id === 'builtin-gpu-temp').sensor, 'nvidia-gpu');
  assert.equal(DEFAULT_CONFIG.rules.find(r => r.id === 'builtin-gpu-load').sensor, 'nvidia-gpu');
});

test('旧版 position.anchor 四角落自动迁移为 side（上方/下方）并删除 anchor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ appearance: { position: { anchor: 'bottom-right', offsetX: 40, offsetY: 30 } } }));
  const cfg = loadConfig(dir);
  assert.deepEqual(cfg.appearance.position, { side: 'bottom', offsetX: 40, offsetY: 30 });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
  assert.equal(onDisk.appearance.position.side, 'bottom');
  assert.equal(onDisk.appearance.position.anchor, undefined);
  // 上方各角落也归为 top
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({ appearance: { position: { anchor: 'top-left', offsetX: 10, offsetY: 20 } } }));
  assert.equal(loadConfig(dir2).appearance.position.side, 'top');
});

test('appearance.position/letterGap 可持久化覆盖（含四方向 side）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.appearance.position = { side: 'left', offsetX: 40, offsetY: 30 };
  cfg.appearance.letterGap = 60;
  saveConfig(dir, cfg);
  const again = loadConfig(dir);
  assert.deepEqual(again.appearance.position, { side: 'left', offsetX: 40, offsetY: 30 });
  assert.equal(again.appearance.letterGap, 60);
});

test('update.speedTest 默认开启', () => {
  assert.equal(DEFAULT_CONFIG.update.speedTest, true);
});

test('update.speedTest 可持久化关闭', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = loadConfig(dir);
  cfg.update.speedTest = false;
  saveConfig(dir, cfg);
  const again = loadConfig(dir);
  assert.equal(again.update.speedTest, false);
});
