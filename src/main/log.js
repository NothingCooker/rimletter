// src/main/log.js — 轻量文件日志
// 按级别写 %APPDATA%\rimletter\logs\rimletter.log，超过 maxBytes 时轮转到 .1.log。
// 每次写按行追加，低频率场景够用；错误对象/对象参数自动序列化。
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_MAX_BYTES = 1_000_000; // 1MB 轮转

function serializeArg(a) {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

function createLogger({ dir, level = 'info', maxBytes = DEFAULT_MAX_BYTES, now = Date.now, name = 'rimletter' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.log');
  const rotateFile = path.join(dir, name + '.1.log');
  const threshold = LEVELS[level] != null ? LEVELS[level] : LEVELS.info;

  function write(line) {
    try {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size + line.length > maxBytes) {
        try { fs.renameSync(file, rotateFile); } catch (e) { /* 轮转失败（如文件被占用）则忽略，继续追加 */ }
      }
      fs.appendFileSync(file, line, 'utf-8');
    } catch (e) { /* 日志写入失败不抛给调用方 */ }
  }

  function make(levelName) {
    if (LEVELS[levelName] < threshold) return () => {};
    return (...args) => {
      const ts = new Date(now()).toISOString();
      write(ts + ' [' + levelName.toUpperCase() + '] ' + args.map(serializeArg).join(' ') + '\n');
    };
  }

  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    _file: file
  };
}

module.exports = { createLogger, LEVELS };
