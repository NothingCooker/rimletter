// src/main/patcher.js
// 热补丁引擎：常规 bug 修复不升版本号，启动时静默拉取并应用官方补丁。
//
// 分发链路复用插件市场 v0.6.5 的「先解析后固定」@sha 模式（见 market.js）：
//   GitHub API（回退 data.jsdelivr）把分支解析成最新 commit SHA，
//   再按不可变 @sha 从 jsDelivr（回退 raw.githubusercontent）拉 manifest 与补丁文件，
//   manifest 与补丁文件来自同一 commit，无版本错配、无 CDN 缓存过期。
//
// 设计要点：
//   - manifest 是累积全量列表：新装旧包（如 1.0.0）的客户端一次拉全所有历史补丁，
//     按自身版本范围过滤应用 → 「下载旧版本也没有 bug」。
//   - 补丁是 CommonJS 模块，导出 apply(ctx)；ctx 提供 patchModule（原地替换模块导出
//     对象属性，调用方须对象访问、禁止解构导入）与 patched（幂等自检）。
//   - 崩溃熔断：patch-state.json 记录 applied/disabled/crashes/lastExitOk，
//     连续异常启动达到阈值自动禁用最近补丁（新进程不再应用即回滚）。
//   - 补丁阶段永不阻塞启动：任何失败只记日志；失败/离线下次启动再试。
//
// 不直接 require electron；网络/文件/模块加载/配置全部由上层注入，便于单测 mock。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const marketMod = require('./market');

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MANIFEST_FILE = 'patches/manifest.json';
const FETCH_TIMEOUT_MS = 5000; // 单次网络请求超时默认值（config.patch.fetchTimeoutMs 可调）

function defaultState() {
  return { schema: 1, applied: [], disabled: [], crashes: 0, lastExitOk: true };
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

// 解析并归一补丁清单（累积全量）。非法条目跳过（记日志）而非整体失败，
// 避免一条坏补丁阻断其余全部。返回 { patches, skipped }。
function parsePatchManifest(text, log = () => {}) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('补丁清单不是合法 JSON'); }
  if (!data || typeof data !== 'object' || data.schema !== 1 || !Array.isArray(data.patches)) {
    throw new Error('补丁清单非法: 缺 schema=1 或 patches 数组');
  }
  const patches = [];
  const skipped = [];
  for (const p of data.patches) {
    if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id)) { skipped.push('非法补丁 id'); continue; }
    if (typeof p.file !== 'string' || !p.file.startsWith('patches/') || p.file.includes('..')) {
      skipped.push(p.id + ': file 非法（须 patches/ 前缀且无 ..）'); continue;
    }
    if (typeof p.sha256 !== 'string' || !SHA256_RE.test(p.sha256)) {
      skipped.push(p.id + ': sha256 非法'); continue;
    }
    patches.push({
      id: p.id,
      title: String(p.title || p.id),
      minVersion: String(p.minVersion || '0.0.0'),
      maxVersion: String(p.maxVersion || '9999.9999.9999'),
      platforms: Array.isArray(p.platforms) && p.platforms.length ? p.platforms.map(String) : null,
      file: p.file,
      sha256: p.sha256,
      severity: String(p.severity || 'bugfix'),
      publishedAt: String(p.publishedAt || ''),
      channel: String(p.channel || 'stable')
    });
  }
  for (const s of skipped) log('warn', '[patch] 清单条目跳过: ' + s);
  return { patches, skipped };
}

// 判断补丁对当前版本/平台/状态是否适用。返回 true 或跳过原因字符串。
function isApplicable(p, { appVersion, platform, state, channel }) {
  if (marketMod.compareVersions(appVersion, p.minVersion) < 0) return '版本低于 minVersion';
  if (marketMod.compareVersions(appVersion, p.maxVersion) > 0) return '版本高于 maxVersion';
  if (p.platforms && !p.platforms.includes(platform)) return '平台不匹配';
  if (state.disabled.includes(p.id)) return '已被禁用';
  if (state.applied.some(x => x.id === p.id)) return '已应用';
  if (channel && p.channel && p.channel !== channel) return '通道不匹配';
  return true;
}

function createPatcher(deps) {
  const {
    appVersion = '0.0.0',   // 当前应用版本（package.json / app.getVersion()）
    platform = 'unknown',   // process.platform
    fetch = null,           // 网络 fetch；null = 禁用网络（补丁阶段直接跳过）
    appPath = null,         // app.getAppPath()；patchModule 解析应用模块用
    stateFile = null,       // patch-state.json 绝对路径；null = 纯内存不持久化
    cacheDir = null,        // 补丁文件缓存目录；默认 os.tmpdir()/rimletter-patch-cache
    log = () => {},
    now = () => Date.now(),
    getConfig = () => ({}), // 返回 config.patch 命名空间
    requireFn = require,
    resolve = null          // 注入 SHA 解析器便于单测；默认内置 resolveSha
  } = deps;

  const cfg = () => getConfig() || {};
  const repo = () => cfg().repo || 'NothingCooker/rimletter';
  const branch = () => cfg().branch || 'master';
  const resolveRef = resolve || ((r, b) => marketMod.resolveSha(r, b, fetch));

  let state = defaultState();
  let sessionDone = false; // 本次会话是否已执行过 applyAll（幂等防重入）

  // ===== 状态读写（patch-state.json，tmp+rename 原子写）=====

  function readState() {
    if (!stateFile) return defaultState();
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      if (!raw || typeof raw !== 'object' || raw.schema !== 1) return defaultState();
      return {
        schema: 1,
        applied: Array.isArray(raw.applied) ? raw.applied : [],
        disabled: Array.isArray(raw.disabled) ? raw.disabled : [],
        crashes: Number.isFinite(raw.crashes) && raw.crashes > 0 ? raw.crashes : 0,
        lastExitOk: raw.lastExitOk !== false
      };
    } catch (e) {
      log('warn', '[patch] 补丁状态文件损坏，重置: ' + String(e && e.message || e));
      return defaultState();
    }
  }

  function writeState() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      log('error', '[patch] 状态写盘失败: ' + String(e && e.message || e));
    }
  }

  // ===== 崩溃熔断 =====

  // 启动早期同步调用（毫秒级）：读状态；上次非正常退出 → 计数递增；
  // 达到阈值 → 禁用最近应用的补丁（新进程不再应用即回滚）。返回 { crashes, rolledBack }。
  function preflight() {
    state = readState();
    let rolledBack = null;
    if (state.lastExitOk === false) {
      state.crashes++;
      const threshold = cfg().crashThreshold == null ? 2 : cfg().crashThreshold;
      if (state.crashes >= threshold && state.applied.length > 0) {
        const victim = state.applied[state.applied.length - 1];
        rolledBack = victim.id;
        state.disabled.push(victim.id);
        state.applied = state.applied.filter(p => p.id !== victim.id);
        state.crashes = 0;
        log('warn', '[patch] 连续 ' + threshold + ' 次异常启动，已禁用补丁 ' + victim.id + '（下次启动起不再应用）');
      }
    }
    state.lastExitOk = false; // 本次启动中若崩溃，下次 preflight 会感知
    writeState();
    return { crashes: state.crashes, rolledBack };
  }

  // 正常退出 / 健康运行一段时间后调用：标记上次退出正常并清零崩溃计数。
  function markExitOk() {
    state.lastExitOk = true;
    state.crashes = 0;
    writeState();
  }

  // ===== 补丁作用域 =====

  // 按应用根解析模块，取 require 缓存中的导出对象原地替换属性。
  // 调用方须通过对象属性访问（禁止解构导入），否则替换不生效——补丁编写指南已约定。
  function patchModule(relPath, mutator) {
    if (typeof relPath !== 'string' || !relPath) throw new Error('patchModule: relPath 非法');
    if (typeof mutator !== 'function') throw new Error('patchModule: mutator 必须是函数');
    if (!appPath) throw new Error('patchModule: 未提供 appPath，无法解析应用模块');
    if (relPath.split(/[\\/]/).includes('..')) throw new Error('patchModule: relPath 不允许 ..');
    // 直接拼应用根绝对路径（require.resolve 的 paths 选项只查 node_modules，对相对路径无效）；
    // 与业务模块 require 出的 id 一致，命中同一 require 缓存实例。
    const resolved = path.isAbsolute(relPath) ? relPath : path.join(appPath, relPath);
    const mod = requireFn(resolved);
    if (!mod || typeof mod !== 'object') {
      throw new Error('patchModule: 模块 ' + relPath + ' 导出非对象，无法原地打补丁（此类场景走补丁版本 1.0.x）');
    }
    mutator(mod);
    log('info', '[patch] patchModule 已作用: ' + relPath);
  }

  // ===== 网络 =====

  function fetchTextWithTimeout(url) {
    const fto = cfg().fetchTimeoutMs == null ? FETCH_TIMEOUT_MS : cfg().fetchTimeoutMs;
    return fetch(url, { signal: AbortSignal.timeout(fto) })
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      });
  }

  async function fetchViaChannels(urls) {
    let lastErr = null;
    for (const ch of urls) {
      try {
        return { channel: ch.name, text: await fetchTextWithTimeout(ch.url) };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('全部通道失败');
  }

  // ===== 补丁应用 =====

  // 执行单个补丁 apply：try/catch + 超时熔断；支持同步与返回 Promise 两种形态。
  function runApply(patch, ctx) {
    const timeoutMs = cfg().applyTimeoutMs == null ? 3000 : cfg().applyTimeoutMs;
    return new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = r => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      timer = setTimeout(() => finish({ ok: false, error: 'apply 超时 (' + timeoutMs + 'ms)' }), timeoutMs);
      try {
        const r = patch.apply(ctx);
        if (r && typeof r.then === 'function') {
          r.then(() => finish({ ok: true }), e => finish({ ok: false, error: String(e && e.message || e) }));
        } else {
          finish({ ok: true });
        }
      } catch (e) {
        finish({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function writePatchCache(id, text) {
    const dir = cacheDir || path.join(os.tmpdir(), 'rimletter-patch-cache');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id + '.js');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, file);
    return file;
  }

  // 启动补丁阶段：resolve SHA → manifest → 过滤 → 下载/校验/应用。永不 reject。
  // 返回 { ok, reason?, applied: [{id,title}], failed: [{id,error}], skipped: [{id,reason}] }
  async function applyAll() {
    if (sessionDone) return { ok: true, applied: [], failed: [], skipped: [], reason: 'already-applied' };
    sessionDone = true; // 防重入；中途失败本会话也不再重试（下次启动再试）
    if (cfg().enabled === false) return { ok: false, reason: 'disabled' };
    if (!fetch) return { ok: false, reason: 'no-fetch' };

    const timeoutMs = cfg().timeoutMs == null ? 8000 : cfg().timeoutMs;
    const deadline = now() + timeoutMs;
    const alive = () => now() < deadline;
    const out = { ok: false, reason: null, applied: [], failed: [], skipped: [] };
    const settle = patch => Object.assign(out, patch);

    try {
      // 1. 解析最新 commit SHA（整体超时由 deadline 兜底，resolve 挂起不卡启动）
      const resolved = await Promise.race([
        resolveRef(repo(), branch()),
        new Promise(r => setTimeout(() => r(null), Math.max(1, deadline - now())))
      ]);
      if (!alive()) return settle({ reason: 'timeout' });
      if (!resolved || !resolved.sha) return settle({ reason: 'resolve-failed' });
      const sha = resolved.sha;
      log('info', '[patch] 解析到 commit ' + sha + '（' + resolved.channel + '）');

      // 2. 拉 manifest（与补丁文件同 commit）
      let manifestText;
      try {
        manifestText = (await fetchViaChannels(marketMod.buildChannelUrls(repo(), sha, MANIFEST_FILE))).text;
      } catch (e) {
        return settle({ reason: 'manifest-fetch-failed', error: String(e && e.message || e) });
      }
      if (!alive()) return settle({ reason: 'timeout' });
      let manifest;
      try {
        manifest = parsePatchManifest(manifestText, log);
      } catch (e) {
        return settle({ reason: 'manifest-invalid', error: String(e && e.message || e) });
      }
      log('info', '[patch] 清单 ' + manifest.patches.length + ' 条补丁');

      // 3. 逐个过滤 → 下载 → sha256 校验 → 应用（顺序执行，单补丁失败不中断其余）
      const channel = cfg().channel || 'stable';
      for (const p of manifest.patches) {
        const verdict = isApplicable(p, { appVersion, platform, state, channel });
        if (verdict !== true) { out.skipped.push({ id: p.id, reason: verdict }); continue; }
        if (!alive()) return settle({ reason: 'timeout' });

        let text;
        try {
          text = (await fetchViaChannels(marketMod.buildChannelUrls(repo(), sha, p.file))).text;
        } catch (e) {
          out.failed.push({ id: p.id, error: '下载失败' });
          log('warn', '[patch] ' + p.id + ' 下载失败: ' + String(e && e.message || e));
          continue;
        }
        if (sha256Hex(text) !== p.sha256) {
          out.failed.push({ id: p.id, error: 'sha256 校验失败' });
          log('error', '[patch] ' + p.id + ' sha256 校验失败，已丢弃');
          continue;
        }

        try {
          const file = writePatchCache(p.id, text);
          const mod = requireFn(file);
          if (!mod || typeof mod.apply !== 'function') throw new Error('补丁模块缺少 apply 导出');
          const ctx = {
            patched: id => state.applied.some(x => x.id === id),
            patchModule,
            log: msg => log('info', '[patch:' + p.id + '] ' + msg)
          };
          const r = await runApply(mod, ctx);
          if (!r.ok) throw new Error(r.error);
          state.applied.push({ id: p.id, at: new Date(now()).toISOString() });
          writeState();
          out.applied.push({ id: p.id, title: p.title });
          log('info', '[patch] 已应用 ' + p.id);
        } catch (e) {
          out.failed.push({ id: p.id, error: String(e && e.message || e) });
          log('warn', '[patch] ' + p.id + ' 应用失败: ' + String(e && e.message || e));
        }
      }
      return settle({ ok: true });
    } catch (e) {
      return settle({ reason: 'error', error: String(e && e.message || e) });
    }
  }

  function getState() {
    return JSON.parse(JSON.stringify(state));
  }

  return { preflight, markExitOk, applyAll, getState, patchModule };
}

module.exports = { defaultState, sha256Hex, parsePatchManifest, isApplicable, createPatcher };
