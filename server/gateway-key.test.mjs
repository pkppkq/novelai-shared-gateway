import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { createPublicToken, normalizeDb } from './store.js';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const legacyKey = 'LEGACY-synthetic-member';
const newKey = 'NAI-synthetic-member';
const stoppedAfterAuth = new Error('synthetic validation boundary');

function productionFunction(name) {
  const start = source.indexOf('async function ' + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

function fixture() {
  const registered = new Map([
    [newKey, { id: 'new-member', token: newKey, enabled: true }],
    [legacyKey, { id: 'old-member', token: legacyKey, enabled: true }],
    ['LEGACY-synthetic-disabled', { id: 'disabled-member', enabled: false }],
    ['pst-synthetic-recorded', { id: 'wrong-record', enabled: true }],
  ]);
  const lookups = [];
  const context = vm.createContext({
    process: { env: { PUBLIC_MODE: 'true' } }, adminToken: '', Buffer,
    store: { readUserByToken: async token => { lookups.push(token); return registered.get(token); } },
    tokenFrom: req => req.token || '', bearerToken: req => req.token || '',
    validPublicImageSignature: () => false,
    randomBytes: () => Buffer.alloc(8), logNativeDiagnostic() {},
    readNativeBody: async () => { throw stoppedAfterAuth; },
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
  });
  for (const name of ['publicSelfUseGuard', 'handleNativeImageGeneration', 'handleNativeAuxiliary']) {
    vm.runInContext(productionFunction(name), context);
  }
  return { context, lookups };
}

const response = () => ({ setHeader() {} });
const unauthorized = error => error.statusCode === 401;

test('新成员 Key 使用中性前缀，随机部分独立且可保留其他用途的自定义前缀', () => {
  const keys = Array.from({ length: 32 }, () => createPublicToken());
  for (const key of keys) assert.match(key, /^NAI-[A-Za-z0-9_-]{24}$/);
  assert.equal(new Set(keys).size, keys.length);
  assert.match(createPublicToken('CARD'), /^CARD-[A-Za-z0-9_-]{24}$/);
});

test('普通请求按已登记的完整 Key 鉴权，旧前缀不会改写或变成后缀别名', async () => {
  const { context, lookups } = fixture();
  for (const token of [newKey, legacyKey]) {
    assert.equal(await context.publicSelfUseGuard({ token, headers: {} }, response(), new URL('http://gateway.example/v1/models'), 'GET'), false);
  }
  for (const token of ['', 'OTHER-synthetic-member', 'NAI-synthetic-disabled', 'LEGACY-synthetic-disabled', 'pst-synthetic-recorded']) {
    await assert.rejects(context.publicSelfUseGuard({ token, headers: {} }, response(), new URL('http://gateway.example/v1/models'), 'GET'), unauthorized);
  }
  assert.ok(!lookups.includes('pst-synthetic-recorded'));
  const normalized = normalizeDb({ users: [{ id: 'old', token: legacyKey }], jobs: [{ id: 'job', userToken: legacyKey }] });
  assert.equal(normalized.users[0].token, legacyKey);
  assert.equal(normalized.jobs[0].userToken, legacyKey);
});

test('网页请求体中的旧 Key 同样精确核验，不开放未知 Key 注册', async () => {
  const { context } = fixture();
  for (const [token, accepted] of [[legacyKey, true], ['OTHER-synthetic-member', false]]) {
    const req = Readable.from([Buffer.from(JSON.stringify({ token }))]);
    req.headers = {};
    const pending = context.publicSelfUseGuard(req, response(), new URL('http://gateway.example/api/jobs'), 'POST');
    if (accepted) assert.equal(await pending, false);
    else await assert.rejects(pending, unauthorized);
  }
});

test('原生生图与辅助接口允许新旧登记 Key，拒绝停用、未知及官方凭据', async () => {
  const { context } = fixture();
  for (const name of ['handleNativeImageGeneration', 'handleNativeAuxiliary']) {
    for (const token of [newKey, legacyKey]) {
      await assert.rejects(context[name]({ token, headers: {} }, response(), 'encode-vibe'), error => error === stoppedAfterAuth);
    }
    for (const token of ['', 'OTHER-synthetic-member', 'LEGACY-synthetic-disabled', 'pst-synthetic-recorded']) {
      await assert.rejects(context[name]({ token, headers: {} }, response(), 'encode-vibe'), unauthorized);
    }
  }
});
