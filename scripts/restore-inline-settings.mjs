import Database from 'better-sqlite3';
import { restoreInlineSettings } from '../server/settings-records-rollback.js';

// 应用停止后才能转换；检查模式只读，转换模式保留分片和最新额度。
const [filename, mode] = process.argv.slice(2);
if (!filename || !['--check', '--apply'].includes(mode)) throw new Error('用法：node scripts/restore-inline-settings.mjs 数据库路径 --check|--apply；--apply 前必须停止应用');
const sqlite = new Database(filename, { fileMustExist: true, readonly: mode === '--check' });
try {
  sqlite.pragma('busy_timeout = 5000');
  console.log(JSON.stringify(restoreInlineSettings(sqlite, { apply: mode === '--apply' })));
} finally { sqlite.close(); }
