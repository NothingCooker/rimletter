// src/main/speedtest.js
// 更新多通道测速：纯函数 + 注入 fetch，便于单测。
const DEFAULT_CHUNK_BYTES = 1024 * 1024; // 1MB
const DEFAULT_TIMEOUT_MS = 5000;

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
    if (m && !m[1].endsWith('.blockmap')) return m[1];
  }
  return null;
}

// 下载清单，返回 { ok, path } 或 { ok: false, error }
// 超时覆盖整段（含 body 读取）——停滞的连接会被 abort，避免挂起更新流程
async function fetchManifest(fetch, url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const path = parsePath(await res.text());
    if (!path) return { ok: false, error: '清单无 path' };
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// 对安装包 Range 下载前 chunkBytes 字节，测量吞吐。返回 { ok, mbps, bytes, ms } 或 { ok:false, error, bytes, ms }
// 超时覆盖整段（含 body 读取）——停滞的连接会被 abort，避免挂起更新流程
async function measureThroughput(fetch, url, { chunkBytes = DEFAULT_CHUNK_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  let received = 0;
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-' + (chunkBytes - 1) }, signal: controller.signal });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, bytes: 0, ms: Date.now() - start };
    if (!res.body) return { ok: false, error: '无响应体', bytes: 0, ms: Date.now() - start };
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value ? value.length : 0;
        if (received >= chunkBytes) break;
      }
    } finally {
      // 读完 chunk 即释放连接，避免服务器继续推流占着 socket
      await reader.cancel().catch(() => {});
    }
    if (received <= 0) return { ok: false, error: '0 字节', bytes: 0, ms: Date.now() - start };
    const ms = Date.now() - start;
    return { ok: true, mbps: (received / (1024 * 1024)) / (Math.max(ms, 1) / 1000), bytes: received, ms };
  } catch (e) {
    const ms = Date.now() - start;
    return { ok: false, error: (e && e.message) || String(e), bytes: received, ms };
  } finally {
    clearTimeout(timer);
  }
}

// 按吞吐率重排通道：最快在前，失败通道沉底，同速保原序（Array#sort 稳定）
function rankChannels(channels, resultsByLabel) {
  const score = (label) => {
    const r = resultsByLabel[label];
    return r && r.ok ? r.mbps : -1;
  };
  return [...channels].sort((a, b) => score(b.label) - score(a.label));
}

module.exports = { buildChannelProbeUrls, fetchManifest, parsePath, measureThroughput, rankChannels, DEFAULT_CHUNK_BYTES, DEFAULT_TIMEOUT_MS };
