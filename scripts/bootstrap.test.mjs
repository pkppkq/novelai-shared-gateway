import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrap } from './bootstrap.mjs';
import { JsonStore } from '../server/store.js';
import { loginMember } from '../server/member-auth.js';

const environment=dataDir=>({DATA_DIR:dataDir,ADMIN_TOKEN:'test-admin-'.repeat(5),NOVELAI_TOKEN:'pst-'+'fixture-only-'.repeat(4)});
const freshDirectory=()=>mkdtemp(path.join(os.tmpdir(),'shared-bootstrap-test-'));

test('真实 SQLite 首次初始化四成员，不联网、不发额度，凭据只写受限文件',async()=>{
 const dataDir=await freshDirectory(),logs=[],previousFetch=globalThis.fetch;let networkCalls=0;
 globalThis.fetch=()=>{networkCalls++;throw new Error('测试禁止联网');};
 try {
  const result=await bootstrap({env:environment(dataDir),log:message=>logs.push(message)});
  assert.equal(result.memberCount,4);assert.equal(networkCalls,0);
  const saved=JSON.parse(await readFile(result.credentialPath,'utf8'));
  assert.equal(saved.accounts.length,4);assert.deepEqual(saved.accounts.map(a=>a.username),['member01','member02','member03','member04']);
  assert.equal(new Set(saved.accounts.map(a=>a.api_key)).size,4);assert.equal(new Set(saved.accounts.map(a=>a.password)).size,4);
  for(const member of saved.accounts){assert.match(member.api_key,/^STA1N-/);assert.ok(member.password.length>=24);assert.ok(!logs.join('').includes(member.api_key));assert.ok(!logs.join('').includes(member.password));}
  assert.ok(!JSON.stringify(saved).includes(environment(dataDir).ADMIN_TOKEN));assert.ok(!JSON.stringify(saved).includes(environment(dataDir).NOVELAI_TOKEN));
  if(process.platform!=='win32')assert.equal((await stat(result.credentialPath)).mode&0o777,0o600);
  const store=new JsonStore(dataDir);await store.init();
  try {
   const db=await store.read();assert.equal(db.users.length,4);assert.equal(db.accounts.length,1);assert.equal(db.accounts[0].quotaTier,null);assert.equal(db.accounts[0].quotaCheckedAt,'');
   assert.equal(db.settings.fairQuota.status,'pending_opus');assert.equal(db.settings.fairQuota.boundAccountId,null);assert.equal(db.settings.fairQuota.autoAnlasFallback,false);
   for(const member of saved.accounts){assert.equal((await loginMember(db,member.username,member.password)).id,member.user_id);assert.equal(db.settings.fairQuota.balances[member.user_id].v5Available,0);assert.equal(db.settings.fairQuota.balances[member.user_id].anlasAvailable,0);assert.equal(db.users.find(u=>u.id===member.user_id).balance,0);}
  } finally {await store.close();}
  const before=await readFile(path.join(dataDir,'library.sqlite')),credentialsBefore=await readFile(result.credentialPath);
  await assert.rejects(bootstrap({env:environment(dataDir),log:()=>{}}),/拒绝覆盖/);
  assert.deepEqual(await readFile(path.join(dataDir,'library.sqlite')),before);assert.deepEqual(await readFile(result.credentialPath),credentialsBefore);
 } finally {globalThis.fetch=previousFetch;}
});

test('已有空数据库、旧 JSON 或初始化凭据均拒绝覆盖',async()=>{
 for(const name of ['library.sqlite','library.sqlite-wal','library.sqlite-shm','library.json','library.json.bak','bootstrap-credentials.json','.bootstrap.lock']) {
  const dataDir=await freshDirectory(),filename=path.join(dataDir,name);await writeFile(filename,'existing marker','utf8');
  await assert.rejects(bootstrap({env:environment(dataDir),log:()=>{}}),/拒绝覆盖/);assert.equal(await readFile(filename,'utf8'),'existing marker');
 }
});

test('环境变量先校验，用户名可配置且不允许重复',async()=>{
 const dataDir=await freshDirectory();
 for(const changes of [{ADMIN_TOKEN:''},{ADMIN_TOKEN:'replace-me-'.repeat(5)},{NOVELAI_TOKEN:''},{BOOTSTRAP_USERNAMES:'same,same,other,last'},{BOOTSTRAP_USERNAMES:'one,two,three'}])await assert.rejects(bootstrap({env:{...environment(dataDir),...changes},log:()=>{}}));
 const result=await bootstrap({env:{...environment(dataDir),BOOTSTRAP_USERNAMES:'Alpha,Beta,Gamma,Delta'},log:()=>{}});
 assert.deepEqual(JSON.parse(await readFile(result.credentialPath,'utf8')).accounts.map(a=>a.username),['alpha','beta','gamma','delta']);
});
