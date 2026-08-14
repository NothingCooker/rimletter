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

// jsDelivr 官方缓存清理 URL。注意：query string（?cb=）不在 CDN 缓存键里，破不了缓存；
// 且 branch 引用须按具体文件路径 purge（仓库级 @branch/ 不生效），清理后才读得到新内容。
function buildPurgeUrl(repo, branch, filePath) {
  return 'https://purge.jsdelivr.net/gh/' + repo + '@' + branch + '/' + filePath;
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

function createMarket({ getConfig, setConfig = () => {}, configDir, fetch, now = () => Date.now(), onChanged = () => {}, purgeDelayMs = 1000 }) {
  const pluginsDir = () => path.join(configDir, 'plugins');
  const repo = () => (getConfig().market && getConfig().market.repo) || DEFAULT_REPO;
  const branch = () => (getConfig().market && getConfig().market.branch) || DEFAULT_BRANCH;

  // 依次尝试通道，全部失败抛错。opts.purge=true 时先按文件路径清理 jsDelivr 缓存再拉取，
  // 否则 CDN 最长缓存 12 小时，刷新后仍读到旧清单（?cb= 破不了 CDN 缓存，须走 purge API）。
  async function fetchText(filePath, opts = {}) {
    if (opts.purge) {
      try {
        await fetch(buildPurgeUrl(repo(), branch(), filePath), { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (purgeDelayMs > 0) await new Promise(r => setTimeout(r, purgeDelayMs)); // 等清理传播到边缘节点
      } catch (e) { /* purge 失败不致命，继续走普通拉取（最坏读到缓存旧清单） */ }
    }
    let lastErr = null;
    const cb = String(now()); // 携带唯一 cb，仍可破本机 HTTP/代理缓存，但 jsDelivr CDN 缓存须靠上面的 purge
    for (const ch of buildChannelUrls(repo(), branch(), filePath)) {
      try {
        const url = ch.name === 'jsdelivr' ? ch.url + '?cb=' + encodeURIComponent(cb) : ch.url;
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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

  async function list(opts) {
    const installed = getInstalledIds();
    const { channel, text } = await fetchText('plugins.json', opts);
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

  // 安装已解析的清单条目（manifest 已拉取，不再重复下载清单）
  async function installEntry(entry) {
    await downloadToFile(entry.id, entry.file);
    enablePlugin(entry.id);
    setConfig(getConfig());
    onChanged();
  }

  async function install(id) {
    if (!isSafeId(id)) throw new Error('非法插件 id: ' + id);
    const plugins = await list();
    const entry = plugins.find(p => p.id === id);
    if (!entry) throw new Error('市场不存在插件: ' + id);
    return installEntry(entry).then(() => ({ ok: true }));
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
      try { await installEntry(p); results.push({ id: p.id, ok: true }); }
      catch (e) { results.push({ id: p.id, ok: false, error: String(e.message || e) }); }
    }
    return results;
  }

  // 显式刷新：先 purge jsDelivr 缓存再拉清单（普通 list 不 purge，避免滥用清理 API）
  const refresh = () => list({ purge: true });

  return { list, refresh, install, uninstall, updateAll };
}

module.exports = { isSafeId, buildChannelUrls, buildPurgeUrl, parseManifest, createMarket };
