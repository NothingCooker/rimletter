// src/main/rules.js
function compare(value, operator, threshold) {
  switch (operator) {
    case '>':  return value > threshold;
    case '>=': return value >= threshold;
    case '<':  return value < threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    default: return false;
  }
}

function extractValues(sensor, metric, snapshot) {
  const data = snapshot[sensor];
  if (data === undefined || data === null) return [];
  if (Array.isArray(data)) {
    return data.map(item => ({
      value: item && item[metric] !== undefined ? item[metric] : undefined,
      meta: item
    })).filter(x => typeof x.value === 'number' && isFinite(x.value));
  }
  const v = data[metric];
  if (typeof v !== 'number' || !isFinite(v)) return [];
  return [{ value: v, meta: data }];
}

function evaluateRules(rules, snapshot, prevState = {}, now = Date.now()) {
  const alerts = [];
  const recoveries = [];
  const nextState = {};
  for (const rule of rules) {
    if (!rule.enabled) { nextState[rule.id] = { status: 'idle', since: now }; continue; }
    const entries = extractValues(rule.sensor, rule.metric, snapshot);
    const st = prevState[rule.id] || { status: 'idle', since: now };
    // 任一实例满足条件则视为超限
    const over = entries.some(e => compare(e.value, rule.operator, rule.threshold));
    if (over) {
      if (st.status === 'idle') {
        if (rule.durationMs > 0) nextState[rule.id] = { status: 'watching', since: now };
        else { nextState[rule.id] = { status: 'alerting', since: now }; alerts.push(buildAlert(rule, entries)); }
      } else if (st.status === 'watching') {
        if (now - st.since >= rule.durationMs) {
          nextState[rule.id] = { status: 'alerting', since: st.since };
          alerts.push(buildAlert(rule, entries));
        } else {
          nextState[rule.id] = { status: 'watching', since: st.since };
        }
      } else {
        nextState[rule.id] = { status: 'alerting', since: st.since };
      }
    } else {
      if (st.status === 'alerting' || st.status === 'watching') {
        recoveries.push({ ruleId: rule.id, label: rule.label, severity: 'PositiveEvent', description: rule.label + '：已恢复正常' });
      }
      nextState[rule.id] = { status: 'idle', since: now };
    }
  }
  return { alerts, recoveries, nextState };
}

function buildAlert(rule, entries) {
  const alert = {
    ruleId: rule.id,
    severity: rule.severity,
    label: rule.label,
    description: rule.description,
    sound: rule.sound,
    value: entries.length ? entries[0].value : undefined,
    threshold: rule.threshold,
    operator: rule.operator
  };
  const first = entries[0];
  if (rule.sensor === 'disk' && first && first.meta) alert.mount = first.meta.mount;
  return alert;
}

module.exports = { evaluateRules, compare };
