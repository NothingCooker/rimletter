const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApiServer } = require('../src/main/api');

async function startServer(overrides = {}) {
  const ctx = {};
  const srv = createApiServer({
    token: 'testtoken',
    onLetter: (body) => { ctx.lastLetter = body; },
    getState: async () => ({ cpu: { load: 50 } }),
    getRules: () => ([{ id: 'r1' }]),
    addRule: (r) => { ctx.added = r; return { ok: true }; },
    updateRule: (id, r) => { ctx.updated = { id, r }; return { ok: true }; },
    deleteRule: (id) => { ctx.deleted = id; return { ok: true }; },
    reload: () => { ctx.reloaded = true; return { ok: true }; },
    ...overrides
  });
  await srv.start(0); // 随机端口
  const port = srv.port();
  const base = `http://127.0.0.1:${port}`;
  function req(method, path, body, token = 'testtoken') {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', 'X-RimLetter-Token': token } }, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }
  return { srv, req, base, ctx };
}

test('无 token 返回 401', async () => {
  const { srv, req } = await startServer();
  const res = await req('GET', '/health', null, 'wrong');
  assert.equal(res.status, 401);
  await srv.stop();
});

test('GET /health 返回 ok', async () => {
  const { srv, req } = await startServer();
  const res = await req('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  await srv.stop();
});

test('POST /letter 触发播报回调', async () => {
  const { srv, req, ctx } = await startServer();
  const res = await req('POST', '/letter', { severity: 'ThreatSmall', title: '构建完成', description: '产物已生成' });
  assert.equal(res.status, 200);
  assert.equal(ctx.lastLetter.title, '构建完成');
  assert.equal(ctx.lastLetter.severity, 'ThreatSmall');
  await srv.stop();
});

test('POST /letter 无 severity 返回 400', async () => {
  const { srv, req } = await startServer();
  const res = await req('POST', '/letter', { title: 'x' });
  assert.equal(res.status, 400);
  await srv.stop();
});

test('GET /state 返回实时值', async () => {
  const { srv, req } = await startServer();
  const res = await req('GET', '/state');
  assert.equal(res.status, 200);
  assert.equal(res.body.cpu.load, 50);
  await srv.stop();
});

test('GET /rules 与 DELETE /rules/:id 生效', async () => {
  const { srv, req, ctx } = await startServer();
  const list = await req('GET', '/rules');
  assert.equal(list.body.length, 1);
  const del = await req('DELETE', '/rules/r1');
  assert.equal(del.status, 200);
  assert.equal(ctx.deleted, 'r1');
  await srv.stop();
});
