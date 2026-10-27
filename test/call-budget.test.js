// 慢命令超时预算 —— 不需要浏览器，进 `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callBudget } from '../src/mcp-server.js';

test('ask 等到用户动手：默认 5 分钟，再加 20 秒余量，最长 10 分钟', () => {
  assert.equal(callBudget('ask', {}), 320000);
  assert.equal(callBudget('ask', { timeout: 60000 }), 80000);
  assert.equal(callBudget('ask', { timeout: 3600000 }), 620000);
});

test('wait、act、download 只放宽不收窄', () => {
  assert.equal(callBudget('wait', { timeout: 1000 }), 35000);
  assert.equal(callBudget('wait', { timeout: 60000 }), 75000);
  assert.equal(callBudget('act', { steps: [{}, {}, {}, {}, {}] }), 60000);
  assert.equal(callBudget('download', {}), 150000);
});

test('其余命令走桥的默认超时', () => {
  assert.equal(callBudget('snapshot', {}), undefined);
});
