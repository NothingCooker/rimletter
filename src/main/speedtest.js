// src/main/speedtest.js
// 更新多通道测速：纯函数 + 注入 fetch，便于单测。
const DEFAULT_CHUNK_BYTES = 1024 * 1024; // 1MB
const DEFAULT_TIMEOUT_MS = 5000;

// 带超时的 fetch：AbortController 超时后 abort
function withTimeoutFetch(fetch, url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// 通道探测 URL：每个加速前缀一个清单/安装包基址，末尾追加原生 github
function buildChannelProbeUrls({ proxyChannels = [], publishRepo, arch }) {
  const parts = publishRepo.split('/');
  const owner = parts[0], repo = parts[1];
  const manifest = arch === 'arm64' ? 'latest-arm64.yml' : 'latest.yml';
  const urls = proxyChannels.map(base => ({
    label: base.replace(/^https?:\/\//, ''),
    manifestUrl: base + '/https://github.com/' + owner + '/' + repo + '/releases/latest/download/' + manifest,
    installBase: base + '/https://github.com/' + owner + '/' + repo + '/releases/latest/download'
  }));
  urls.push({
    label: 'github',
    manifestUrl: 'https://github.com/' + owner + '/' + repo + '/releases/latest/download/' + manifest,
    installBase: 'https://github.com/' + owner + '/' + repo + '/releases/latest/download'
  });
  return urls;
}

// 从 latest.yml 文本解析安装包相对路径：优先顶层 path:，fallback files 段 - url:
function parsePath(ymlText) {
  const lines = String(ymlText || '').split('\n');
  for (const line of lines) {
    const m = /^\s*path:\s*(\S+)\s*$/.exec(line);
    if (m) return m[1];
  }
  for (const line of lines) {
    const m = /^\s*-\s*url:\s*(\S+)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

// 下载清单，返回 { ok, path } 或 { ok: false, error }
async function fetchManifest(fetch, url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await withTimeoutFetch(fetch, url, timeoutMs);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const path = parsePath(await res.text());
    if (!path) return { ok: false, error: '清单无 path' };
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = { buildChannelProbeUrls, fetchManifest, parsePath, withTimeoutFetch, DEFAULT_CHUNK_BYTES, DEFAULT_TIMEOUT_MS };
