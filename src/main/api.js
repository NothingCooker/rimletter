// src/main/api.js
const http = require('node:http');

function createApiServer({ token, onLetter, getState, getRules, addRule, updateRule, deleteRule, reload, cors = false }) {
  let server = null;
  let port = 0;

  // CORS 默认关闭；仅当 config.api.cors=true（如本机手动发信网页）时开放浏览器跨域调用。
  // 服务默认绑定 127.0.0.1 + token 鉴权；若 api.host 改为 0.0.0.0（局域网推送场景），
  // 局域网内其它设备可带 token 访问管理 API（token 明文 HTTP），需自行评估风险。
  const CORS_HEADERS = cors ? {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-rimletter-token',
    'Access-Control-Max-Age': '86400'
  } : null;

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...(CORS_HEADERS || {}) });
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
    // CORS 预检（仅 cors=true 时开放）：无 token，需在鉴权前响应
    if (cors && req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
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
    start(p = 0, host = '127.0.0.1') {
      return new Promise(resolve => {
        server = http.createServer(handle);
        server.listen(p, host, () => { port = server.address().port; resolve(); });
      });
    },
    stop() {
      return new Promise(resolve => { if (server) server.close(resolve); else resolve(); });
    },
    host: () => (server && server.address() ? server.address().address : '127.0.0.1'),
    port: () => port
  };
}

module.exports = { createApiServer };
