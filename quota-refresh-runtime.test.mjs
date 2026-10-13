import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { withQuotaRequestDeadline } from './server/quota-timeout.js';
import { fetchNovelAiAccountQuota } from './server/providers.js';

const source = fs.readFileSync(new URL('./server/index.js', import.meta.url), 'utf8');
const quota = { tier: 3, subscriptionActive: true, subscriptionExpiresAt: Date.now() + 86400000, points: 10000, fixed: 10000, purchased: 0, v5UsagePercent: 80 };
const account = id => ({ id, token: `synthetic-${id}`, enabled: true, quotaTier: 3, subscriptionActive: true, subscriptionExpiresAt: quota.subscriptionExpiresAt, quotaFixed: 9000, quotaPurchased: 0, v5UsagePercent: 80, quotaCheckedAt: new Date(Date.now() - 700000).toISOString() });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function runtime(fetchQuota, accounts = [account('one')], extra = {}) {
  const db = { accounts, settings: {} };
  const context = vm.createContext({
    Date, Number, Map, Set, AbortController, setTimeout, clearTimeout, process: { env: {} }, console,
    fairShareMode: true, accountQuotaRequestTimeoutMs: 15, accountQuotaRefreshIntervalMs: 20,
    accountQuotaRefreshPromise: null, accountQuotaRefreshTimer: null, accountQuotaAutoRefreshStarted: false,
    withQuotaRequestDeadline, fetchNovelAiAccountQuota: fetchQuota, publicErrorMessage: String,
    collectValues: value => value || [], publicAccount: value => value,
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    isUnsubscribedAccountTier: tier => Number(tier) === 0, isNovelAiAccountBannedError: () => false,
    isNovelAiOutOfTrialImageGenerationError: () => false, disableNovelAiAccount: value => { value.enabled = false; },
    syncFairQuota: () => {},
    store: { readCollections: async () => structuredClone(db), update: async fn => fn(db) }, ...extra
  });
  for (const name of ['accountQuotaResult', 'accountQuotaErrorResult', 'applyAccountQuotaResult', 'fetchNovelAiAccountQuotaWithTimeout', 'mapLimit', 'refreshAccountQuotas', 'refreshEnabledAccountQuotas', 'startAccountQuotaAutoRefresh']) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext((source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, end), context);
  }
  return { context, db };
}

async function within(promise, ms = 500) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('刷新未按截止时间释放')), ms); })]); }
  finally { clearTimeout(timer); }
}

test('底层完全忽略取消时，本轮仍超时结束且可开始下一轮', async () => {
  let calls = 0, signal;
  const f = runtime(async (token, env, options) => { signal = options.signal; return ++calls === 1 ? new Promise(() => {}) : quota; });
  const first = await within(f.context.refreshEnabledAccountQuotas());
  assert.equal(first.failed, 1); assert.equal(signal.aborted, true);
  assert.equal(f.context.accountQuotaRefreshPromise, null);
  assert.equal(f.db.accounts[0].enabled, true); assert.equal(f.db.accounts[0].quotaFixed, 9000);
  assert.equal(f.db.accounts[0].upstreamStatus, 'sync_error');
  const second = await within(f.context.refreshEnabledAccountQuotas());
  assert.equal(second.ok, 1); assert.equal(calls, 2);
  assert.equal(f.db.accounts[0].quotaFixed, 10000); assert.equal(f.db.accounts[0].quotaError, '');
});

test('单个上游挂起不阻止其他账户更新，并发调用复用同一轮', async () => {
  let calls = 0;
  const f = runtime(async token => { calls++; return token === 'synthetic-one' ? new Promise(() => {}) : quota; }, [account('one'), account('two')]);
  const results = await within(Promise.all([f.context.refreshEnabledAccountQuotas(), f.context.refreshEnabledAccountQuotas()]));
  assert.equal(calls, 2); assert.equal(results[0].ok, 1); assert.equal(results[0].failed, 1);
  assert.equal(results[1].ok, 1); assert.equal(f.db.accounts[1].quotaFixed, 10000);
});

test('旧请求在超时后迟到成功，不能覆盖下一轮的余额', async () => {
  const late = defer(); let calls = 0;
  const f = runtime(async () => ++calls === 1 ? late.promise : { ...quota, fixed: 8000, points: 8000 });
  await within(f.context.refreshEnabledAccountQuotas());
  await within(f.context.refreshEnabledAccountQuotas());
  late.resolve({ ...quota, fixed: 99999, points: 99999 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.db.accounts[0].quotaFixed, 8000); assert.equal(f.db.accounts[0].quotaError, '');
});

test('自动调度在挂起请求超时后继续下一轮，不重复启动', async () => {
  let calls = 0; const completed = defer(); const summaries = [];
  const f = runtime(async () => ++calls === 1 ? new Promise(() => {}) : quota, [account('one')], {
    console: { log: value => { summaries.push(value); if (summaries.length === 2) completed.resolve(); }, error: error => completed.reject(error) }
  });
  try {
    f.context.startAccountQuotaAutoRefresh(); f.context.startAccountQuotaAutoRefresh();
    await within(completed.promise);
    assert.equal(calls, 2); assert.match(summaries[0], /failed=1/); assert.match(summaries[1], /ok=1/);
  } finally { clearTimeout(f.context.accountQuotaRefreshTimer); }
});

test('正常完成或拒绝保持原结果，并清理超时计时器', async () => {
  let signal;
  assert.equal(await withQuotaRequestDeadline(value => { signal = value; return 7; }, 10), 7);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(signal.aborted, false);
  const error = Object.assign(new Error('synthetic rejection'), { upstreamStatus: 401 });
  await assert.rejects(withQuotaRequestDeadline(() => { throw error; }, 10), value => value === error);
});

test('底层吞掉取消并返回成功时，超时结果仍不能被改成成功', async () => {
  await assert.rejects(withQuotaRequestDeadline(signal => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve(quota), { once: true });
  }), 10), error => error.code === 'QUOTA_REQUEST_TIMEOUT');
});

test('超时后的迟到拒绝已经被接住，不产生未处理拒绝', async () => {
  const late = defer();
  await assert.rejects(withQuotaRequestDeadline(() => late.promise, 10), error => error.code === 'QUOTA_REQUEST_TIMEOUT');
  late.reject(new Error('synthetic late rejection'));
  await new Promise(resolve => setTimeout(resolve, 5));
});

test('响应头完成但响应体永久挂起也有截止时间', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: () => new Promise(() => {}) }));
  await assert.rejects(withQuotaRequestDeadline(signal => fetchNovelAiAccountQuota('synthetic', { NOVELAI_ACCOUNT_API_URL: 'https://offline.invalid' }, { signal }), 15), error => error.code === 'QUOTA_REQUEST_TIMEOUT');
});

test('有效 Opus 仅读取订阅，不为不可用的试用接口阻塞刷新', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (url.endsWith('/ai/trial-status')) return new Promise(() => {});
    return Response.json({ subscription: { tier: 3, active: true, expiresAt: quota.subscriptionExpiresAt, trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 0 } } });
  });
  const result = await within(withQuotaRequestDeadline(signal => fetchNovelAiAccountQuota('synthetic', { NOVELAI_ACCOUNT_API_URL: 'https://offline.invalid' }, { signal }), 50));
  assert.equal(result.tier, 3); assert.equal(result.subscriptionActive, true);
  assert.deepEqual(calls, ['https://offline.invalid/user/data']);
  assert.equal(result.trialStatusKnown, false);
});
