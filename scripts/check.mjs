import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
function collect(directory) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(name);
    else if (entry.isFile() && /\.(?:m?js)$/.test(name)) files.push(name);
  }
}

// 只检查发行源码目录；不读取依赖、数据目录或部署配置。
for (const directory of ['server', 'public', 'scripts', 'test-support']) collect(directory);
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
console.log(`语法检查通过：${files.length} 个文件`);
