// src/main/api.js
const http = require('node:http');

function createApiServer({ token, onLetter, getState, getRules, addRule, updateRule, deleteRule, reload }) {
  let server = null;
  let port = 0;

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const auth = req.headers['x-rimletter-token'];
    if (auth !== token) { json(res, 401, { error: 'unauthorized' }); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && parts[0] === 'health') {
        json(res, 200, { status: 'ok', version: '0.1.0' });
      } else if (req.method === 'POST' && parts[0] === 'letter') {
        const body = await readBody(req);
        if (!body.severity || !body.title) { json(res, 400, { error: 'severity and title required' }); return; }
        onLetter(body);
        json(res, 200, { ok: true });
      } else if (req.method === 'GET' && parts[0] === 'state') {
        json(res, 200, await getState());
      } else if (req.method === 'GET' && parts[0] === 'rules') {
        json(res, 200, getRules());
      } else if (req.method === 'POST' && parts[0] === 'rules') {
        const body = await readBody(req);
        json(res, 200, addRule(body));
      } else if (req.method === 'PUT' && parts[0] === 'rules' && parts[1]) {
        const body = await readBody(req);
        json(res, 200, updateRule(parts[1], body));
      } else if (req.method === 'DELETE' && parts[0] === 'rules' && parts[1]) {
        json(res, 200, deleteRule(parts[1]));
      } else if (req.method === 'POST' && parts[0] === 'reload') {
        json(res, 200, reload());
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      json(res, 400, { error: String(e.message || e) });
    }
  }

  return {
    start(p = 0) {
      return new Promise(resolve => {
        server = http.createServer(handle);
        server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve(); });
      });
    },
    stop() {
      return new Promise(resolve => { if (server) server.close(resolve); else resolve(); });
    },
    port: () => port
  };
}

module.exports = { createApiServer };
