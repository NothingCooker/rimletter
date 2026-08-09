// src/main/monitor.js
const { evaluateRules } = require('./rules');

function createMonitor({ sensors, rules, onEvent, pollIntervalMs = 2000, getRules }) {
  let timer = null;
  let state = {};
  const getRulesFn = getRules || (() => rules);

  async function tick(now = Date.now()) {
    let snapshot;
    try {
      snapshot = await sensors.snapshot();
    } catch (e) {
      return { alerts: [], recoveries: [], error: e };
    }
    const { alerts, recoveries, nextState } = evaluateRules(getRulesFn(), snapshot, state, now);
    state = nextState;
    for (const a of alerts) onEvent({ type: 'alert', alert: a, snapshot, at: now });
    for (const r of recoveries) onEvent({ type: 'recovery', recovery: r, snapshot, at: now });
    return { alerts, recoveries };
  }

  function start() {
    if (timer) return;
    const loop = async () => { await tick(); timer = setTimeout(loop, pollIntervalMs); };
    timer = setTimeout(loop, pollIntervalMs);
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function resetState() { state = {}; }

  return { tick, start, stop, resetState };
}

module.exports = { createMonitor };
