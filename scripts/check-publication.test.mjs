import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublicationFile } from './check-publication.mjs';

const inspect = (name, text) => inspectPublicationFile(name, Buffer.from(text));

test('公开检查拒绝数据、真实环境文件、密钥容器和图片附件', () => {
  for (const name of ['data/library.sqlite', '.env', '.env.production', '_private/report.json',
    'backups/snapshot.tar', 'server/account.pem', 'public/photo.png']) {
    assert.ok(inspect(name, '{}').length, name);
  }
  assert.equal(inspect('.env.example', 'ADMIN_TOKEN=replace-with-a-random-admin-token').length, 0);
});

test('令牌检查只返回规则和位置，不回显命中的字符串', () => {
  const values = [
    'gh' + 'p_' + 'A'.repeat(36),
    'pst' + '-' + 'x'.repeat(40),
    'NAI' + '-' + 'x'.repeat(40),
    'AK' + 'IA' + 'A'.repeat(16)
  ];
  for (const value of values) {
    const findings = inspect('server/config.js', '\nconst credential="' + value + '";');
    assert.ok(findings.length);
    assert.ok(findings.every(row => row.line === 2));
    assert.ok(!JSON.stringify(findings).includes(value));
  }
});

test('合成标记与运行时生成代码允许公开，部署路径与业务标识拒绝', () => {
  assert.equal(inspect('server/test.mjs', "const token='pst-synthetic-offline-fixture-only';").length, 0);
  assert.equal(inspect('server/test.mjs', "const token=randomBytes(24).toString('base64url');").length, 0);
  const local = ['C:', 'Users', 'private-user', 'config.txt'].join(String.fromCharCode(92));
  const identifier = 'ownerDiscord' + 'Id="' + '123456789012345678' + '"';
  assert.ok(inspect('server/config.js', local).some(row => row.rule === 'local-private-path'));
  assert.ok(inspect('server/config.js', identifier).some(row => row.rule === 'business-identifier'));
});
