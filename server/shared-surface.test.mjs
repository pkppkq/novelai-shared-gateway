import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedSurface } from './shared-surface.js';

test('首页只进入共享门户，旧静态资源与未知页面不可访问', () => {
  assert.deepEqual(sharedSurface('/'), { allowed: true, pathname: '/account.html' });
  assert.equal(sharedSurface('/admin').pathname, '/admin/members.html');
  for (const path of ['/app.js', '/admin.js', '/memory', '/unknown', '/foo/../admin.js']) assert.equal(sharedSurface(path).allowed, false, path);
  assert.equal(sharedSurface('/account.js', 'POST').allowed, false);
});
test('酒馆调用、结果取回、成员及管理依赖保持可用', () => {
  for (const [path, method] of [['/v1/chat/completions', 'POST'], ['/ai/generate-image', 'POST'], ['/v1/ai/generate-image', 'OPTIONS'], ['/generate', 'GET'], ['/api/jobs', 'POST'], ['/api/jobs/job1', 'GET'], ['/api/jobs/job1/content', 'GET'], ['/api/images/img1/content', 'GET'], ['/api/member/shared-events', 'GET'], ['/api/member/login', 'POST'], ['/api/admin/member-management', 'POST'], ['/api/admin/accounts/quota', 'POST'], ['/api/admin/accounts/acct1', 'PATCH']]) assert.equal(sharedSurface(path, method).allowed, true, path);
});
test('兑换、旧余额、提示词转换、图库管理及整库导入导出已关闭', () => {
  for (const path of ['/api/redeem', '/api/me/merge', '/api/me', '/api/api/getUser', '/api/prompt/convert', '/api/admin/prompt-api', '/api/settings', '/api/admin/cards', '/api/admin/images', '/api/admin/import', '/api/admin/export', '/api/web/jobs']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal(sharedSurface(path, method).allowed, false, path);
  }
});

test('启动器查询别名、编码和放大只开放对应方法', () => {
  for (const path of ['/ai/user/subscription', '/v1/ai/user/subscription']) {
    assert.equal(sharedSurface(path, 'GET').allowed, true);
    assert.equal(sharedSurface(path, 'POST').allowed, false);
  }
  for (const path of ['/ai/encode-vibe', '/v1/ai/encode-vibe', '/ai/upscale', '/v1/ai/upscale']) {
    assert.equal(sharedSurface(path, 'POST').allowed, true);
    assert.equal(sharedSurface(path, 'OPTIONS').allowed, true);
    assert.equal(sharedSurface(path, 'GET').allowed, false);
    assert.equal(sharedSurface(path, 'DELETE').allowed, false);
  }
});
