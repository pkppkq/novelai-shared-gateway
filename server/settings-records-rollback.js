import { readPersistedSettings } from './settings-records.js';

// 必须先停止应用；从当前分片重建兼容格式，不恢复旧备份。
export function restoreInlineSettings(sqlite, { apply = false } = {}) {
  const run = () => {
    const settings = readPersistedSettings(sqlite);
    if (!settings) throw new Error('当前配置不存在，拒绝兼容转换');
    const current = JSON.stringify(settings);
    if (apply) {
      sqlite.prepare("INSERT INTO app_settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(current);
      sqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('settings_record_format', 'inline') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
      if (JSON.stringify(readPersistedSettings(sqlite)) !== current) throw new Error('兼容配置往返核对不一致');
    }
    return { applied: apply, bytes: Buffer.byteLength(current), restoredOldDatabase: false };
  };
  return apply ? sqlite.transaction(run).immediate() : run();
}
