import { createHash } from 'node:crypto';
import { SettingsSnapshotCache } from './settings-persistence.js';

// 路径使用 JSON 数组，避免空间名中的点、斜杠或特殊键产生歧义。
export const SETTINGS_RECORD_FORMAT = '2';
const visible = node => Boolean(node?.children || node?.data !== undefined);
const row = (node, path) => node.children
  ? { path: JSON.stringify(path), kind: 'object', data: JSON.stringify([...node.children].filter(([, child]) => visible(child)).map(([key]) => key)) }
  : { path: JSON.stringify(path), kind: 'json', data: node.data };
const format = sqlite => sqlite.prepare("SELECT value FROM app_meta WHERE key = 'settings_record_format'").get()?.value;

// 正常读取和兼容回滚使用同一重建规则；损坏的分片必须拒绝加载，不能退回过时的旧配置。
export function readPersistedSettings(sqlite, fallback = null) {
  const version = format(sqlite);
  if (version !== SETTINGS_RECORD_FORMAT) {
    if (version && version !== 'inline') throw new Error('不支持此配置分片版本');
    const inline = sqlite.prepare("SELECT value FROM app_settings WHERE key = 'settings'").get();
    return inline ? JSON.parse(inline.value) : fallback;
  }
  const entries = sqlite.prepare('SELECT path, kind, data FROM settings_records').all();
  const records = new Map(entries.map(entry => [entry.path, entry]));
  const visited = new Set();
  const load = path => {
    const key = JSON.stringify(path), entry = records.get(key);
    if (!entry || visited.has(key)) throw new Error('配置分片缺失或重复');
    visited.add(key);
    const data = JSON.parse(entry.data);
    if (entry.kind === 'json') return data;
    if (entry.kind !== 'object' || !Array.isArray(data) || data.some(key => typeof key !== 'string') || new Set(data).size !== data.length) {
      throw new Error('配置分片结构无效');
    }
    const object = {};
    for (const child of data) Object.defineProperty(object, child, {
      value: load([...path, child]), enumerable: true, writable: true, configurable: true
    });
    return object;
  };
  const settings = load([]);
  if (visited.size !== records.size || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('配置分片存在孤立记录或根结构无效');
  }
  return settings;
}

function removeTree(node, path, deletes) {
  if (!visible(node)) return;
  deletes.push(JSON.stringify(path));
  for (const [key, child] of node.children || []) removeTree(child, [...path, key], deletes);
}

function diffTree(previous, next, path, upserts, deletes) {
  if (previous === next) return;
  if (!visible(next)) { removeTree(previous, path, deletes); return; }
  const current = row(next, path), old = visible(previous) ? row(previous, path) : null;
  if (!old || old.kind !== current.kind || old.data !== current.data) upserts.push(current);
  for (const [key, child] of previous?.children || []) {
    if (!visible(next.children?.get(key))) removeTree(child, [...path, key], deletes);
  }
  for (const [key, child] of next.children || []) {
    if (visible(child)) diffTree(previous?.children?.get(key), child, [...path, key], upserts, deletes);
  }
}

function allRows(node, path = [], output = []) {
  if (!visible(node)) return output;
  output.push(row(node, path));
  for (const [key, child] of node.children || []) allRows(child, [...path, key], output);
  return output;
}

export class SettingsRecords {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.cache = new SettingsSnapshotCache();
    this.root = null;
    this.state = '';
    sqlite.exec(`CREATE TABLE IF NOT EXISTS settings_records (
      path TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL
    )`);
    this.upsert = sqlite.prepare(`INSERT INTO settings_records (path, kind, data) VALUES (@path, @kind, @data)
      ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, data = excluded.data`);
    this.remove = sqlite.prepare('DELETE FROM settings_records WHERE path = ?');
    this.clear = sqlite.prepare('DELETE FROM settings_records');
    this.setFormat = sqlite.prepare(`INSERT INTO app_meta (key, value) VALUES ('settings_record_format', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  }

  migrate() {
    if (format(this.sqlite) === SETTINGS_RECORD_FORMAT) return;
    const settings = readPersistedSettings(this.sqlite);
    if (!settings) return;
    const plan = this.prepare(settings), before = JSON.stringify(settings);
    let evidence;
    // 旧行保留为迁移前证据；迁移与往返核对、格式标记必须一起提交。
    this.sqlite.transaction(() => {
      this.write(plan, { replace: true });
      const after = JSON.stringify(readPersistedSettings(this.sqlite));
      if (after !== before) throw new Error('配置分片迁移往返核对不一致');
      const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
      evidence = { version: 1, format: SETTINGS_RECORD_FORMAT, at: new Date().toISOString(),
        beforeSha256: digest(before), afterSha256: digest(after), bytes: Buffer.byteLength(before),
        records: this.sqlite.prepare('SELECT COUNT(*) AS n FROM settings_records').get().n, roundTripVerified: true };
      this.sqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('settings_record_migration', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(evidence));
    })();
    this.commit(plan);
    return evidence;
  }

  prepare(settings, paths = null) {
    const treePlan = this.cache.prepare(settings, paths), upserts = [], deletes = [];
    diffTree(this.root, treePlan.root, [], upserts, deletes);
    return { treePlan, root: treePlan.root, upserts, deletes,
      data: upserts.length || deletes.length ? {} : this.state };
  }

  write(plan, { replace = false } = {}) {
    if (replace) this.clear.run();
    else for (const path of plan.deletes) this.remove.run(path);
    for (const entry of replace ? allRows(plan.root) : plan.upserts) this.upsert.run(entry);
    if (replace) this.setFormat.run();
  }

  commit(plan) {
    // 缓存只在外层 SQLite 事务成功后更新；失败由存储器重新读取已提交状态。
    this.cache.commit(plan.treePlan);
    this.root = plan.root;
    this.state = plan.data;
  }

  reset(settings) {
    this.cache.root = null;
    this.root = null;
    this.state = '';
    const plan = this.prepare(settings);
    this.commit(plan);
    return plan.data;
  }
}
