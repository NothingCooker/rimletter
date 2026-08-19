const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPatcher, sha256Hex } = require('../src/main/patcher');

const REPO_ROOT = path.join(__dirname, '..');

// 读取 patches/ 下所有补丁源码文件（*.js，不含 manifest.json）
function listPatchFiles() {
  const dir = path.join(REPO_ROOT, 'patches');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
}

// 构造与引擎一致的 ctx：patchModule 指向真实应用模块（appPath=仓库根），
// patched 用本地 Set 模拟引擎的 state.applied 语义
function makeCtx() {
  const applied = new Set();
  const patcher = createPatcher({ appPath: REPO_ROOT, requireFn: require });
  return {
    ctx: { patched: id => applied.has(id), patchModule: patcher.patchModule, log: () => {} },
    markApplied: id => applied.add(id)
  };
}

test('补丁目录存在且至少一个补丁', () => {
  assert.ok(listPatchFiles().length >= 1, 'patches/ 下应有补丁文件');
});

test('每个补丁文件导出 apply 函数且 apply 不抛错', () => {
  for (const f of listPatchFiles()) {
    const mod = require(path.join(REPO_ROOT, 'patches', f));
    assert.equal(typeof mod.apply, 'function', f + ' 应导出 apply(ctx)');
    const { ctx } = makeCtx();
    assert.doesNotThrow(() => mod.apply(ctx), f + ' apply 不应抛错');
  }
});

test('补丁幂等自检：已应用后 apply 不再重复执行', () => {
  const lettersMod = require('../src/main/letters');
  const orig = lettersMod.formatLetter;
  try {
    const mod = require(path.join(REPO_ROOT, 'patches', 'fix-001-empty-letter-label'));
    const { ctx, markApplied } = makeCtx();
    mod.apply(ctx);            // 第一次：包装
    markApplied('fix-001-empty-letter-label');
    mod.apply(ctx);            // 第二次：ctx.patched 命中，直接返回
    assert.equal(lettersMod.formatLetter('ThreatBig', '', 'd').label, 'ThreatBig');
  } finally {
    lettersMod.formatLetter = orig;
  }
});

test('fix-001：formatLetter 空标题回退为紧急度名（对象访问链路生效）', () => {
  const lettersMod = require('../src/main/letters');
  const orig = lettersMod.formatLetter;
  try {
    const mod = require(path.join(REPO_ROOT, 'patches', 'fix-001-empty-letter-label'));
    const { ctx } = makeCtx();
    mod.apply(ctx);
    // 空/空白标题 → 回退为紧急度名
    assert.equal(lettersMod.formatLetter('ThreatBig', '', 'desc').label, 'ThreatBig');
    assert.equal(lettersMod.formatLetter('PositiveEvent', '   ', 'desc').label, 'PositiveEvent');
    assert.equal(lettersMod.formatLetter('UnknownSev', '', 'desc').label, 'UnknownSev');
    // 正常标题不受影响
    const normal = lettersMod.formatLetter('NeutralEvent', '标题', 'x');
    assert.equal(normal.label, '标题');
    assert.equal(normal.severity, 'NeutralEvent');
  } finally {
    lettersMod.formatLetter = orig;
  }
});

test('fix-001 端到端：applyAll 下载→校验→应用后行为真实改变', async () => {
  const lettersMod = require('../src/main/letters');
  const orig = lettersMod.formatLetter;
  try {
    const patchFile = 'fix-001-empty-letter-label.js';
    const patchSrc = fs.readFileSync(path.join(REPO_ROOT, 'patches', patchFile), 'utf-8');
    const sha = 'a'.repeat(40);
    const manifest = JSON.stringify({
      schema: 1,
      updatedAt: '2026-08-18T00:00:00Z',
      patches: [{
        id: 'fix-001-empty-letter-label',
        title: '信标题为空时回退为紧急度名',
        minVersion: '1.0.0',
        maxVersion: '1.0.99',
        platforms: ['win32', 'linux'],
        file: 'patches/' + patchFile,
        sha256: sha256Hex(patchSrc)
      }]
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-e2e-state-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-e2e-cache-'));
    const route = {};
    route['https://cdn.jsdelivr.net/gh/NothingCooker/rimletter@' + sha + '/patches/manifest.json'] = { text: manifest };
    route['https://cdn.jsdelivr.net/gh/NothingCooker/rimletter@' + sha + '/patches/' + patchFile] = { text: patchSrc };
    const patcher = createPatcher({
      appVersion: '1.0.5',
      platform: process.platform,
      fetch: async (url, opts = {}) => {
        const r = route[url];
        if (!r) throw new Error('fetch not stubbed: ' + url);
        if (opts.signal && opts.signal.aborted) throw new Error('aborted');
        return { ok: true, status: 200, text: async () => r.text };
      },
      appPath: REPO_ROOT,
      stateFile: path.join(stateDir, 'patch-state.json'),
      cacheDir,
      log: () => {},
      getConfig: () => ({ enabled: true, timeoutMs: 3000, applyTimeoutMs: 1000, fetchTimeoutMs: 2000, crashThreshold: 2, channel: 'stable' }),
      resolve: async () => ({ channel: 'github', sha })
    });
    const res = await patcher.applyAll();
    assert.equal(res.ok, true);
    assert.deepEqual(res.applied.map(p => p.id), ['fix-001-empty-letter-label']);
    // 补丁真实生效：空标题回退为紧急度名
    assert.equal(lettersMod.formatLetter('ThreatBig', '', 'desc').label, 'ThreatBig');
    assert.equal(patcher.getState().applied.length, 1);
  } finally {
    lettersMod.formatLetter = orig;
  }
});
