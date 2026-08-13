// src/main/market.js
// 插件市场：从官方插件仓库（经 jsDelivr CDN / raw.githubusercontent 回退）拉取清单并安装插件。
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const TIMEOUT_MS = 15000;
const DEFAULT_REPO = 'NothingCooker/rimletter-official-plugins';
const DEFAULT_BRANCH = 'main';

function isSafeId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// 返回 [{name, url}]，按顺序优先 jsDelivr，回退 raw.githubusercontent
function buildChannelUrls(repo, branch, filePath) {
  return [
    { name: 'jsdelivr', url: 'https://cdn.jsdelivr.net/gh/' + repo + '@' + branch + '/' + filePath },
    { name: 'raw', url: 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + filePath }
  ];
}

// 校验并归一清单文本 → [{id, name, desc, author, file, version}]
function parseManifest(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('清单不是合法 JSON'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.plugins) || data.plugins.length === 0) {
    throw new Error('清单缺少非空 plugins 数组');
  }
  return data.plugins.map(p => {
    const id = p && p.id;
    if (!p || typeof id !== 'string' || !isSafeId(id)) {
      throw new Error('清单条目非法: 插件 ' + id + ' 的 id 不合法');
    }
    if (typeof p.file !== 'string' || !p.file) {
      throw new Error('清单条目非法: 插件 ' + id + ' 的 file 缺失');
    }
    return {
      id: p.id,
      name: String(p.name || p.id),
      desc: String(p.desc || ''),
      author: String(p.author || ''),
      file: p.file,
      version: String(p.version || '')
    };
  });
}

function createMarket({ getConfig, configDir, fetch, onChanged = () => {} }) {
  const pluginsDir = () => path.join(configDir, 'plugins');
  const repo = () => (getConfig().market && getConfig().market.repo) || DEFAULT_REPO;
  const branch = () => (getConfig().market && getConfig().market.branch) || DEFAULT_BRANCH;

  // 依次尝试通道，全部失败抛错
  async function fetchText(filePath) {
    let lastErr = null;
    for (const ch of buildChannelUrls(repo(), branch(), filePath)) {
      try {
        const res = await fetch(ch.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return { channel: ch.name, text: await res.text() };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error('下载失败: ' + filePath + (lastErr ? ' (' + lastErr.message + ')' : ''));
  }

  function getInstalledIds() {
    const dir = pluginsDir();
    if (!fs.existsSync(dir)) return new Set();
    return new Set(fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, '')));
  }

  function enablePlugin(id) {
    const disabled = (getConfig().plugins && getConfig().plugins.disabled) || [];
    if (disabled.includes(id)) getConfig().plugins.disabled = disabled.filter(n => n !== id);
  }

  async function list() {
    const installed = getInstalledIds();
    const { channel, text } = await fetchText('plugins.json');
    return parseManifest(text).map(p => ({ ...p, installed: installed.has(p.id), channel }));
  }

  // 下载到临时文件后原子改名，避免半截文件；失败时清理临时文件
  async function downloadToFile(id, file) {
    const dir = pluginsDir();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.tmp-' + id + '.js');
    try {
      const { text } = await fetchText(file);
      fs.writeFileSync(tmp, text, 'utf-8');
      fs.renameSync(tmp, path.join(dir, id + '.js'));
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  async function install(id) {
    if (!isSafeId(id)) throw new Error('非法插件 id: ' + id);
    const plugins = await list();
    const entry = plugins.find(p => p.id === id);
    if (!entry) throw new Error('市场不存在插件: ' + id);
    await downloadToFile(id, entry.file);
    enablePlugin(id);
    onChanged();
    return { ok: true };
  }

  async function uninstall(id) {
    if (!isSafeId(id)) throw new Error('非法插件 id: ' + id);
    const target = path.join(pluginsDir(), id + '.js');
    if (fs.existsSync(target)) fs.unlinkSync(target);
    onChanged();
    return { ok: true };
  }

  async function updateAll() {
    const plugins = await list();
    const results = [];
    for (const p of plugins) {
      if (!p.installed) continue;
      try { await install(p.id); results.push({ id: p.id, ok: true }); }
      catch (e) { results.push({ id: p.id, ok: false, error: String(e.message || e) }); }
    }
    return results;
  }

  return { list, install, uninstall, updateAll };
}

module.exports = { isSafeId, buildChannelUrls, parseManifest, createMarket };
