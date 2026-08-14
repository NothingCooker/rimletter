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
