// scripts/build_patch_manifest.js
// 扫描 patches/*.js 的头部注释元数据，生成累积全量清单 patches/manifest.json。
//
// 用法：
//   node scripts/build_patch_manifest.js         生成 manifest.json（发补丁前必跑）
//   node scripts/build_patch_manifest.js --check 只校验不写盘（CI 用：manifest 与 patches/ 不一致时退出码 1）
//
// 补丁文件头部注释（// @key value）约定见 docs/patches-guide.md。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PATCHES_DIR = path.join(__dirname, '..', 'patches');
const MANIFEST_FILE = path.join(PATCHES_DIR, 'manifest.json');
const ID_RE = /^[a-zA-Z0-9_-]+$/;

// 解析补丁文件头部注释元数据（// @id xxx / // @title xxx ...）
function parseHeader(text) {
  const meta = {};
  for (const line of text.split('\n')) {
    const m = /^\s*\/\/\s*@(\w+)\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim();
  }
  return meta;
}

// 单个补丁 → manifest 条目；非法元数据直接抛错（发补丁是严肃操作，不允许静默跳过）
function buildEntry(file) {
  const abs = path.join(PATCHES_DIR, file);
  const text = fs.readFileSync(abs, 'utf-8');
  const meta = parseHeader(text);
  const id = meta.id;
  if (!id || !ID_RE.test(id)) throw new Error(file + ': 缺少合法 @id（须匹配 ^[a-zA-Z0-9_-]+$）');
  if (!meta.title) throw new Error(file + ': 缺少 @title');
  if (!meta.minVersion) throw new Error(file + ': 缺少 @minVersion');
  if (!meta.maxVersion) throw new Error(file + ': 缺少 @maxVersion');
  const entry = {
    id,
    title: meta.title,
    minVersion: meta.minVersion,
    maxVersion: meta.maxVersion,
    file: 'patches/' + file,
    sha256: crypto.createHash('sha256').update(text, 'utf-8').digest('hex'),
    severity: meta.severity || 'bugfix'
  };
  if (meta.platforms) entry.platforms = meta.platforms.split(',').map(s => s.trim()).filter(Boolean);
  if (meta.publishedAt) entry.publishedAt = meta.publishedAt;
  if (meta.channel && meta.channel !== 'stable') entry.channel = meta.channel;
  return entry;
}

function build() {
  if (!fs.existsSync(PATCHES_DIR)) throw new Error('缺少 patches/ 目录');
  const files = fs.readdirSync(PATCHES_DIR).filter(f => f.endsWith('.js')).sort();
  const seen = new Set();
  const patches = files.map(f => {
    const e = buildEntry(f);
    if (seen.has(e.id)) throw new Error('重复补丁 id: ' + e.id);
    seen.add(e.id);
    return e;
  });
  return { schema: 1, updatedAt: new Date().toISOString(), patches };
}

// 校验用的稳定键：忽略 updatedAt（每次生成必变），只比对内容实质
function contentKey(m) {
  return JSON.stringify({ schema: m.schema, patches: m.patches });
}

function main() {
  const isCheck = process.argv.includes('--check');
  try {
    const manifest = build();
    const out = JSON.stringify(manifest, null, 2) + '\n';
    if (isCheck) {
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8')); } catch { /* 缺失/损坏视为不一致 */ }
      if (!existing || contentKey(existing) !== contentKey(manifest)) {
        console.error('manifest.json 与 patches/ 不一致（新增/修改补丁后未重新生成）。请运行 npm run build:manifest 并提交。');
        process.exit(1);
      }
      console.log('manifest 校验通过: ' + manifest.patches.length + ' 条补丁');
    } else {
      fs.writeFileSync(MANIFEST_FILE, out, 'utf-8');
      console.log('已生成 ' + MANIFEST_FILE + '（' + manifest.patches.length + ' 条补丁）');
    }
  } catch (e) {
    console.error('生成失败:', e.message);
    process.exit(1);
  }
}

main();
