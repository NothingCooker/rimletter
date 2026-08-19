// 补丁：信标题为空时回退为紧急度名
// 外部 payload（如 Home Assistant 集成）可能传空标题，导致覆盖层出现无文字的信。
// 元数据供 scripts/build_patch_manifest.js 生成 manifest.json（@id 必须与文件内 ctx.patched 一致）。
// @id fix-001-empty-letter-label
// @title 信标题为空时回退为紧急度名
// @minVersion 1.0.0
// @maxVersion 1.0.99
// @platforms win32,linux
// @severity bugfix

module.exports = {
  // 幂等：引擎按 state.applied 过滤已应用补丁，这里用 ctx.patched 自检双保险
  apply(ctx) {
    if (ctx.patched('fix-001-empty-letter-label')) return;
    ctx.patchModule('src/main/letters.js', (exports) => {
      const orig = exports.formatLetter;
      exports.formatLetter = function (severity, label, description, extra, dismissMs) {
        const safeLabel = (typeof label === 'string' && label.trim()) ? label : String(severity == null ? '' : severity);
        return orig(severity, safeLabel, description, extra, dismissMs);
      };
    });
  }
};
