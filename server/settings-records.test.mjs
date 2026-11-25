import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore } from './store.js';
import { SettingsRecords, readPersistedSettings } from './settings-records.js';
import { restoreInlineSettings } from './settings-records-rollback.js';
import { configureFairQuota, syncFairQuota, reserveFairQuota } from './fair-quota.js';
import { syntheticOpus, syntheticPng, preciseParameters } from '../test-support/precise-reference-fixtures.mjs';

function legacy(t, settings) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT)');
  const original = JSON.stringify(settings, null, 2);
  db.prepare("INSERT INTO app_settings VALUES ('settings', ?)").run(original);
  return { db, original, records: new SettingsRecords(db) };
}

async function persistent(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'public-settings-records-'));
  const previous = process.env.NO_AUTO_DELETE;
  process.env.NO_AUTO_DELETE = 'true';
  const store = new JsonStore(directory);
  await store.init();
  t.after(async () => {
    await store.close();
    if (previous === undefined) delete process.env.NO_AUTO_DELETE; else process.env.NO_AUTO_DELETE = previous;
    // 合成数据只关闭连接，全部临时文件保留供复核。
  });
  return { store, directory };
}

test('旧配置迁移保持完整 JSON、字段顺序和特殊键，旧行原样保留', t => {
  const settings = {
    serviceName: 'synthetic gateway', fairQuota: {
      balances: { 'member/a.中文': { v5Available: 10, anlasAvailable: 20 } }, reservations: {}
    }, array: [null, 1, 'synthetic'], omitted: undefined
  };
  Object.defineProperty(settings, '__proto__', { value: { synthetic: true }, enumerable: true });
  const { db, original, records } = legacy(t, settings);
  const evidence = records.migrate();
  assert.equal(evidence.beforeSha256, evidence.afterSha256);
  assert.equal(evidence.roundTripVerified, true);
  assert.equal(JSON.stringify(readPersistedSettings(db)), JSON.stringify(settings));
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='settings'").get().value, original);
  assert.equal(records.migrate(), undefined);
});

test('完整旧库启动迁移采用最新旧格式账本，并保留成员和已结算任务', async t => {
  const { store, directory } = await persistent(t);
  await store.update(db => {
    db.users = [{ id: 'synthetic-old-member', token: 'synthetic-old-key', enabled: true }];
    db.settings.fairQuota = {
      balances: { 'synthetic-old-member': { v5Available: 20, anlasFixedAvailable: 100 } },
      reservations: { 'synthetic-old-job': { resource: 'v5', amount: 1, status: 'settled' } }
    };
    db.jobs = [{ id: 'synthetic-old-job', userToken: 'synthetic-old-key', status: 'done',
      fairCharge: { resource: 'v5', amount: 1, status: 'settled' } }];
  }, { collections: ['users', 'jobs', 'settings'], immediate: true });
  await store.close();
  const old = new Database(path.join(directory, 'library.sqlite'));
  let legacyText;
  try {
    // 模拟旧版继续运行后的新余额；保留的历史分片不能覆盖这份最新旧格式。
    const settings = readPersistedSettings(old);
    settings.fairQuota.balances['synthetic-old-member'].v5Available = 17;
    legacyText = JSON.stringify(settings, null, 2);
    old.prepare("UPDATE app_settings SET value=? WHERE key='settings'").run(legacyText);
    old.prepare("DELETE FROM app_meta WHERE key='settings_record_format'").run();
  } finally { old.close(); }
  const upgraded = new JsonStore(directory);
  t.after(() => upgraded.close());
  await upgraded.init();
  assert.equal(upgraded.db.settings.fairQuota.balances['synthetic-old-member'].v5Available, 17);
  assert.equal(upgraded.db.users[0].token, 'synthetic-old-key');
  assert.equal(upgraded.db.jobs[0].status, 'done');
  assert.equal(upgraded.db.settings.fairQuota.reservations['synthetic-old-job'].status, 'settled');
  assert.equal(upgraded.sqlite.prepare("SELECT value FROM app_settings WHERE key='settings'").get().value, legacyText);
  const proof = JSON.parse(upgraded.sqlite.prepare("SELECT value FROM app_meta WHERE key='settings_record_migration'").get().value);
  assert.equal(proof.beforeSha256, proof.afterSha256);
  assert.equal(proof.roundTripVerified, true);
});

test('迁移写入异常回滚格式标记和全部分片，不改变旧账本', t => {
  const { db, original, records } = legacy(t, { fairQuota: { balances: { a: { v5Available: 10 } } } });
  db.exec("CREATE TRIGGER synthetic_migration_failure BEFORE INSERT ON settings_records BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END");
  assert.throws(() => records.migrate(), /synthetic migration failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM settings_records').get().count, 0);
  assert.equal(db.prepare("SELECT value FROM app_meta WHERE key='settings_record_format'").get(), undefined);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='settings'").get().value, original);
});

test('分片缺失、孤立记录或未知版本拒绝加载，不退回过时旧行', async t => {
  for (const corruption of ['missing', 'orphan', 'version']) await t.test(corruption, t => {
    const { db, records } = legacy(t, { fairQuota: { balances: { a: { v5Available: 10 } } } });
    records.migrate();
    if (corruption === 'missing') db.prepare('DELETE FROM settings_records WHERE path=?').run('["fairQuota","balances","a"]');
    if (corruption === 'orphan') db.prepare('INSERT INTO settings_records VALUES (?,?,?)').run('["synthetic-orphan"]', 'json', '{}');
    if (corruption === 'version') db.prepare("UPDATE app_meta SET value='999' WHERE key='settings_record_format'").run();
    assert.throws(() => readPersistedSettings(db), /分片|版本/);
  });
});

test('大配置旁的余额与任务只写变化分片，第二个连接读到同一次事务', async t => {
  const { store, directory } = await persistent(t);
  const now = Date.now();
  await store.update(db => {
    db.settings.syntheticUnrelated = 'x'.repeat(2 * 1024 * 1024);
    db.users = ['a', 'b', 'c', 'd'].map(id => ({ id, token: id, enabled: true }));
    db.accounts = [syntheticOpus(now)];
    configureFairQuota(db, ['a', 'b', 'c', 'd']); syncFairQuota(db, now);
    db.jobs = [{ id: 'synthetic-pr-transaction', status: 'queued', userToken: 'a',
      request: { model: 'nai-diffusion-5-full', width: 1024, height: 1024, steps: 23,
        nativeParameters: preciseParameters(syntheticPng()) } }];
  }, { collections: ['users', 'accounts', 'jobs', 'settings'], immediate: true });
  const observer = new Database(path.join(directory, 'library.sqlite'), { readonly: true });
  t.after(() => observer.close());
  const before = readPersistedSettings(observer).fairQuota.balances.a;
  const writes = [];
  const run = store.settingsSnapshot.upsert.run.bind(store.settingsSnapshot.upsert);
  store.settingsSnapshot.upsert.run = row => { writes.push({ path: row.path, bytes: Buffer.byteLength(row.data) }); return run(row); };
  await store.update(db => {
    const job = db.jobs[0];
    reserveFairQuota(db, db.users[0], job, db.accounts[0], now); job.status = 'running';
  }, { dirtyRows: { jobs: ['synthetic-pr-transaction'] }, includeSettings: true, settingsPaths: [['fairQuota']], immediate: true });
  const after = readPersistedSettings(observer);
  assert.equal(after.syntheticUnrelated.length, 2 * 1024 * 1024);
  assert.equal(after.fairQuota.balances.a.anlasFixedAvailable, before.anlasFixedAvailable - 5);
  assert.equal(after.fairQuota.reservations['synthetic-pr-transaction'].anlasAmount, 5);
  assert.equal(JSON.parse(observer.prepare("SELECT data FROM jobs WHERE id='synthetic-pr-transaction'").get().data).status, 'running');
  assert.ok(writes.length > 0);
  assert.ok(writes.every(row => row.path.startsWith('["fairQuota"')));
  assert.ok(writes.reduce((sum, row) => sum + row.bytes, 0) < 8192);
});

test('任务写入失败同时回滚配置，内存恢复后下一次独立事务可继续', async t => {
  const { store, directory } = await persistent(t);
  await store.update(db => {
    db.users = [{ id: 'a', token: 'a', enabled: true, note: 'initial' }];
    db.settings.fairQuota = { balances: { a: { v5Available: 10 } } };
    db.jobs = [{ id: 'synthetic-reject-job', status: 'queued', userToken: 'a' }];
  }, { collections: ['users', 'jobs', 'settings'], immediate: true });
  await store.update(db => { db.users[0].note = 'accepted earlier'; }, { dirtyRows: { users: ['a'] } });
  store.sqlite.exec("CREATE TRIGGER synthetic_reject_job BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'synthetic job failure'); END");
  await assert.rejects(store.update(db => {
    db.settings.fairQuota.balances.a.v5Available = 0; db.jobs[0].status = 'running';
  }, { dirtyRows: { jobs: ['synthetic-reject-job'] }, includeSettings: true, settingsPaths: [['fairQuota']], immediate: true }), /synthetic job failure/);
  assert.equal(store.db.settings.fairQuota.balances.a.v5Available, 10);
  assert.equal(store.db.jobs[0].status, 'queued');
  assert.equal(store.db.users[0].note, 'accepted earlier');
  const observer = new Database(path.join(directory, 'library.sqlite'), { readonly: true });
  t.after(() => observer.close());
  assert.equal(readPersistedSettings(observer).fairQuota.balances.a.v5Available, 10);
  store.sqlite.exec('DROP TRIGGER synthetic_reject_job');
  await store.update(db => { db.settings.fairQuota.balances.a.v5Available = 9; db.jobs[0].status = 'running'; },
    { dirtyRows: { jobs: ['synthetic-reject-job'] }, includeSettings: true, settingsPaths: [['fairQuota']], immediate: true });
  assert.equal(readPersistedSettings(observer).fairQuota.balances.a.v5Available, 9);
});

test('兼容转换从最新分片重建旧行，并可再次迁移', t => {
  const { db, records } = legacy(t, { fairQuota: { balances: { a: { v5Available: 10 } } } });
  records.migrate();
  const current = readPersistedSettings(db);
  records.reset(current); current.fairQuota.balances.a.v5Available = 9;
  const plan = records.prepare(current, [['fairQuota', 'balances', 'a']]);
  db.transaction(() => records.write(plan))(); records.commit(plan);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='settings'").get().value).fairQuota.balances.a.v5Available, 10);
  assert.equal(restoreInlineSettings(db).applied, false);
  assert.equal(restoreInlineSettings(db, { apply: true }).applied, true);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='settings'").get().value).fairQuota.balances.a.v5Available, 9);
  const remigrated = new SettingsRecords(db);
  remigrated.migrate();
  assert.equal(readPersistedSettings(db).fairQuota.balances.a.v5Available, 9);
});

test('缺少保留旧行时仍从当前分片启动，动态范围合并不会丢配置', async t => {
  const { store, directory } = await persistent(t);
  await store.update(db => {
    db.users = [{ id: 'a', token: 'a', enabled: true }];
    db.settings.fairQuota = { balances: { a: { v5Available: 10 } }, reservations: {} };
  }, { collections: ['users', 'settings'], immediate: true });
  await store.update(db => { db.settings.fairQuota.balances.a.v5Available = 9; },
    { dirtyRows: { users: ['a'] }, includeSettings: true, settingsPaths: [['fairQuota', 'balances', 'a']] });
  await store.update(db => { db.settings.syntheticFlag = true; return { include: true }; },
    { dirtyRows: { users: ['a'] }, includeSettings: result => result.include, settingsPaths: [['syntheticFlag']], immediate: true });
  store.sqlite.prepare("DELETE FROM app_settings WHERE key='settings'").run();
  await store.close();
  const reopened = new JsonStore(directory);
  t.after(() => reopened.close());
  await reopened.init();
  assert.equal(reopened.db.settings.fairQuota.balances.a.v5Available, 9);
  assert.equal(reopened.db.settings.syntheticFlag, true);
});
