const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseTargetDisplay, displayBounds } = require('../src/main/displays');

const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const secondary = { id: 2, bounds: { x: 1920, y: -200, width: 2560, height: 1440 } };

test('默认选择主显示器', () => {
  assert.equal(chooseTargetDisplay([primary, secondary], primary), primary);
});

test('secondary 选择第一块非主显示器', () => {
  assert.equal(chooseTargetDisplay([primary, secondary], primary, 'secondary'), secondary);
});

test('第二显示器不存在时回退主显示器', () => {
  assert.equal(chooseTargetDisplay([primary], primary, 'secondary'), primary);
});

test('支持按显示器 id 选择并在失效时回退主显示器', () => {
  assert.equal(chooseTargetDisplay([primary, secondary], primary, 'id:2'), secondary);
  assert.equal(chooseTargetDisplay([primary, secondary], primary, 'id:9'), primary);
});

test('保留目标显示器的负坐标和尺寸', () => {
  assert.deepEqual(displayBounds(secondary), { x: 1920, y: -200, width: 2560, height: 1440 });
});
