// 配置与各成员钱包分别保存，保留原有 JSON 值和字段顺序。
const partitionedObjects = new Set([
  '[]',
  '["fairQuota"]',
  '["fairQuota","balances"]',
  '["fairQuota","reservations"]',
  '["fairQuota","fallbackTotalsByUser"]'
]);

const prefix = (parent, child) => parent.length <= child.length && parent.every((key, index) => key === child[index]);

export function normalizeSettingsPaths(value) {
  // 没有明确范围的旧调用继续全量检查，不能依靠对象引用猜测原地修改。
  if (value === undefined || value === null || Array.isArray(value) && !value.length) return null;
  if (!Array.isArray(value)) throw new TypeError('配置变更范围必须是路径数组');
  let selected = [];
  for (const candidate of value) {
    if (!Array.isArray(candidate) || !candidate.length || candidate.some(key => typeof key !== 'string' || !key)) {
      throw new TypeError('配置变更路径必须包含非空字符串');
    }
    if (selected.some(parent => prefix(parent, candidate))) continue;
    selected = selected.filter(child => !prefix(candidate, child));
    selected.push([...candidate]);
  }
  return selected;
}

export function settingsScopeIntersects(paths, path) {
  return paths === null || paths.some(selected => prefix(selected, path) || prefix(path, selected));
}

export function mergeSettingsPaths(scopes) {
  const active = scopes.filter(scope => scope?.includeSettings);
  if (!active.length || active.some(scope => scope.settingsPaths === null || scope.settingsPaths === undefined)) return null;
  return normalizeSettingsPaths(active.flatMap(scope => scope.settingsPaths));
}

function partitionable(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.toJSON === 'function') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && partitionedObjects.has(JSON.stringify(path));
}

function snapshotNode(value, path, previous, paths) {
  const selected = settingsScopeIntersects(paths, path);
  if (previous && !selected && previous.value === value) return previous;
  // 范围之外整个分支被替换时仍重新检查，兼容默认值归一化和复制后的新对象。
  const childPaths = previous && !selected && previous.value !== value ? null : paths;
  if (!partitionable(value, path)) return { value, data: JSON.stringify(value) };
  const children = new Map();
  for (const key of Object.keys(value)) {
    const child = snapshotNode(value[key], [...path, key], previous?.children?.get(key), childPaths);
    children.set(key, child);

  }
  // 正常分片写入只需要叶子和字段顺序，兼容导出时才拼接完整 JSON。
  let data;
  return { value, children, get data() {
    if (data === undefined) {
      const parts = [];
      for (const [key, child] of children) if (child.data !== undefined) parts.push(JSON.stringify(key) + ':' + child.data);
      data = '{' + parts.join(',') + '}';
    }
    return data;
  } };
}

export class SettingsSnapshotCache {
  constructor() {
    this.root = null;
  }

  prepare(settings, paths = null) {
    const root = snapshotNode(settings, [], this.root, normalizeSettingsPaths(paths));
    return { root, get data() { return root.data; } };
  }

  commit(plan) {
    // 只有 SQLite 提交成功后才发布新片段，失败恢复必须重建整个缓存。
    this.root = plan.root;
  }

  reset(settings) {
    this.root = null;
    const plan = this.prepare(settings);
    this.commit(plan);
    return plan.data;
  }
}
