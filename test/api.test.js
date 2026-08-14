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

// 原样请求（保留响应头），用于 CORS 断言
function rawReq(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('CORS 默认关闭：OPTIONS 不走预检，响应无 ACAO 头', async () => {
  const { srv } = await startServer(); // cors 默认 false
  const pre = await rawReq(srv.port(), 'OPTIONS', '/letter', { Origin: 'null', 'Access-Control-Request-Method': 'POST' });
  assert.notEqual(pre.status, 204, '未开放预检');
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
  const post = await rawReq(srv.port(), 'POST', '/letter', { 'Content-Type': 'application/json', 'X-RimLetter-Token': 'testtoken', Origin: 'null' }, JSON.stringify({ severity: 'NeutralEvent', title: 't' }));
  assert.equal(post.status, 200);
  assert.equal(post.headers['access-control-allow-origin'], undefined);
  await srv.stop();
});

test('CORS 开启：OPTIONS 预检 204，POST 响应带 ACAO 头', async () => {
  const { srv } = await startServer({ cors: true });
  const pre = await rawReq(srv.port(), 'OPTIONS', '/letter', { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-rimletter-token' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], '*');
  const post = await rawReq(srv.port(), 'POST', '/letter', { 'Content-Type': 'application/json', 'X-RimLetter-Token': 'testtoken', Origin: 'null' }, JSON.stringify({ severity: 'NeutralEvent', title: 't' }));
  assert.equal(post.status, 200);
  assert.equal(post.headers['access-control-allow-origin'], '*');
  await srv.stop();
});

test('POST 请求体超过 1MB 返回 413 而非挂起', async () => {
  const { srv, req } = await startServer();
  const big = 'a'.repeat(1_000_001);
  const res = await req('POST', '/letter', { severity: 'ThreatSmall', title: big });
  assert.equal(res.status, 413);
  await srv.stop();
});

test('start 缺省 host 绑定 127.0.0.1', async () => {
  const { srv } = await startServer();
  assert.equal(srv.host(), '127.0.0.1');
  await srv.stop();
});

test('start 支持显式指定绑定 host（0.0.0.0）', async () => {
  const srv = createApiServer({
    token: 't', onLetter: () => {}, getState: async () => ({}), getRules: () => [],
    addRule: () => ({}), updateRule: () => ({}), deleteRule: () => ({}), reload: () => ({})
  });
  await srv.start(0, '0.0.0.0');
  assert.equal(srv.host(), '0.0.0.0');
  await srv.stop();
});
