import test from 'node:test';
import assert from 'node:assert/strict';
import { memberPublicBaseUrl, handleMemberRoutes } from './member-routes.js';
import { createMemberSession, logoutMemberSession } from './member-auth.js';

const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } });

test('成员公开入口优先部署配置，未配置时沿用数据库和旧主域名', () => {
  const db = { settings: { publicBaseUrl: 'https://old.example' } };
  assert.equal(memberPublicBaseUrl(db, { PUBLIC_BASE_URL: 'https://nai.example', PUBLIC_HOST: 'old.example' }), 'https://nai.example');
  assert.equal(memberPublicBaseUrl(db, { PUBLIC_HOST: 'fallback.example' }), 'https://old.example');
  assert.equal(memberPublicBaseUrl({ settings: {} }, { PUBLIC_HOST: 'fallback.example' }), 'https://fallback.example');
  assert.equal(memberPublicBaseUrl({ settings: {} }, {}), '');
});

test('成员取 Key 使用新的 API 入口，保留单个 v1 后缀且不改库内旧地址', async t => {
  const previous = process.env.PUBLIC_BASE_URL;
  t.after(() => { if (previous === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = previous; });
  const user = { id: 'synthetic-user', enabled: true, token: 'synthetic-key', memberAuth: { version: 'synthetic-version' } };
  const db = { settings: { publicBaseUrl: 'https://old.example' }, users: [user] };
  const cookie = createMemberSession(user);
  t.after(() => logoutMemberSession(cookie));
  for (const base of ['https://nai.example', 'https://nai.example/', 'https://nai.example/v1']) {
    process.env.PUBLIC_BASE_URL = base;
    const res = response();
    await handleMemberRoutes({ method: 'GET', headers: { host: 'old.example', origin: 'https://old.example', cookie: `nai_member_session=${cookie}` } }, res, new URL('https://old.example/api/member/key'), { store: { update: fn => fn(db) } });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { apiKey: 'synthetic-key', baseUrl: 'https://nai.example/v1' });
    assert.equal(db.settings.publicBaseUrl, 'https://old.example');
  }
});

