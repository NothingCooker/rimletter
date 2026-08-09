// plugins/example.js —— 示例插件：注册自定义传感器 + 规则 + 主动播报
// 把此文件复制到 userData/plugins/ 目录（设置窗口「打开插件目录」可直达）。
// 默认禁用（config.plugins.disabled 含 example），需在 设置→插件管理 中启用。
module.exports = async ({ api, logger }) => {
  // 1) 注册自定义传感器：返回 { value }，可被规则引擎引用
  api.registerSensor('clock', async () => ({ value: new Date().getHours() }));

  // 2) 注册一条规则：深夜（23 点后）提醒
  api.registerRule({
    id: 'plugin-clock-night',
    sensor: 'clock',
    metric: 'value',
    operator: '>=',
    threshold: 23,
    durationMs: 0,
    severity: 'NeutralEvent',
    label: '深夜提醒',
    description: '已经到 23 点了，早点休息',
    sound: 'auto',
    enabled: true
  });

  // 3) 主动播报示例（取消注释以启用）
  // api.letter({ severity: 'PositiveEvent', title: '示例插件已加载', description: '这是插件主动触发的播报' });

  logger.info('示例插件已加载');
};
