import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNativeImageRequest } from './native-image.js';
import { quoteNativeRequest } from './native-pricing.js';
import { configureFairQuota, syncFairQuota, reserveFairQuota, settleFairQuota, fairQuotaSummary } from './fair-quota.js';
import { V5_PRECISE_REFERENCE_BUCKETS, isV5PreciseReferenceSize } from './v5-precise-reference.js';
import { syntheticPng, preciseParameters, syntheticOpus } from '../test-support/precise-reference-fixtures.mjs';

const reference = syntheticPng();
const body = (model = 'nai-diffusion-5-full', extra = {}) => ({
  input: 'synthetic paper character', model, action: 'generate',
  parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1, ...preciseParameters(reference), ...extra }
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function ledger(options) {
  const now = Date.now(), db = {
    settings: {}, users: ['a', 'b', 'c', 'd'].map(id => ({ id, token: id, enabled: true })),
    accounts: [syntheticOpus(now, options)], jobs: []
  };
  configureFairQuota(db, ['a', 'b', 'c', 'd']); syncFairQuota(db, now);
  return { db, now, user: db.users[0], account: db.accounts[0], state: db.settings.fairQuota };
}

test('V5 参考尺寸与独立保存的官方 97 个分桶一致', () => {
  const official = JSON.parse(readFileSync(new URL('./fixtures/official-image-pricing-20261125.json', import.meta.url), 'utf8'));
  assert.deepEqual(V5_PRECISE_REFERENCE_BUCKETS, official.v5ReferenceBuckets);
  assert.equal(official.referenceCostPerImage, 5);
  assert.equal(V5_PRECISE_REFERENCE_BUCKETS.length, 97);
  for (const [width, height] of official.v5ReferenceBuckets) assert.ok(isV5PreciseReferenceSize(width, height));
  for (const [width, height] of [[256, 4096], [832, 1216], [1024, 1024], [4096, 256]]) {
    const request = parseNativeImageRequest(body(undefined, preciseParameters(syntheticPng(width, height))));
    assert.equal(quoteNativeRequest(request).anlasAmount, 5);
  }
  assert.equal(isV5PreciseReferenceSize(1472, 1472), false);
});

test('High、Medium、Curated 接受官方描述与强度，参数不会被吞掉', () => {
  for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-full-medium', 'nai-diffusion-5-curated']) {
    for (const description of ['character', 'style', 'costume', 'character&style', 'character&style_anyoutfit', 'character_mainoutfit']) {
      for (const strength of [-5, 0, 5]) {
        const input = body(model, { ...preciseParameters(reference, 1, description), director_reference_strength_values: [strength] });
        const request = parseNativeImageRequest(input);
        assert.equal(request.nativeParameters.director_reference_strength_values[0], strength);
        assert.equal(request.nativeParameters.director_reference_secondary_strength_values[0], 0);
        assert.equal(request.nativeParameters.director_reference_descriptions[0].caption.base_caption, description);
        const quote = quoteNativeRequest(request);
        assert.equal(quote.resource, 'v5'); assert.equal(quote.anlasAmount, 5);
        assert.equal(quote.billingMode, 'v5_precise');
        assert.equal(request.steps, model.endsWith('-medium') ? 14 : 23);
      }
    }
  }
});

test('不兼容的尺寸、Fidelity、描述、Vibe 和 V5 重绘在计费前拒绝', () => {
  for (const extra of [
    preciseParameters(syntheticPng(1472, 1472)),
    { director_reference_strength_values: [5.1] },
    { director_reference_secondary_strength_values: [0.1] },
    preciseParameters(reference, 1, 'unsupported-description'),
    { reference_image_multiple: [reference] }
  ]) assert.throws(() => parseNativeImageRequest(body(undefined, extra)), error => error.statusCode === 422);
  const infill = body('nai-diffusion-5-full-inpainting', { image: reference, mask: reference });
  infill.action = 'infill';
  assert.throws(() => parseNativeImageRequest(infill), /V5 PR.*局部重绘/);
  assert.throws(() => quoteNativeRequest({
    model: infill.model, width: 1024, height: 1024, steps: 23, action: 'infill',
    nativeParameters: infill.parameters
  }), /V5 PR.*局部重绘/);
});

test('标准请求预扣 V5 加参考费，付费规格和续用按生成费加参考费', () => {
  const standard = parseNativeImageRequest(body(undefined, preciseParameters(reference, 2)));
  const quote = quoteNativeRequest(standard);
  near(quote.amount, 100 / 1730); assert.equal(quote.anlasAmount, 10);
  assert.equal(quoteNativeRequest({ ...standard, steps: 29 }).amount, 42);
  assert.equal(quoteNativeRequest(standard, { forceAnlas: true }).amount, 36);
  const medium = parseNativeImageRequest(body('nai-diffusion-5-full-medium'));
  assert.equal(quoteNativeRequest(medium, { forceAnlas: true }).amount, 20);
});

test('双资源预扣、结算和退款幂等，其他成员钱包不变', () => {
  const { db, now, user, account, state } = ledger();
  const initial = structuredClone(state.balances), request = parseNativeImageRequest(body());
  const job = { id: 'synthetic-pr-refund', request };
  const charge = reserveFairQuota(db, user, job, account, now);
  assert.equal(charge.anlasAmount, 5);
  near(state.balances.a.v5Available, initial.a.v5Available - charge.amount);
  assert.equal(state.balances.a.anlasFixedAvailable, initial.a.anlasFixedAvailable - 5);
  assert.equal(fairQuotaSummary(db, user, now).anlasReserved, 5);
  reserveFairQuota(db, user, job, account, now);
  assert.equal(state.balances.a.anlasFixedAvailable, initial.a.anlasFixedAvailable - 5);
  settleFairQuota(db, job, false, now); settleFairQuota(db, job, false, now);
  assert.deepEqual(state.balances, initial);
  assert.throws(() => reserveFairQuota(db, user, job, account, now), /已退款/);
  const success = { id: 'synthetic-pr-success', request };
  const held = reserveFairQuota(db, user, success, account, now);
  settleFairQuota(db, success, true, now); settleFairQuota(db, success, true, now); settleFairQuota(db, success, false, now);
  near(state.spent.v5, held.amount);
  assert.equal(state.spent.anlas, 5); assert.equal(state.spent.anlasFixed, 5);
  for (const id of ['b', 'c', 'd']) assert.deepEqual(state.balances[id], initial[id]);
});

test('个人任一余额不足时没有单边预扣，购买点数仍需明确授权', () => {
  for (const resource of ['v5Available', 'anlasFixedAvailable']) {
    const { db, now, user, account, state } = ledger();
    state.balances.a[resource] = 0;
    state.balances.a.anlasAvailable = state.balances.a.anlasFixedAvailable;
    const before = structuredClone(state.balances);
    const job = { id: 'synthetic-insufficient-' + resource, request: parseNativeImageRequest(body()) };
    assert.throws(() => reserveFairQuota(db, user, job, account, now), /不足/);
    assert.deepEqual(state.balances, before);
    assert.equal(state.reservations[job.id], undefined); assert.equal(job.fairCharge, undefined);
  }
  const { db, now, user, account, state } = ledger({ fixed: 0, purchased: 100 });
  const request = parseNativeImageRequest(body()), before = structuredClone(state.balances);
  assert.throws(() => reserveFairQuota(db, user, { id: 'synthetic-not-authorized', request }, account, now), /明确授权/);
  assert.deepEqual(state.balances, before);
  const allowed = { id: 'synthetic-purchased-pr', request: { ...request, allowPurchasedAnlas: true } };
  const charge = reserveFairQuota(db, user, allowed, account, now);
  assert.equal(charge.fixed, 0); assert.equal(charge.purchased, 5);
  assert.equal(fairQuotaSummary(db, user, now).anlasPurchasedReserved, 5);
  settleFairQuota(db, allowed, false, now); assert.deepEqual(state.balances, before);
});
