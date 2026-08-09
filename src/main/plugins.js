// src/main/plugins.js
const fs = require('node:fs');
const path = require('node:path');

async function loadPlugins({ pluginsDir, apiFactory }) {
  const results = [];
  if (!fs.existsSync(pluginsDir)) return results;
  const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const name = path.basename(file, '.js');
    const fullPath = path.join(pluginsDir, file);
    const entry = { name, file, error: null, loaded: false };
    try {
      delete require.cache[require.resolve(fullPath)];
      const mod = require(fullPath);
      if (typeof mod !== 'function' && typeof mod !== 'object') throw new Error('plugin must export a function or object');
      const fn = typeof mod === 'function' ? mod : mod.load;
      if (typeof fn !== 'function') throw new Error('plugin must export a function or a { load } function');
      const api = apiFactory(name);
      await fn(api);
      entry.loaded = true;
    } catch (e) {
      entry.error = String(e.message || e);
    }
    results.push(entry);
  }
  return results;
}

module.exports = { loadPlugins };
