const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG, loadConfig, saveConfig } = require('../src/main/config');

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

test('update.proxyChannels 默认含 gh.ddlc.top 与 ghproxy.net', () => {
  assert.deepEqual(DEFAULT_CONFIG.update.proxyChannels, ['https://gh.ddlc.top', 'https://ghproxy.net']);
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
