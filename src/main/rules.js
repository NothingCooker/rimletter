// src/main/rules.js

// 默认回落百分比：告警后数值需降到阈值×(1−pct%) 以下（“>”规则）才允许发恢复信、
// 并重置状态以便下一次告警，防止数值在阈值附近抖动导致告警/恢复频繁交替。
// 单条规则可用 recoverPct 覆盖（0 = 不设回落门槛，回落即恢复）。
const DEFAULT_RECOVER_PCT = 5;

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

function recoverPctOf(rule) {
  const v = rule && rule.recoverPct;
  return (typeof v === 'number' && isFinite(v)) ? v : DEFAULT_RECOVER_PCT;
}

// 恢复（回落）门槛：告警后数值需越过此线才算真正恢复。
// “>” 类：阈值×(1−pct/100)；“<” 类：阈值×(1+pct/100)；“==” 无门槛。
function rearmLevel(rule) {
  const pct = recoverPctOf(rule);
  if (!pct) return null;
  if (rule.operator === '<' || rule.operator === '<=') return rule.threshold * (1 + pct / 100);
  if (rule.operator === '==') return null;
  return rule.threshold * (1 - pct / 100);
}

// 数值是否仍处于「回落带」内（未越过回落线 → 仍视为未恢复，保持告警）。
function stillInBand(value, rule) {
  const lvl = rearmLevel(rule);
  if (lvl === null) return compare(value, rule.operator, rule.threshold);
  if (rule.operator === '<' || rule.operator === '<=') return value < lvl;
  return value > lvl;
}

// 数组型传感器（磁盘多挂载点）可按 rule.mount 精确筛选：只评估指定挂载点，
// 未设置则评估全部（旧行为）。筛选后无匹配项视为无数据（不告警、也不误判恢复）。
function extractValues(sensor, metric, snapshot, rule) {
  const data = snapshot[sensor];
  if (data === undefined || data === null) return [];
  if (Array.isArray(data)) {
    const mount = rule && rule.mount;
    return data
      .filter(item => !mount || (item && String(item.mount) === String(mount)))
      .map(item => ({
        value: item && item[metric] !== undefined ? item[metric] : undefined,
        meta: item
      }))
      .filter(x => typeof x.value === 'number' && isFinite(x.value));
  }
  const v = data[metric];
  if (typeof v !== 'number' || !isFinite(v)) return [];
  return [{ value: v, meta: data }];
}

function evaluateOne(rule, entries, st, now) {
  // 任一实例满足条件则视为超限
  const over = entries.some(e => compare(e.value, rule.operator, rule.threshold));
  if (over) {
    if (st.status === 'idle') {
      if (rule.durationMs > 0) return { status: 'watching', since: now };
      return { status: 'alerting', since: now, alert: buildAlert(rule, entries) };
    }
    if (st.status === 'watching') {
      if (now - st.since >= rule.durationMs) return { status: 'alerting', since: st.since, alert: buildAlert(rule, entries) };
      return { status: 'watching', since: st.since };
    }
    return { status: 'alerting', since: st.since };
  }
  // 不再超限
  if (st.status === 'watching') {
    // 观察期（尚未真正告警）回落：静默放弃，不发恢复信，避免「无告警的恢复信」
    return { status: 'idle', since: now };
  }
  if (st.status === 'alerting') {
    // 无数据时不误判恢复（传感器暂时读不到 ≠ 已恢复）
    if (entries.length === 0) return { status: 'alerting', since: st.since };
    if (!entries.some(e => stillInBand(e.value, rule))) {
      // 所有实例都越过回落线 → 真正恢复
      return { status: 'idle', since: now, recovery: { ruleId: rule.id, label: rule.label, severity: 'PositiveEvent', description: rule.label + '：已恢复正常' } };
    }
    // 仍处于回落带内：保持告警，不发恢复，避免阈值附近抖动造成频繁交替
    return { status: 'alerting', since: st.since };
  }
  return { status: 'idle', since: now };
}

function evaluateRules(rules, snapshot, prevState = {}, now = Date.now()) {
  const alerts = [];
  const recoveries = [];
  const nextState = {};
  for (const rule of rules) {
    if (!rule.enabled) { nextState[rule.id] = { status: 'idle', since: now }; continue; }
    const entries = extractValues(rule.sensor, rule.metric, snapshot, rule);
    const st = prevState[rule.id] || { status: 'idle', since: now };
    const out = evaluateOne(rule, entries, st, now);
    nextState[rule.id] = out;
    if (out.alert) alerts.push(out.alert);
    if (out.recovery) recoveries.push(out.recovery);
  }
  return { alerts, recoveries, nextState };
}

// 返回「已启用规则引用的传感器」集合（去重、保序），供轮询只读取所需传感器，
// 避免对未使用传感器（如 GPU 的 nvidia-smi 查询）做无谓轮询。
function neededSensors(rules) {
  const set = new Set();
  for (const r of rules) {
    if (r.enabled && r.sensor) set.add(r.sensor);
  }
  return [...set];
}

function buildAlert(rule, entries) {
  const alert = {
    ruleId: rule.id,
    sensor: rule.sensor,
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

// 规则缺 id 时按前缀生成，插件/API 注册路径统一兜底——避免多个无 id 规则共用同一个
// prevState[undefined]/nextState[undefined] 状态槽（一条告警会让所有无 id 规则同时告警）。
// 原地回写：同一规则对象重复注册仍是同 id，不破坏 registerRule 的按 id upsert 语义。
function ensureRuleId(rule, prefix = 'rule') {
  if (rule && !rule.id) rule.id = (prefix || 'rule') + '-' + Math.random().toString(36).slice(2, 8);
  return rule;
}

module.exports = { evaluateRules, compare, neededSensors, DEFAULT_RECOVER_PCT, rearmLevel, stillInBand, ensureRuleId };
