const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultState, sha256Hex, parsePatchManifest, isApplicable, createPatcher } = require('../src/main/patcher');

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);
const CDN = f => 'https://cdn.jsdelivr.net/gh/o/rimletter@' + SHA + '/' + f;

// ===== 测试工具 =====

// 按路径路由的 fetch mock：route[url] = {ok, text} 或 {error}；支持 AbortSignal（拒绝挂起请求）
function routeFetch(route) {
  return (url, opts = {}) => new Promise((resolve, reject) => {
    const signal = opts.signal;
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(new Error('aborted')); };
    if (signal && signal.aborted) return reject(new Error('aborted'));
    if (signal) signal.addEventListener('abort', onAbort);
    const r = route[url];
    if (!r) { cleanup(); reject(new Error('fetch not stubbed: ' + url)); }
    else if (r.error) { cleanup(); reject(r.error); }
    else { cleanup(); resolve({ ok: r.ok !== false, status: r.status || 200, text: async () => r.text }); }
  });
}

const PATCH_SRC = 'module.exports = { apply(ctx) { ctx.log("applied"); } };';
const PATCH_SHA = sha256Hex(PATCH_SRC);

function entry(overrides = {}) {
  return {
    id: 'fix-001', title: '修复X', minVersion: '1.0.0', maxVersion: '1.0.99',
    platforms: ['win32', 'linux'], file: 'patches/fix-001.js', sha256: PATCH_SHA,
    ...overrides
  };
}

function makeManifest(patches) {
  return JSON.stringify({ schema: 1, updatedAt: '2026-08-18T00:00:00Z', patches });
}

function makePatcher(overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-state-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-cache-'));
  const stateFile = path.join(stateDir, 'patch-state.json');
  const logs = [];
  const cfg = {
    enabled: true, repo: 'o/rimletter', branch: 'master',
    timeoutMs: 2000, applyTimeoutMs: 500, fetchTimeoutMs: 200, crashThreshold: 2, channel: 'stable',
    ...(overrides.cfg || {})
  };
  const patcher = createPatcher({
    appVersion: overrides.appVersion || '1.0.5',
    platform: overrides.platform || 'win32',
    fetch: overrides.fetch,
    appPath: overrides.appPath,
    stateFile,
    cacheDir,
    log: (level, msg) => logs.push([level, msg]),
    getConfig: () => cfg,
    resolve: overrides.resolve,
    requireFn: require
  });
  return { patcher, cfg, logs, stateFile };
}

// ===== parsePatchManifest =====

test('parsePatchManifest 解析合法清单并归一字段', () => {
  const text = makeManifest([entry({ title: '修复磁盘误报' })]);
  const { patches, skipped } = parsePatchManifest(text);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].id, 'fix-001');
  assert.equal(patches[0].title, '修复磁盘误报');
  assert.equal(patches[0].minVersion, '1.0.0');
  assert.equal(patches[0].channel, 'stable');
  assert.equal(skipped.length, 0);
});

test('parsePatchManifest 缺省字段回退默认值', () => {
  const text = makeManifest([{ id: 'fix-002', file: 'patches/fix-002.js', sha256: PATCH_SHA }]);
  const { patches } = parsePatchManifest(text);
  assert.equal(patches[0].minVersion, '0.0.0');
  assert.equal(patches[0].maxVersion, '9999.9999.9999');
  assert.equal(patches[0].platforms, null);
  assert.equal(patches[0].title, 'fix-002');
});

test('parsePatchManifest 非 JSON / 缺 schema / 缺 patches 抛错', () => {
  assert.throws(() => parsePatchManifest('not json'), /JSON/);
  assert.throws(() => parsePatchManifest('{"a":1}'), /schema/);
  assert.throws(() => parsePatchManifest('{"schema":1}'), /patches/);
});

test('parsePatchManifest 非法条目跳过，其余保留', () => {
  const logs = [];
  const text = makeManifest([
    { id: 'bad/id', file: 'patches/bad.js', sha256: PATCH_SHA },          // id 非法
    { id: 'bad2', file: 'other/fix.js', sha256: PATCH_SHA },              // file 不在 patches/
    { id: 'bad3', file: 'patches/../x.js', sha256: PATCH_SHA },           // file 路径穿越
    { id: 'bad4', file: 'patches/x.js', sha256: 'zzz' },                  // sha256 非法
    entry({ id: 'good' })
  ]);
  const { patches, skipped } = parsePatchManifest(text, (l, m) => logs.push([l, m]));
  assert.equal(patches.length, 1);
  assert.equal(patches[0].id, 'good');
  assert.equal(skipped.length, 4);
  assert.ok(logs.some(([, m]) => m.includes('bad4')));
});

// ===== isApplicable =====

test('isApplicable 版本范围过滤（含预发布）', () => {
  const p = entry();
  const state = defaultState();
  assert.equal(isApplicable(p, { appVersion: '1.0.5', platform: 'win32', state, channel: 'stable' }), true);
  assert.equal(isApplicable(p, { appVersion: '0.9.9', platform: 'win32', state, channel: 'stable' }), '版本低于 minVersion');
  assert.equal(isApplicable(p, { appVersion: '1.1.0', platform: 'win32', state, channel: 'stable' }), '版本高于 maxVersion');
  assert.equal(isApplicable(p, { appVersion: '1.0.0-beta', platform: 'win32', state, channel: 'stable' }), '版本低于 minVersion');
});

test('isApplicable 平台/禁用/已应用/通道过滤', () => {
  const p = entry();
  const state = defaultState();
  assert.equal(isApplicable(p, { appVersion: '1.0.5', platform: 'darwin', state, channel: 'stable' }), '平台不匹配');
  assert.equal(isApplicable({ ...p, platforms: null }, { appVersion: '1.0.5', platform: 'darwin', state, channel: 'stable' }), true);
  assert.equal(isApplicable(p, { appVersion: '1.0.5', platform: 'win32', state: { ...state, disabled: ['fix-001'] }, channel: 'stable' }), '已被禁用');
  assert.equal(isApplicable(p, { appVersion: '1.0.5', platform: 'win32', state: { ...state, applied: [{ id: 'fix-001' }] }, channel: 'stable' }), '已应用');
  assert.equal(isApplicable({ ...p, channel: 'beta' }, { appVersion: '1.0.5', platform: 'win32', state, channel: 'stable' }), '通道不匹配');
});

// ===== preflight 崩溃熔断 =====

test('preflight 干净状态：置 lastExitOk=false 写盘，无回滚', () => {
  const { patcher, stateFile } = makePatcher();
  const r = patcher.preflight();
  assert.equal(r.rolledBack, null);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  assert.equal(saved.lastExitOk, false);
  assert.equal(saved.crashes, 0);
});

test('preflight 上次异常 + 计数达阈值 → 回滚最近补丁并清零', () => {
  const { patcher, stateFile } = makePatcher();
  fs.writeFileSync(stateFile, JSON.stringify({
    schema: 1, applied: [{ id: 'fix-001', at: 't1' }, { id: 'fix-002', at: 't2' }],
    disabled: [], crashes: 1, lastExitOk: false
  }), 'utf-8');
  const r = patcher.preflight();
  assert.equal(r.rolledBack, 'fix-002');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  assert.deepEqual(saved.disabled, ['fix-002']);
  assert.deepEqual(saved.applied.map(p => p.id), ['fix-001']);
  assert.equal(saved.crashes, 0);
});

test('preflight 异常次数低于阈值不回滚', () => {
  const { patcher, cfg, stateFile } = makePatcher({ cfg: { crashThreshold: 3 } });
  fs.writeFileSync(stateFile, JSON.stringify({
    schema: 1, applied: [{ id: 'fix-001', at: 't1' }], disabled: [], crashes: 1, lastExitOk: false
  }), 'utf-8');
  const r = patcher.preflight();
  assert.equal(r.rolledBack, null);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  assert.equal(saved.crashes, 2);
  assert.deepEqual(saved.disabled, []);
});

test('preflight 达阈值但无补丁可回滚 → 不干预', () => {
  const { patcher, stateFile } = makePatcher();
  fs.writeFileSync(stateFile, JSON.stringify({
    schema: 1, applied: [], disabled: [], crashes: 1, lastExitOk: false
  }), 'utf-8');
  const r = patcher.preflight();
  assert.equal(r.rolledBack, null);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  assert.equal(saved.crashes, 2);
});

test('preflight 状态文件损坏 → 重置默认', () => {
  const { patcher, stateFile } = makePatcher();
  fs.writeFileSync(stateFile, '{{{', 'utf-8');
  const r = patcher.preflight();
  assert.equal(r.rolledBack, null);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).crashes, 0);
});

test('markExitOk 标记正常并清零', () => {
  const { patcher, stateFile } = makePatcher();
  patcher.preflight();
  fs.writeFileSync(stateFile, JSON.stringify({ schema: 1, applied: [], disabled: [], crashes: 5, lastExitOk: false }), 'utf-8');
  patcher.markExitOk();
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  assert.equal(saved.lastExitOk, true);
  assert.equal(saved.crashes, 0);
});

// ===== applyAll =====

function happyFetch() {
  const manifest = makeManifest([entry()]);
  return routeFetch({
    [CDN('patches/manifest.json')]: { text: manifest },
    [CDN('patches/fix-001.js')]: { text: PATCH_SRC }
  });
}

test('applyAll 完整链路：应用成功并持久化', async () => {
  const { patcher, logs, stateFile } = makePatcher({
    fetch: happyFetch(),
    resolve: async () => ({ channel: 'github', sha: SHA })
  });
  const r = await patcher.applyAll();
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied.map(p => p.id), ['fix-001']);
  assert.equal(r.failed.length, 0);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  assert.equal(saved.applied[0].id, 'fix-001');
  assert.ok(saved.applied[0].at);
  assert.ok(logs.some(([, m]) => m.includes('已应用 fix-001')));
});

test('applyAll 幂等：第二次调用直接跳过', async () => {
  const { patcher } = makePatcher({ fetch: happyFetch(), resolve: async () => ({ channel: 'github', sha: SHA }) });
  await patcher.applyAll();
  const r2 = await patcher.applyAll();
  assert.equal(r2.reason, 'already-applied');
  assert.equal(r2.applied.length, 0);
});

test('applyAll sha256 不符 → 丢弃不应用', async () => {
  const { patcher } = makePatcher({
    fetch: routeFetch({
      [CDN('patches/manifest.json')]: { text: makeManifest([entry()]) },
      [CDN('patches/fix-001.js')]: { text: 'module.exports = { apply() {} };' }
    }),
    resolve: async () => ({ channel: 'github', sha: SHA })
  });
  const r = await patcher.applyAll();
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.failed.map(f => f.id), ['fix-001']);
  assert.match(r.failed[0].error, /sha256/);
});

test('applyAll 单补丁失败不中断其余，且过滤掉已应用/禁用/版本不符', async () => {
  const badSrc = 'module.exports = { apply() { throw new Error("boom"); } };';
  const manifest = makeManifest([
    entry({ id: 'fix-ok', file: 'patches/fix-ok.js', sha256: PATCH_SHA }),
    entry({ id: 'fix-bad', file: 'patches/fix-bad.js', sha256: sha256Hex(badSrc) }),
    entry({ id: 'fix-new', minVersion: '1.1.0' }),
    entry({ id: 'fix-disabled' })
  ]);
  const { patcher, stateFile } = makePatcher({
    fetch: routeFetch({
      [CDN('patches/manifest.json')]: { text: manifest },
      [CDN('patches/fix-ok.js')]: { text: PATCH_SRC },
      [CDN('patches/fix-bad.js')]: { text: badSrc }
    }),
    resolve: async () => ({ channel: 'github', sha: SHA })
  });
  // 通过状态文件注入「fix-disabled 已被禁用」，preflight 载入
  fs.writeFileSync(stateFile, JSON.stringify({
    schema: 1, applied: [], disabled: ['fix-disabled'], crashes: 0, lastExitOk: true
  }), 'utf-8');
  patcher.preflight();
  const r = await patcher.applyAll();
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied.map(p => p.id), ['fix-ok']);
  assert.deepEqual(r.failed.map(f => f.id), ['fix-bad']);
  assert.match(r.failed[0].error, /boom/);
  assert.deepEqual(r.skipped.map(s => s.id).sort(), ['fix-disabled', 'fix-new']);
});

test('applyAll 平台过滤', async () => {
  const { patcher } = makePatcher({
    platform: 'darwin',
    fetch: routeFetch({
      [CDN('patches/manifest.json')]: { text: makeManifest([entry()]) }
    }),
    resolve: async () => ({ channel: 'github', sha: SHA })
  });
  const r = await patcher.applyAll();
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.skipped.map(s => s.id), ['fix-001']);
  assert.match(r.skipped[0].reason, /平台/);
});

test('applyAll resolve 失败 → resolve-failed，不抛错', async () => {
  const { patcher } = makePatcher({ fetch: routeFetch({}), resolve: async () => null });
  const r = await patcher.applyAll();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'resolve-failed');
});

test('applyAll manifest 全部通道失败 → manifest-fetch-failed', async () => {
  const { patcher } = makePatcher({ fetch: routeFetch({}), resolve: async () => ({ channel: 'github', sha: SHA }) });
  const r = await patcher.applyAll();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'manifest-fetch-failed');
});

test('applyAll manifest 非法 → manifest-invalid', async () => {
  const { patcher } = makePatcher({
    fetch: routeFetch({
      [CDN('patches/manifest.json')]: { text: '{"schema":9}' }
    }),
    resolve: async () => ({ channel: 'github', sha: SHA })
  });
  const r = await patcher.applyAll();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'manifest-invalid');
});

test('applyAll 禁用 / 无网络 / 无 fetch 直接跳过', async () => {
  const { patcher: p1, cfg } = makePatcher();
  cfg.enabled = false;
  assert.equal((await p1.applyAll()).reason, 'disabled');
  const { patcher: p2 } = makePatcher();
  assert.equal((await p2.applyAll()).reason, 'no-fetch');
});

test('applyAll 整体超时：resolve 挂起返回 timeout 不卡死', async () => {
  const { patcher } = makePatcher({
    cfg: { timeoutMs: 150 },
    fetch: routeFetch({}),
    resolve: () => new Promise(() => {})
  });
  const r = await patcher.applyAll();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
});

test('applyAll 补丁 apply 超时熔断', async () => {
  const hangSrc = 'module.exports = { apply() { return new Promise(() => {}); } };';
  const { patcher } = makePatcher({
    cfg: { applyTimeoutMs: 100 },
    fetch: routeFetch({
      [CDN('patches/manifest.json')]: { text: makeManifest([entry({ sha256: sha256Hex(hangSrc) })]) },
      [CDN('patches/fix-001.js')]: { text: hangSrc }
    }),
    resolve: async () => ({ channel: 'github', sha: SHA })
  });
  const r = await patcher.applyAll();
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, []);
  assert.match(r.failed[0].error, /超时/);
});

// ===== patchModule 作用域 =====

test('patchModule 对真实模块（rules.js）原地替换生效', () => {
  const rules = require('../src/main/rules');
  const origCompare = rules.compare;
  try {
    const { patcher } = makePatcher({ appPath: path.join(__dirname, '..') });
    let calls = 0;
    patcher.patchModule('src/main/rules.js', (exports) => {
      const orig = exports.compare;
      exports.compare = (v, op, t) => { calls++; return orig(v, op, t); };
    });
    assert.equal(rules.compare(15, '>', 10), true);
    assert.equal(calls, 1);
  } finally {
    rules.compare = origCompare;
  }
});

test('patchModule 对导出非对象的模块抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-app-'));
  fs.writeFileSync(path.join(dir, 'fnmod.js'), 'module.exports = function () {};', 'utf-8');
  const { patcher } = makePatcher({ appPath: dir });
  assert.throws(() => patcher.patchModule('fnmod.js', () => {}), /非对象/);
});

test('patchModule 缺 appPath / 非法参数抛错', () => {
  const { patcher } = makePatcher();
  assert.throws(() => patcher.patchModule('src/main/rules.js', () => {}), /appPath/);
  assert.throws(() => patcher.patchModule('', () => {}), /relPath/);
  assert.throws(() => patcher.patchModule('x.js', null), /mutator/);
});
