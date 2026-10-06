import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as fair from './server/fair-quota.js';
const source=fs.readFileSync(new URL('./server/index.js',import.meta.url),'utf8');
function fixture(tier=3) {
  const db={settings:{},users:['a','b','c','d'].map(id=>({id,token:id,balance:100000})),accounts:[{id:'opus',quotaTier:tier,subscriptionActive:true,enabled:true,quotaFixed:10000,quotaPurchased:0,v5UsagePercent:100,v5UsageTimeUntilNextPercent:600,quotaCheckedAt:Date.now()}],jobs:[],ledger:[]};
  fair.configureFairQuota(db,['a','b','c','d']);
  let queue=Promise.resolve();
  const ctx=vm.createContext({...fair,console,fairShareMode:true,Date,Number,Map,Set,
    store:{update(fn){queue=queue.then(()=>fn(db));return queue;}},
    httpError:(statusCode,message)=>Object.assign(new Error(message),{statusCode}),
    jobAccountCost:()=>0,isStaleActiveJob:()=>false,isAccountCoolingDown:a=>Date.parse(a.cooldownUntil||'')>Date.now(),
    hasEnabledAccounts:()=>true,dirtyResultJobRows:()=>({}),dirtyReservationJobRows:()=>()=>({}),
    publicErrorMessage:s=>s,errorDetailMessage:e=>e.message,isNovelAiCapacityError:e=>e.statusCode===429,
    uniqueIds:a=>a,createId:()=>String(Math.random()),scheduleQueueDrain(){},notifyJobWaiters(){},clearJobStreamProgress(){},
  });
  for(const name of ['getUserOrThrow','reserveQueuedJob','refundJob','failGeneration','assertFairMemberReady','generationCost','availableAccountSlots']) {
    const start=source.indexOf(`function ${name}(`),end=source.indexOf('\n}',start)+2;
    const async=source.slice(start-6,start)==='async ';
    vm.runInContext((async?'async ':'')+source.slice(start,end),ctx);
  }
  const job=(id,token='a')=>{const j={id,userToken:token,status:'queued',cost:0,request:{model:'nai-diffusion-5-full',width:1024,height:1024,steps:23}};db.jobs.push(j);return j;};
  return {db,ctx,job};
}
test('同一用户可占四个全局槽位，第五个排队；失败退款只发生一次',async()=>{
  const {db,ctx,job}=fixture();for(let i=0;i<5;i++)job(String(i));
  const result=await Promise.all(db.jobs.map(j=>ctx.reserveQueuedJob(j.id)));
  assert.equal(result.filter(r=>r.job).length,4);assert.equal(result[4].queued,true);
  assert.equal(db.accounts[0].inFlight,4);assert.equal(ctx.availableAccountSlots(db.accounts),0);
  const charged=db.settings.fairQuota.balances.a.v5Available;
  await ctx.failGeneration(result[0],new Error('官方失败'));
  const refunded=db.settings.fairQuota.balances.a.v5Available;
  assert.ok(refunded>charged);ctx.refundJob(db,db.jobs[0],'重复取消');assert.equal(db.settings.fairQuota.balances.a.v5Available,refunded);
  assert.equal((await ctx.reserveQueuedJob('4')).job.status,'running');assert.equal(db.accounts[0].inFlight,4);
  assert.equal(db.users[0].balance,100000);assert.equal(ctx.generationCost({}),0);
});
test('只有试用时不派发，不使用虚构本地点数；错误可立即返回',async()=>{
  const {db,ctx,job}=fixture(0);await assert.rejects(ctx.assertFairMemberReady('a'),e=>e.statusCode===503);
  // 拒绝预检事务不会妨碍后续独立调度事务。
  const j=job('trial');const r=await ctx.reserveQueuedJob(j.id);
  assert.equal(r.statusCode,503);assert.equal(j.status,'failed');assert.equal(db.accounts[0].inFlight,undefined);
  assert.equal(db.settings.fairQuota.balances.a.v5Available,0);
});
test('429退款并冷却，不自动换号重试',async()=>{
  const {db,ctx,job}=fixture();job('one');const r=await ctx.reserveQueuedJob('one');
  await ctx.failGeneration(r,Object.assign(new Error('capacity'),{statusCode:429}));
  job('two');assert.equal((await ctx.reserveQueuedJob('two')).queued,true);
  assert.ok(Date.parse(db.accounts[0].cooldownUntil)>Date.now());
  assert.match(source,/if \(fairShareMode\) throw error;/);
  assert.match(source,/includeSettings: true, immediate: true/);
});

test('管理员开启续用后个人 V5 不足按原参数转扣 Anlas，失败退回同一钱包',async()=>{
  const {db,ctx,job}=fixture();
  fair.syncFairQuota(db);db.settings.fairQuota.autoAnlasFallback=true;
  db.settings.fairQuota.balances.a.v5Available=0;
  const j=job('fallback');const original=JSON.stringify(j.request);
  const reserved=await ctx.reserveQueuedJob(j.id);
  assert.equal(reserved.job.status,'running');assert.equal(j.fairCharge.resource,'anlas');
  assert.equal(j.fairCharge.billingMode,'anlas_fallback');assert.equal(j.fairCharge.amount,26);
  assert.equal(JSON.stringify(j.request),original);assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2474);
  assert.equal(db.settings.fairQuota.balances.b.anlasFixedAvailable,2500);
  await ctx.failGeneration(reserved,new Error('模拟上游失败'));
  assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2500);
  ctx.refundJob(db,j,'重复退款');assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2500);
});

function childrenFixture() {
 const f=fixture();for(const u of f.db.users)u.enabled=true;
 f.db.users.push(...['child_one','child_two'].map(id=>({id,token:id,enabled:true,balance:0})));
 f.db.accounts[0].v5UsageTimeUntilNextPercent=0;
 fair.configureFairGroups(f.db,['a','b','c','d'].map((id,i)=>({id:`group_${i+1}`,name:`组${i+1}`,members:i===0?[id,'child_one','child_two']:[id]})),{redistributeRemaining:true});
 fair.syncFairQuota(f.db);return f;
}
test('同组两个子账户分担四个并发槽位，各扣各的，其他组不受影响',async()=>{
 const {db,ctx,job}=childrenFixture();const q=fair.quoteFairRequest({model:'nai-diffusion-5-full',width:1024,height:1024,steps:23});
 for(let i=0;i<4;i++)job(`child-${i}`,i%2?'child_two':'child_one');job('fifth','b');
 const before=structuredClone(db.settings.fairQuota.balances);
 const results=await Promise.all(db.jobs.map(j=>ctx.reserveQueuedJob(j.id)));
 assert.equal(results.filter(r=>r.job).length,4);assert.equal(results[4].queued,true);assert.equal(db.accounts[0].inFlight,4);
 for(const id of ['child_one','child_two'])assert.ok(Math.abs(db.settings.fairQuota.balances[id].v5Available-(before[id].v5Available-2*q.amount))<1e-9);
 for(const id of ['a','b','c','d'])assert.deepEqual(db.settings.fairQuota.balances[id],before[id]);
 for(let i=0;i<4;i++){assert.equal(results[i].job.fairCharge.userId,i%2?'child_two':'child_one');assert.equal(results[i].job.fairCharge.groupId,'group_1');}
 await ctx.failGeneration(results[0],new Error('子账户失败'));const refunded=db.settings.fairQuota.balances.child_one.v5Available;
 await ctx.failGeneration(results[0],new Error('重复失败'));ctx.refundJob(db,db.jobs[0],'重复退款');assert.equal(db.settings.fairQuota.balances.child_one.v5Available,refunded);
 assert.ok(Math.abs(refunded-(before.child_one.v5Available-q.amount))<1e-9);
 assert.ok(Math.abs(db.settings.fairQuota.balances.child_two.v5Available-(before.child_two.v5Available-2*q.amount))<1e-9);
 for(const id of ['b','c','d'])assert.deepEqual(db.settings.fairQuota.balances[id],before[id]);
});
test('禁用的组内子账户在派发与预检均拒绝，不影响其他成员余额',async()=>{
 const {db,ctx,job}=childrenFixture();db.users.find(u=>u.id==='child_one').enabled=false;
 const before=structuredClone(db.settings.fairQuota.balances);const j=job('disabled-child','child_one');const r=await ctx.reserveQueuedJob(j.id);
 assert.equal(r.statusCode,401);assert.equal(j.status,'failed');assert.equal(db.accounts[0].inFlight,undefined);assert.equal(j.fairCharge,undefined);assert.deepEqual(db.settings.fairQuota.balances,before);
 await assert.rejects(ctx.assertFairMemberReady('child_one'),e=>e.statusCode===401);
});
