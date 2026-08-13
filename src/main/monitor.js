// src/main/monitor.js
const { evaluateRules, neededSensors } = require('./rules');

function createMonitor({ sensors, rules, onEvent, pollIntervalMs = 2000, getRules, recoveriesEnabled, onError }) {
  let timer = null;
  let state = {};
  const getRulesFn = getRules || (() => rules);
  const shouldBroadcastRecovery = recoveriesEnabled || (() => true);

  async function tick(now = Date.now()) {
    const rules = getRulesFn();
    let snapshot;
    try {
      // 只轮询已启用规则引用的传感器；没有任何启用规则时 snapshot({}) 为空、直接跳过
      snapshot = await sensors.snapshot(neededSensors(rules));
    } catch (e) {
      if (onError) onError(e);
      return { alerts: [], recoveries: [], error: e };
    }
    const { alerts, recoveries, nextState } = evaluateRules(rules, snapshot, state, now);
    state = nextState;
    for (const a of alerts) onEvent({ type: 'alert', alert: a, snapshot, at: now });
    // 恢复信可被开关关闭：关闭时状态机仍正常复位（evaluateRules 已更新 state），只是不广播
    for (const r of recoveries) if (shouldBroadcastRecovery()) onEvent({ type: 'recovery', recovery: r, snapshot, at: now });
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
