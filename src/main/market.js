// src/main/market.js
// 插件市场：从官方插件仓库（经 jsDelivr CDN / raw.githubusercontent 回退）拉取清单并安装插件。
//
// 缓存策略（v0.6.5 起）：jsDelivr 对 @branch 引用最长缓存 12 小时，?cb= 破不了 CDN 缓存。
// 现在先经 GitHub API（动态数据，无 CDN 缓存）把分支解析成最新 commit SHA，再按不可变 SHA
// 拉取清单与插件文件：jsDelivr 对 commit 永久缓存且内容永不变化，不存在「过期读旧」问题，
// 且清单与文件来自同一 commit，版本天然一致。解析失败时回退旧行为（@branch + refresh 走 purge）。
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const TIMEOUT_MS = 15000;
const DEFAULT_REPO = 'NothingCooker/rimletter-official-plugins';
const DEFAULT_BRANCH = 'main';
const RECORD_FILE = '.installed.json'; // 插件目录内已装版本记录（{ [id]: { version, updatedAt } }）

function isSafeId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// 返回 [{name, url}]，按顺序优先 jsDelivr，回退 raw.githubusercontent。
// ref 可以是分支名或 commit SHA（两者 jsDelivr / raw 均支持）。
function buildChannelUrls(repo, ref, filePath) {
  return [
    { name: 'jsdelivr', url: 'https://cdn.jsdelivr.net/gh/' + repo + '@' + ref + '/' + filePath },
    { name: 'raw', url: 'https://raw.githubusercontent.com/' + repo + '/' + ref + '/' + filePath }
  ];
}

// jsDelivr 官方缓存清理 URL。query string（?cb=）不在 CDN 缓存键里，破不了缓存；
// 且 branch 引用须按具体文件路径 purge（仓库级 @branch/ 不生效）。
// 仅作 commit 解析失败的兜底：正常路径按不可变 SHA 拉取，根本读不到旧缓存。
function buildPurgeUrl(repo, branch, filePath) {
  return 'https://purge.jsdelivr.net/gh/' + repo + '@' + branch + '/' + filePath;
}

// 分支 → 最新 commit SHA 的解析入口 URL。
// github：GitHub API commits 端点，动态数据无 CDN 缓存，永远新鲜（匿名限 60 次/小时，够用）。
// jsdelivr：data.jsdelivr.com 包解析端点，返回分支当前解析到的 commit（缓存 TTL 远短于 12h）。
function buildResolveUrls(repo, branch) {
  return [
    { name: 'github', url: 'https://api.github.com/repos/' + repo + '/commits/' + encodeURIComponent(branch) },
    { name: 'jsdelivr', url: 'https://data.jsdelivr.com/v1/packages/gh/' + repo + '@' + encodeURIComponent(branch) }
  ];
}

// 从解析响应提取 40 位 hex SHA：github 返回 { sha }，jsdelivr 返回 { version }。
function parseResolvedSha(text) {
  try {
    const data = JSON.parse(text);
    const v = data && (data.sha || data.version);
    if (typeof v === 'string' && SHA_RE.test(v)) return v;
  } catch { /* 非 JSON 视为解析失败 */ }
  return null;
}

// 解析分支最新 commit SHA；全部通道失败返回 null（调用方回退 @branch 拉取）。
// 返回 { channel, sha } 便于日志。
async function resolveSha(repo, branch, fetch) {
  for (const u of buildResolveUrls(repo, branch)) {
    try {
      const opts = { signal: AbortSignal.timeout(TIMEOUT_MS) };
      if (u.name === 'github') opts.headers = { 'User-Agent': 'rimletter-market' }; // GitHub API 强制 UA
      const res = await fetch(u.url, opts);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const sha = parseResolvedSha(await res.text());
      if (sha) return { channel: u.name, sha };
    } catch (e) { /* 换下一通道 */ }
  }
  return null;
}

// 语义化版本比较：数字段逐段比较；数字部分相等时无后缀 > 有后缀（发布版 > 预发布版）；
// 非纯数字版本（如 'beta'）整串字符串比较；忽略前导 v。返回 -1 | 0 | 1。
function compareVersions(a, b) {
  const norm = s => String(s == null ? '' : s).trim().replace(/^v/i, '');
  const split = s => {
    const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(s);
    return m ? { nums: m[1].split('.').map(Number), pre: m[2] } : null;
  };
  const av = norm(a), bv = norm(b);
  if (av === bv) return 0;
  const pa = split(av), pb = split(bv);
  if (!pa || !pb) return av > bv ? 1 : -1; // 任一侧非数字开头 → 字符串比较
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i++) {
    const x = pa.nums[i] || 0, y = pb.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

// 是否提示更新：
// - 清单没写 version（老清单）→ 保守视为可更新（保持旧「始终显示更新」行为）；
// - 本地无版本记录（手动放置的插件）→ 视为可更新，更新后补记版本；
// - 两者都有 → 仅远端版本更高才提示；本地更高（手改/降级）不回退。
function hasUpdate(remoteVersion, installedVersion) {
  if (!remoteVersion) return true;
  if (!installedVersion) return true;
  return compareVersions(remoteVersion, installedVersion) > 0;
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

function createMarket({ getConfig, setConfig = () => {}, configDir, fetch, now = () => Date.now(), onChanged = () => {}, purgeDelayMs = 1000, resolve }) {
  const pluginsDir = () => path.join(configDir, 'plugins');
  const repo = () => (getConfig().market && getConfig().market.repo) || DEFAULT_REPO;
  const branch = () => (getConfig().market && getConfig().market.branch) || DEFAULT_BRANCH;
  // 注入 resolve 便于单测；默认用内置的 GitHub API / data.jsdelivr 解析
  const resolveRef = resolve || ((r, b) => resolveSha(r, b, fetch));

  // 拉取文本。opts.ref：指定引用（来自同一次 list 的清单解析结果，保证清单与文件同 commit）；
  // 未指定时先解析最新 commit（fresh），失败回退 @branch（refresh 时先 purge 再拉）。
  // 解析成功但 @sha 通道全挂时直接抛错，不回退 @branch：避免「新清单 + 旧插件文件」版本错配。
  async function fetchText(filePath, opts = {}) {
    let lastErr = null;
    const ref = opts.ref !== undefined ? opts.ref : (await resolveRef(repo(), branch()) || {}).sha || null;
    if (ref) {
      for (const ch of buildChannelUrls(repo(), ref, filePath)) {
        try {
          const res = await fetch(ch.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return { channel: ch.name, ref, text: await res.text() };
        } catch (err) { lastErr = err; }
      }
      throw new Error('下载失败: ' + filePath + (lastErr ? ' (' + lastErr.message + ')' : ''));
    }
    // 回退路径：@branch 引用（CDN 可能缓存旧内容最长 12h，显式 refresh 先 purge 再拉）
    if (opts.purge) {
      try {
        await fetch(buildPurgeUrl(repo(), branch(), filePath), { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (purgeDelayMs > 0) await new Promise(r => setTimeout(r, purgeDelayMs)); // 等清理传播到边缘节点
      } catch (e) { /* purge 失败不致命，继续走普通拉取（最坏读到缓存旧清单） */ }
    }
    const cb = String(now()); // 携带唯一 cb，仍可破本机 HTTP/代理缓存，但 jsDelivr CDN 缓存须靠上面的 purge
    for (const ch of buildChannelUrls(repo(), branch(), filePath)) {
      try {
        const url = ch.name === 'jsdelivr' ? ch.url + '?cb=' + encodeURIComponent(cb) : ch.url;
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return { channel: ch.name, ref: null, text: await res.text() };
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

  // ===== 已装版本记录（<pluginsDir>/.installed.json）=====
  function recordPath() { return path.join(pluginsDir(), RECORD_FILE); }

  function readRecords() {
    try {
      const raw = JSON.parse(fs.readFileSync(recordPath(), 'utf-8'));
      return (raw && typeof raw === 'object') ? raw : {};
    } catch { return {}; } // 缺失/损坏都当无记录
  }

  function writeRecords(records) {
    fs.mkdirSync(pluginsDir(), { recursive: true });
    const tmp = recordPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
    fs.renameSync(tmp, recordPath());
  }

  function setRecord(id, version) {
    const records = readRecords();
    records[id] = { version: String(version || ''), updatedAt: now() };
    writeRecords(records);
  }

  function deleteRecord(id) {
    const records = readRecords();
    if (!Object.hasOwn(records, id)) return;
    delete records[id];
    writeRecords(records);
  }

  function enablePlugin(id) {
    const disabled = (getConfig().plugins && getConfig().plugins.disabled) || [];
    if (disabled.includes(id)) getConfig().plugins.disabled = disabled.filter(n => n !== id);
  }

  // 拉清单并合并本地状态；内部返回 { plugins, ref }，ref 供文件下载同 commit 复用
  async function listWithRef(opts) {
    const installed = getInstalledIds();
    const records = readRecords();
    const { channel, text, ref } = await fetchText('plugins.json', opts);
    const plugins = parseManifest(text).map(p => {
      const rec = records[p.id];
      const installedVersion = rec ? String(rec.version || '') : '';
      return { ...p, installed: installed.has(p.id), installedVersion, hasUpdate: hasUpdate(p.version, installedVersion), channel };
    });
    return { plugins, ref };
  }

  async function list(opts) {
    return (await listWithRef(opts)).plugins;
  }

  // 下载到临时文件后原子改名，避免半截文件；失败时清理临时文件
  async function downloadToFile(id, file, ref) {
    const dir = pluginsDir();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.tmp-' + id + '.js');
    try {
      const { text } = await fetchText(file, { ref });
      fs.writeFileSync(tmp, text, 'utf-8');
      fs.renameSync(tmp, path.join(dir, id + '.js'));
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  // 安装已解析的清单条目（manifest 已拉取，不再重复下载清单）；ref 保证文件与清单同 commit
  async function installEntry(entry, ref) {
    await downloadToFile(entry.id, entry.file, ref);
    setRecord(entry.id, entry.version);
    enablePlugin(entry.id);
    setConfig(getConfig());
    onChanged();
  }

  async function install(id) {
    if (!isSafeId(id)) throw new Error('非法插件 id: ' + id);
    const { plugins, ref } = await listWithRef();
    const entry = plugins.find(p => p.id === id);
    if (!entry) throw new Error('市场不存在插件: ' + id);
    await installEntry(entry, ref);
    return { ok: true };
  }

  async function uninstall(id) {
    if (!isSafeId(id)) throw new Error('非法插件 id: ' + id);
    const target = path.join(pluginsDir(), id + '.js');
    if (fs.existsSync(target)) fs.unlinkSync(target);
    deleteRecord(id);
    onChanged();
    return { ok: true };
  }

  // 只更新「有更新」的已安装插件（版本信息缺失的保守视为可更新，保持旧行为）；
  // 已最新则跳过。返回 { updated, skipped, errors }。
  async function updateAll() {
    const { plugins, ref } = await listWithRef();
    const updated = [], skipped = [], errors = [];
    for (const p of plugins) {
      if (!p.installed) continue;
      if (!p.hasUpdate) { skipped.push(p.id); continue; }
      try {
        await installEntry(p, ref);
        updated.push({ id: p.id, version: p.version });
      } catch (e) {
        errors.push({ id: p.id, error: String(e.message || e) });
      }
    }
    return { updated, skipped, errors };
  }

  // 已安装且有更新的插件（供启动/周期自动检查发信通知）
  async function checkUpdates() {
    const plugins = await list();
    return plugins
      .filter(p => p.installed && p.hasUpdate)
      .map(p => ({ id: p.id, name: p.name, version: p.version, installedVersion: p.installedVersion }));
  }

  // 显式刷新：先解析最新 commit 再拉清单；解析失败时 purge jsDelivr 缓存兜底（普通 list 不 purge，避免滥用清理 API）
  const refresh = () => list({ purge: true });

  return { list, refresh, install, uninstall, updateAll, checkUpdates };
}

module.exports = { isSafeId, buildChannelUrls, buildPurgeUrl, buildResolveUrls, parseResolvedSha, resolveSha, compareVersions, hasUpdate, parseManifest, createMarket };
