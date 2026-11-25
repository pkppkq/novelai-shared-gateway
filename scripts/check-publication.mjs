import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const synthetic = value => /^(?:pst-|NAI-)?(?:synthetic|fixture|test|example|replace)(?:[-_A-Za-z0-9]*)$/i.test(value);
const patterns = [
  ['github-credential', /(?:github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{20,})/g],
  ['cloud-credential', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['api-credential', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g],
  ['novelai-credential', /\bpst-[A-Za-z0-9_-]{24,}\b/g],
  ['member-credential', /\bNAI-[A-Za-z0-9_-]{24,}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['signed-token', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b/g],
  ['webhook-credential', /https:\/\/(?:discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+|hooks\.slack\.com\/services\/[A-Za-z0-9/]+)/g],
  ['local-private-path', /\b[A-Za-z]:[\\/][^\s"'`]+/g],
  ['production-path', /\/(?:srv|var\/www)\/[A-Za-z0-9_.\/-]+/g],
  ['private-repository', /https:\/\/github\.com\/[^/\s]+\/[^/\s]*(?:private|internal)[^/\s]*/gi],
  ['business-identifier', /\b(?:discordId|guildId|ownerDiscordId|tenantId)\s*["']?\s*[:=]\s*["']?\d{17,20}\b/g]
];

// 只返回文件、规则与行号；即使发现秘密，也不能把命中内容写到日志。
export function inspectPublicationFile(filename, raw) {
  const name = filename.replaceAll('\\', '/'), findings = [];
  const add = (rule, line = 1) => findings.push({ file: name, rule, line });
  if (/^(?:\/|[A-Za-z]:)/.test(name) || name.split('/').includes('..')) add('outside-repository');
  if (/(?:^|\/)(?:data|secrets|backups|logs|outputs|_private|node_modules|\.git)(?:\/|$)/i.test(name)) add('private-directory');
  if (/(?:^|\/)\.env(?:\..*)?$/.test(name) && name !== '.env.example') add('environment-file');
  if (/\.(?:sqlite(?:[-.].*)?|db(?:[-.].*)?|pem|key|p12|pfx|log|bak|tar|zip|gz|png|jpe?g|webp|mp4|webm)$/i.test(name)) add('private-or-binary-artifact');
  if (raw.includes(0)) { add('binary-content'); return findings; }
  const text = raw.toString('utf8');
  for (const [rule, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      if ((rule === 'novelai-credential' || rule === 'member-credential') && synthetic(match[0])) continue;
      add(rule, text.slice(0, match.index).split('\n').length);
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error('公开源码检查未能取得 Git 文件清单。');
    process.exitCode = 1;
  } else {
    const files = result.stdout.split('\0').filter(Boolean);
    const findings = files.flatMap(name => inspectPublicationFile(name, readFileSync(path.join(root, name))));
    if (findings.length) {
      console.error(JSON.stringify({ passed: false, findings }, null, 2));
      process.exitCode = 1;
    } else console.log(JSON.stringify({ passed: true, files: files.length }));
  }
}
