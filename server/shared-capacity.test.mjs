import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedAccountConcurrency, sharedAccountReadyDelay, recordSharedCapacityError, recordSharedCapacitySuccess } from './shared-capacity.js';

const NOW = 1800000000000;

test('健康 Opus 独立上限四，持久降级不会因冷却到期、重启或其他账户成功而消失', () => {
  const a = {}, b = {};
  assert.equal(sharedAccountConcurrency(a, NOW), 4);
  recordSharedCapacityError(a, NOW, 2);
  assert.equal(sharedAccountConcurrency(a, NOW), 1);
  assert.equal(sharedAccountConcurrency(structuredClone(a), NOW + 86400000), 1);
  recordSharedCapacitySuccess(b, NOW + 86400000);
  assert.equal(sharedAccountConcurrency(b, NOW), 4);
  assert.equal(sharedAccountConcurrency(a, NOW), 1);
});

test('空闲请求立即派发，有在途任务才等十秒，原请求先完成可立即接续', () => {
  const account = { lastSharedDispatchAt: new Date(NOW).toISOString(), inFlight: 1 };
  assert.equal(sharedAccountReadyDelay(account, NOW + 1000), 9000);
  assert.equal(sharedAccountReadyDelay(account, NOW + 10000), 0);
  assert.equal(sharedAccountReadyDelay(account, NOW + 1000, 0), 0);
  assert.equal(sharedAccountReadyDelay({}, NOW), 0);
});

test('按实际冲突降低容量，重复拒绝冷却增加至两分钟且范围有限', () => {
  const account = {};
  recordSharedCapacityError(account, NOW, 4);
  assert.equal(sharedAccountConcurrency(account, NOW), 3);
  assert.equal(sharedAccountReadyDelay(account, NOW), 30000);
  recordSharedCapacityError(account, NOW + 40000, 3);
  assert.equal(sharedAccountConcurrency(account, NOW), 2);
  assert.equal(sharedAccountReadyDelay(account, NOW + 40000), 60000);
  for (let i = 0; i < 12; i++) recordSharedCapacityError(account, NOW + 120000, 2);
  assert.equal(sharedAccountConcurrency(account, NOW), 1);
  assert.equal(sharedAccountReadyDelay(account, NOW + 120000), 120000);
  assert.equal(account.capacityStrikeCount, 4);
});

test('至少二十次正常成功和观察时间两者都满足才逐级恢复，不发送主动探测', () => {
  const account = {};
  recordSharedCapacityError(account, NOW, 2);
  for (let i = 0; i < 30; i++) recordSharedCapacitySuccess(account, NOW + 60000, NOW + 50000);
  assert.equal(sharedAccountConcurrency(account, NOW), 1);
  recordSharedCapacitySuccess(account, NOW + 15 * 60000, NOW + 14 * 60000);
  assert.equal(sharedAccountConcurrency(account, NOW), 2);
  recordSharedCapacitySuccess(account, NOW + 30 * 60000, NOW + 29 * 60000);
  assert.equal(sharedAccountConcurrency(account, NOW), 2);
  for (let i = 0; i < 19; i++) recordSharedCapacitySuccess(account, NOW + 30 * 60000, NOW + 29 * 60000);
  assert.equal(sharedAccountConcurrency(account, NOW), 3);
  for (let i = 0; i < 20; i++) recordSharedCapacitySuccess(account, NOW + 45 * 60000, NOW + 44 * 60000);
  assert.equal(sharedAccountConcurrency(account, NOW), 4);
});

test('旧窗口仅在有效期内沿用，报错前已开始的迟到成功不抵消新错误', () => {
  const legacy = { capacityLimitedUntil: new Date(NOW + 300000).toISOString() };
  assert.equal(sharedAccountConcurrency(legacy, NOW), 1);
  assert.equal(sharedAccountConcurrency(legacy, NOW + 300001), 4);
  const account = {};
  recordSharedCapacityError(account, NOW, 2);
  for (let i = 0; i < 30; i++) recordSharedCapacitySuccess(account, NOW + 60 * 60000, NOW - 1000);
  assert.equal(account.capacitySuccesses, 0);
  assert.equal(sharedAccountConcurrency(account, NOW), 1);
});
