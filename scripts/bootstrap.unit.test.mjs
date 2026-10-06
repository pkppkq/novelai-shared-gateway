import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { bootstrap } from './bootstrap.mjs';
import { setMemberCredentials, loginMember } from '../server/member-auth.js';
import { configureFairQuota } from '../server/fair-quota.js';

// 无原生 SQLite 依赖时验证初始化边界；真实 SQLite 行为由 bootstrap.test.mjs 单独验证。
class MemoryStore {
 static databases=new Map();
 constructor(dir){this.dir=dir;}
 async init(){this.db={settings:{},users:[],accounts:[],cards:[],jobs:[],images:[],ledger:[]};MemoryStore.databases.set(this.dir,this.db);}
 async update(fn){await fn(this.db);}
 async flush(){await writeFile(path.join(this.dir,'library.sqlite'),JSON.stringify(this.db),'utf8');}
 async close(){}
}
const dependencies={JsonStore:MemoryStore,setMemberCredentials,configureFairQuota,createId:prefix=>prefix+'_'+randomBytes(12).toString('hex'),createPublicToken:prefix=>prefix+'-'+randomBytes(24).toString('base64url')};
const environment=dataDir=>({DATA_DIR:dataDir,ADMIN_TOKEN:'test-admin-'.repeat(5),NOVELAI_TOKEN:'pst-'+'fixture-only-'.repeat(4)});

test('离线初始化使用真实口令散列与公平账本，输出不含密钥，重复运行不覆盖',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'bootstrap-unit-')),logs=[];
 const result=await bootstrap({env:{...environment(dataDir),BOOTSTRAP_USERNAMES:'Alpha,Beta,Gamma,Delta'},dependencies,log:s=>logs.push(s)});
 const saved=JSON.parse(await readFile(result.credentialPath,'utf8')),db=MemoryStore.databases.get(dataDir);
 assert.deepEqual(saved.accounts.map(a=>a.username),['alpha','beta','gamma','delta']);assert.equal(db.accounts.length,1);assert.equal(db.accounts[0].quotaTier,null);
 assert.equal(db.settings.fairQuota.status,'pending_opus');assert.equal(db.settings.fairQuota.autoAnlasFallback,false);
 for(const c of saved.accounts){assert.equal((await loginMember(db,c.username,c.password)).id,c.user_id);assert.equal(db.settings.fairQuota.balances[c.user_id].anlasAvailable,0);assert.equal(db.settings.fairQuota.balances[c.user_id].v5Available,0);assert.ok(!logs.join('').includes(c.password));assert.ok(!logs.join('').includes(c.api_key));}
 const before=await readFile(result.credentialPath);await assert.rejects(bootstrap({env:environment(dataDir),dependencies,log:()=>{}}),/拒绝覆盖/);assert.deepEqual(await readFile(result.credentialPath),before);
});

test('首次初始化并发运行最多一个成功，不混合两套用户凭据',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'bootstrap-concurrent-'));
 const results=await Promise.allSettled([bootstrap({env:environment(dataDir),dependencies,log:()=>{}}),bootstrap({env:environment(dataDir),dependencies,log:()=>{}})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const saved=JSON.parse(await readFile(path.join(dataDir,'bootstrap-credentials.json'),'utf8')),db=MemoryStore.databases.get(dataDir);
 assert.deepEqual(saved.accounts.map(a=>a.user_id),db.settings.fairQuota.members);
});
