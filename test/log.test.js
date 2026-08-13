const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('../src/main/log');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rimletter-log-')); }
function read(p) { return fs.readFileSync(p, 'utf-8'); }
const FIXED_NOW = () => 1_700_000_000_000; // 固定时间戳，便于断言

test('写 info 行：ISO 时间戳 + 级别 + 消息，追加换行', () => {
  const dir = tmpDir();
  const log = createLogger({ dir, level: 'info', maxBytes: 1_000_000, now: FIXED_NOW });
  log.info('hello', 'world');
  const content = read(path.join(dir, 'rimletter.log'));
  assert.match(content, /^[0-9T:.Z-]+ \[INFO\] hello world\n$/);
});

test('level 过滤：warn 级别不写 info，写 warn/error', () => {
  const dir = tmpDir();
  const log = createLogger({ dir, level: 'warn', maxBytes: 1_000_000 });
  log.info('skip me');
  log.warn('keep warn');
  log.error('keep error');
  const content = read(path.join(dir, 'rimletter.log'));
  assert.ok(!content.includes('skip me'));
  assert.match(content, /\[WARN\] keep warn/);
  assert.match(content, /\[ERROR\] keep error/);
});

test('Error 对象序列化为 message/stack', () => {
  const dir = tmpDir();
  const log = createLogger({ dir, level: 'info', maxBytes: 1_000_000 });
  log.error(new Error('boom'));
  const content = read(path.join(dir, 'rimletter.log'));
  assert.match(content, /\[ERROR\] Error: boom/);
});

test('对象参数序列化为 JSON', () => {
  const dir = tmpDir();
  const log = createLogger({ dir, level: 'info', maxBytes: 1_000_000 });
  log.info({ a: 1, b: 'x' });
  const content = read(path.join(dir, 'rimletter.log'));
  assert.match(content, /\{"a":1,"b":"x"\}/);
});

test('超出 maxBytes 轮转：旧内容挪到 .1.log，新文件继续写', () => {
  const dir = tmpDir();
  const log = createLogger({ dir, level: 'info', maxBytes: 300, now: FIXED_NOW });
  for (let i = 0; i < 30; i++) log.info('line-' + i + '-' + 'y'.repeat(40));
  const base = path.join(dir, 'rimletter.log');
  const rot = path.join(dir, 'rimletter.1.log');
  assert.ok(fs.existsSync(rot), '.1.log 应存在（发生轮转）');
  assert.ok(fs.existsSync(base), '新日志文件应存在');
  // 新文件应大致不超过 maxBytes（宽松断言）
  assert.ok(fs.statSync(base).size <= 300 + 200);
});

test('连续写入都追加到同一文件（不互相覆盖）', () => {
  const dir = tmpDir();
  const log = createLogger({ dir, level: 'info', maxBytes: 1_000_000, now: FIXED_NOW });
  log.info('first');
  log.info('second');
  const content = read(path.join(dir, 'rimletter.log'));
  assert.match(content, /first/);
  assert.match(content, /second/);
});

test('目录不存在时自动创建', () => {
  const dir = path.join(os.tmpdir(), 'rimletter-log-mkdir-' + Date.now(), 'nested');
  const log = createLogger({ dir, level: 'info', maxBytes: 1_000_000 });
  log.info('ok');
  assert.ok(fs.existsSync(path.join(dir, 'rimletter.log')));
});
