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
    if (!p || typeof p.id !== 'string' || !isSafeId(p.id) || typeof p.file !== 'string' || !p.file) {
      throw new Error('清单条目非法: ' + (p && p.id));
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

module.exports = { isSafeId, buildChannelUrls, parseManifest, ID_RE, TIMEOUT_MS, DEFAULT_REPO, DEFAULT_BRANCH };
