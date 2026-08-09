// plugins/example.js —— 示例插件：注册配置表单 + 自定义传感器 + 规则 + 主动播报
// 把此文件复制到 userData/plugins/ 目录（设置窗口「打开插件目录」可直达）。
// 默认禁用（config.plugins.disabled 含 example），需在 设置→插件管理 中启用。
module.exports = async ({ api, logger }) => {
  // 1) 声明配置表单：设置 → 插件管理 → 本插件的「配置」按钮
  api.registerConfig({
    title: '深夜提醒设置',
    fields: [
      { key: 'hour', label: '提醒小时', type: 'slider', default: 23, min: 0, max: 23, step: 1, unit: '点' },
      { key: 'enabled', label: '启用提醒', type: 'bool', default: true },
      { key: 'severity', label: '紧急度', type: 'select', options: [
        { value: 'NeutralEvent', label: '中性' },
        { value: 'NegativeEvent', label: '负面' },
        { value: 'PositiveEvent', label: '正面' }
      ], default: 'NeutralEvent' },
      { key: 'message', label: '提醒文案', type: 'text', default: '已经到点了，早点休息', placeholder: '留空用默认' }
    ]
  });

  // 2) 读取当前配置（默认值已合并），注册自定义传感器
  let cfg = api.getConfig();
  api.registerSensor('clock', async () => ({ value: new Date().getHours() }));

  // 3) 注册规则：深夜（cfg.hour 点后）提醒。registerRule 按 id 去重，可安全重复调用
  function applyRule() {
    api.registerRule({
      id: 'plugin-clock-night',
      sensor: 'clock',
      metric: 'value',
      operator: '>=',
      threshold: cfg.hour,
      durationMs: 0,
      severity: cfg.severity,
      label: '深夜提醒',
      description: '已经 ' + cfg.hour + ' 点了，' + cfg.message,
      sound: 'auto',
      enabled: cfg.enabled
    });
  }
  applyRule();

  // 4) 配置变化时重注册规则并打日志
  api.on('config', next => {
    cfg = next;
    applyRule();
    logger.info('深夜提醒已更新为 ' + cfg.hour + ' 点');
  });

  // 5) 主动播报示例（取消注释以启用）
  // api.letter({ severity: 'PositiveEvent', title: '示例插件已加载', description: '这是插件主动触发的播报' });

  logger.info('示例插件已加载');
};
