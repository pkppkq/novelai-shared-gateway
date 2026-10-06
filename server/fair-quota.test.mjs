import test from 'node:test';
import assert from 'node:assert/strict';
import {configureFairGroups,configureFairQuota,syncFairQuota,reserveFairQuota,settleFairQuota,quoteFairRequest,fairQuotaSummary} from './fair-quota.js';
const NOW=1800000000000;
const members=['a','b','c','d'];
function fixture(percent=80){
  const db={settings:{},accounts:[{id:'opus',enabled:true,quotaTier:3,subscriptionActive:true,quotaFixed:10000,quotaPurchased:0,v5UsagePercent:percent,v5UsageIsNegative:false,v5UsageTimeUntilNextPercent:600,quotaCheckedAt:NOW}]};
  configureFairQuota(db,members);syncFairQuota(db,NOW);return db;
}
const request={model:'nai-diffusion-5',width:1024,height:1024,steps:23};
const job=(id,r=request)=>({id,request:{...r}});
test('未订阅不发放，多个 Opus 不自动绑定，配置幂等',()=>{
 const db={settings:{},accounts:[]};configureFairQuota(db,members);syncFairQuota(db,NOW);
 assert.equal(db.settings.fairQuota.status,'pending_opus');assert.equal(fairQuotaSummary(db,{id:'a'},NOW).v5Available,0);
 const f=fixture();f.accounts.push({...f.accounts[0],id:'other'});db.accounts=f.accounts;syncFairQuota(db,NOW);assert.equal(db.settings.fairQuota.status,'ambiguous_opus');
 assert.throws(()=>configureFairQuota(db,['a','b','c','e']));configureFairQuota(db,members);
});
test('四并发独立预扣，重启后退款/成功重复调用只结算一次',()=>{
 let db=fixture();const jobs=members.map(id=>job(id));
 jobs.forEach((j,i)=>reserveFairQuota(db,{id:members[i]},j,db.accounts[0],NOW));
 const cost=quoteFairRequest(request).amount;for(const b of Object.values(db.settings.fairQuota.balances))assert.equal(b.v5Available,20-cost);
 db=JSON.parse(JSON.stringify(db));settleFairQuota(db,jobs[0],false,NOW+1);settleFairQuota(db,jobs[0],false,NOW+2);settleFairQuota(db,jobs[0],true,NOW+3);
 assert.equal(db.settings.fairQuota.balances.a.v5Available,20);
 settleFairQuota(db,jobs[1],true,NOW+1);settleFairQuota(db,jobs[1],false,NOW+2);assert.equal(db.settings.fairQuota.balances.b.v5Available,20-cost);
 assert.throws(()=>reserveFairQuota(db,{id:'a'},jobs[0],db.accounts[0],NOW+2));
});
test('恢复按份额到账，新快照不会重复计入恢复',()=>{
 const db=fixture();syncFairQuota(db,NOW+300000);assert.equal(db.settings.fairQuota.balances.a.v5Available,20.125);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+300000,v5UsagePercent:80.5});syncFairQuota(db,NOW+300000);
 assert.equal(db.settings.fairQuota.balances.a.v5Available,20.125);syncFairQuota(db,NOW+300000);assert.equal(db.settings.fairQuota.balances.a.v5Available,20.125);
});
test('续费只按实际新增计入一次，消费及充值校准',()=>{
 const db=fixture();const j=job('paid',{...request,width:1536});const c=reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW);
 assert.equal(c.resource,'anlas');settleFairQuota(db,j,true,NOW+10);
 Object.assign(db.accounts[0],{quotaFixed:10000-c.amount+1000,quotaCheckedAt:NOW+20});syncFairQuota(db,NOW+20);
 assert.equal(db.settings.fairQuota.balances.a.anlasAvailable,2750-c.amount);
 assert.equal(db.settings.fairQuota.balances.b.anlasAvailable,2750);syncFairQuota(db,NOW+20);assert.equal(db.settings.fairQuota.balances.b.anlasAvailable,2750);
});
test('有并发未结清时推迟校准，较早快照不当作充值',()=>{
 const db=fixture();const j=job('paid',{...request,width:1536});reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW);
 Object.assign(db.accounts[0],{quotaFixed:11000,quotaCheckedAt:NOW+10});syncFairQuota(db,NOW+10);assert.equal(db.settings.fairQuota.balances.b.anlasAvailable,2500);
 settleFairQuota(db,j,true,NOW+20);syncFairQuota(db,NOW+20);assert.equal(db.settings.fairQuota.balances.b.anlasAvailable,2500);
});
test('官方余额减少保守缩减，无订阅与过期拒绝',()=>{
 const db=fixture();Object.assign(db.accounts[0],{quotaFixed:8000,v5UsagePercent:40,quotaCheckedAt:NOW+1});syncFairQuota(db,NOW+1);
 assert.ok(Math.abs(db.settings.fairQuota.balances.a.v5Available-10)<1e-8);assert.equal(db.settings.fairQuota.balances.a.anlasAvailable,2000);
 assert.throws(()=>reserveFairQuota(db,{id:'a'},job('stale'),db.accounts[0],NOW+700000),/stale/);
 db.accounts[0].subscriptionActive=false;assert.throws(()=>reserveFairQuota(db,{id:'a'},job('off'),db.accounts[0],NOW+2),/inactive/);
});
test('满容量时预留部分占用容量，退款不会超发',()=>{
 const db=fixture(100),j=job('cap');reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW);syncFairQuota(db,NOW+300000);settleFairQuota(db,j,false,NOW+300001);
 assert.equal(db.settings.fairQuota.balances.a.v5Available,25);
});
test('免费旧模型、付费超范围、禁止自动转 Anlas 及参考图',()=>{
 assert.equal(quoteFairRequest({...request,model:'nai-diffusion-4-5-full'}).resource,'free');assert.equal(quoteFairRequest({...request,steps:29}).resource,'anlas');
 assert.throws(()=>quoteFairRequest({...request,parameters:{reference_image_multiple:['x']}}));
 const db=fixture(0);assert.throws(()=>reserveFairQuota(db,{id:'a'},job('no-fallback'),db.accounts[0],NOW),/不会自动扣/);
});
test('并发期间官方余额骤降立即停止新增任务',()=>{
 const db=fixture();reserveFairQuota(db,{id:'a'},job('running'),db.accounts[0],NOW);
 Object.assign(db.accounts[0],{v5UsagePercent:0,quotaCheckedAt:NOW+1});
 assert.throws(()=>reserveFairQuota(db,{id:'b'},job('blocked'),db.accounts[0],NOW+1),/公共额度不足/);
});
test('未知恢复周期不推测，账户替换不自动转绑',()=>{
 const db=fixture();db.accounts[0].v5UsageTimeUntilNextPercent=null;db.accounts[0].quotaCheckedAt=NOW+1;syncFairQuota(db,NOW+1);
 const before=db.settings.fairQuota.balances.a.v5Available;syncFairQuota(db,NOW+300000);assert.equal(db.settings.fairQuota.balances.a.v5Available,before);
 db.accounts=[{...db.accounts[0],id:'other'}];syncFairQuota(db,NOW+300000);assert.equal(db.settings.fairQuota.status,'inactive_opus');assert.equal(db.settings.fairQuota.boundAccountId,'opus');
});
test('固定与购买 Anlas 独立，购买余额必须明确授权且退款正确',()=>{
 const db=fixture();Object.assign(db.accounts[0],{quotaFixed:0,quotaPurchased:1000,quotaCheckedAt:NOW+1});syncFairQuota(db,NOW+1);
 const r={...request,width:1536};assert.throws(()=>reserveFairQuota(db,{id:'a'},job('deny',r),db.accounts[0],NOW+1),/未经明确授权/);
 const j=job('allow',{...r,allowPurchasedAnlas:true});const c=reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW+1);
 assert.equal(c.fixed,0);assert.equal(c.purchased,c.amount);assert.equal(db.settings.fairQuota.balances.a.anlasPurchasedAvailable,250-c.amount);
 settleFairQuota(db,j,false,NOW+2);assert.equal(db.settings.fairQuota.balances.a.anlasPurchasedAvailable,250);
 const summary=fairQuotaSummary(db,{id:'a'},NOW+2);assert.equal(summary.anlasFixedAvailable,0);assert.equal(summary.anlasPurchasedAvailable,250);
});
test('固定补足不影响购买余额，购买消费不计成额外充值',()=>{
 const db=fixture();Object.assign(db.accounts[0],{quotaFixed:0,quotaPurchased:1000,quotaCheckedAt:NOW+1});syncFairQuota(db,NOW+1);
 const j=job('purchase',{...request,width:1536,allowPurchasedAnlas:true});const c=reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW+1);settleFairQuota(db,j,true,NOW+2);
 Object.assign(db.accounts[0],{quotaFixed:10000,quotaPurchased:1000-c.amount,quotaCheckedAt:NOW+3});syncFairQuota(db,NOW+3);
 assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2500);assert.equal(db.settings.fairQuota.balances.a.anlasPurchasedAvailable,250-c.amount);assert.equal(db.settings.fairQuota.balances.b.anlasPurchasedAvailable,250);
});
test('订阅有效期支持 ISO、秒及毫秒，到期即停',()=>{
 for(const expires of [NOW+1000,(NOW+1000)/1000,new Date(NOW+1000).toISOString()]) {
  const db=fixture();db.accounts[0].subscriptionExpiresAt=expires;assert.equal(syncFairQuota(db,NOW).status,'active');assert.equal(syncFairQuota(db,NOW+1000).status,'inactive_opus');
 }
});
test('禁用或查询出错的账号不绑定，不继续派发',()=>{
 for(const change of [{enabled:false},{enabled:undefined},{quotaError:'quota failed'}]) {
  const db=fixture();Object.assign(db.accounts[0],change);assert.equal(syncFairQuota(db,NOW).status,'inactive_opus');
  db.settings={};configureFairQuota(db,members);assert.equal(syncFairQuota(db,NOW).status,'pending_opus');
 }
});
test('个人固定用尽也不能绕过官方固定优先规则花其他成员余额',()=>{
 const db=fixture();Object.assign(db.accounts[0],{quotaPurchased:1000,quotaCheckedAt:NOW+1});syncFairQuota(db,NOW+1);
 db.settings.fairQuota.balances.a.anlasFixedAvailable=0;db.settings.fairQuota.balances.a.anlasAvailable=250;
 assert.throws(()=>reserveFairQuota(db,{id:'a'},job('wrong-pool',{...request,width:1536,allowPurchasedAnlas:true}),db.accounts[0],NOW+1),/官方固定余额完全耗尽/);
 assert.equal(db.settings.fairQuota.balances.a.anlasPurchasedAvailable,250);
});
test('固定与购买混合及固定池待对账时拒绝购买请求',()=>{
 const db=fixture();Object.assign(db.accounts[0],{quotaFixed:0,quotaPurchased:1000,quotaCheckedAt:NOW+1});syncFairQuota(db,NOW+1);
 db.settings.fairQuota.balances.a.anlasFixedAvailable=1;db.settings.fairQuota.balances.a.anlasAvailable=251;
 const r={...request,width:1536,allowPurchasedAnlas:true};assert.throws(()=>reserveFairQuota(db,{id:'a'},job('mixed',r),db.accounts[0],NOW+1),/不支持混合/);
 db.settings.fairQuota.balances.a.anlasFixedAvailable=0;db.settings.fairQuota.balances.a.anlasAvailable=250;db.settings.fairQuota.spent.anlasFixed=1;
 assert.throws(()=>reserveFairQuota(db,{id:'a'},job('pending-fixed',r),db.accounts[0],NOW+1),/完成对账/);
});

const grouped = (extra=[]) => members.map((id,i)=>({id:`group_${i+1}`,name:`组${i+1}`,members:i===0?[id,...extra]:[id]}));
const enableUsers = (db,extra=[]) => {db.users=[...members,...extra].map(id=>({id,enabled:true}));return db;};
test('旧四人账本原位迁移，余额与预留历史保留，摘要不暴露其他钱包',()=>{
 const db=enableUsers(fixture());const old=JSON.parse(JSON.stringify(db.settings.fairQuota.balances));
 delete db.settings.fairQuota.groups;db.settings.fairQuota.version=1;
 configureFairGroups(db,grouped(),{now:NOW});assert.deepEqual(db.settings.fairQuota.balances,old);
 const summary=fairQuotaSummary(db,{id:'a'},NOW);assert.equal(summary.groupId,'group_1');assert.equal(summary.groupName,'组1');assert.equal(summary.share,.25);assert.equal(summary.v5Capacity,25);
 assert.equal('balances' in summary,false);assert.equal('members' in summary,false);
});
test('新增叶子仅改变未来恢复与充值权重，旧余额超新容量不会删除或恢复',()=>{
 const db=enableUsers(fixture(),['e']);configureFairGroups(db,grouped(['e']),{now:NOW});
 assert.equal(db.settings.fairQuota.balances.a.v5Available,20);assert.equal(db.settings.fairQuota.balances.e.v5Available,0);
 assert.equal(fairQuotaSummary(db,{id:'a'},NOW).v5Capacity,12.5);assert.equal(fairQuotaSummary(db,{id:'e'},NOW).share,.125);
 syncFairQuota(db,NOW+300000);assert.equal(db.settings.fairQuota.balances.a.v5Available,20);assert.equal(db.settings.fairQuota.balances.e.v5Available,.0625);
 Object.assign(db.accounts[0],{quotaFixed:10800,quotaPurchased:800,quotaCheckedAt:NOW+300000});syncFairQuota(db,NOW+300000);
 assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2600);assert.equal(db.settings.fairQuota.balances.e.anlasFixedAvailable,100);
 assert.equal(db.settings.fairQuota.balances.b.anlasFixedAvailable,2700);assert.equal(db.settings.fairQuota.balances.e.anlasPurchasedAvailable,100);
});
test('显式组内重分守恒且不会创建父钱包，审计记录转账前后',()=>{
 const db=enableUsers(fixture(),['e']);configureFairGroups(db,grouped(['e']),{now:NOW,redistributeRemaining:true,actorId:'admin'});
 assert.equal(db.settings.fairQuota.balances.a.v5Available,10);assert.equal(db.settings.fairQuota.balances.e.v5Available,10);
 assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,1250);assert.equal(db.settings.fairQuota.balances.e.anlasFixedAvailable,1250);
 assert.equal(Object.values(db.settings.fairQuota.balances).reduce((n,b)=>n+b.v5Available,0),80);
 assert.equal(db.settings.fairQuota.balances.group_1,undefined);assert.equal(db.settings.fairQuota.configurationHistory.at(-1).beforeBalances.a.v5Available,20);
 const j=job('new-leaf');reserveFairQuota(db,{id:'e'},j,db.accounts[0],NOW);assert.equal(j.fairCharge.groupId,'group_1');
 assert.throws(()=>reserveFairQuota(db,{id:'group_1'},job('parent'),db.accounts[0],NOW),/未加入/);
 settleFairQuota(db,j,false,NOW);assert.equal(db.settings.fairQuota.balances.e.v5Available,10);
});
test('在途任务阻止重分，失败后可改组，删除有余额成员拒绝且原账本不变',()=>{
 const db=enableUsers(fixture(),['e']);const j=job('held');reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW);
 assert.throws(()=>configureFairGroups(db,grouped(['e']),{now:NOW}),e=>e.status===409);
 settleFairQuota(db,j,false,NOW);configureFairGroups(db,grouped(['e']),{now:NOW});
 const next=grouped();next[0].members=['e'];const before=structuredClone(db.settings.fairQuota);
 assert.throws(()=>configureFairGroups(db,next,{now:NOW}),/仍持有额度/);assert.deepEqual(db.settings.fairQuota,before);
 configureFairGroups(db,grouped(),{now:NOW});assert.equal(db.settings.fairQuota.balances.e,undefined);assert.ok(db.users.some(u=>u.id==='e'));
});
test('分组严格校验四组、重复成员、未启用用户及时间参数',()=>{
 const db=enableUsers(fixture(),['e']);const before=structuredClone(db.settings.fairQuota);
 for(const gs of [grouped().slice(1),[...grouped().slice(0,3),{id:'group_4',members:['a']}],grouped(['unknown'])]) assert.throws(()=>configureFairGroups(db,gs,{now:NOW}),e=>e.status===400);
 db.users.find(u=>u.id==='e').enabled=false;assert.throws(()=>configureFairGroups(db,grouped(['e']),{now:NOW}),e=>e.status===400);
 assert.throws(()=>configureFairGroups(db,grouped(),{now:NaN}),e=>e.status===400);assert.deepEqual(db.settings.fairQuota,before);
});
test('没有 Opus 可直接配置八个叶子，所有余额零且重启不重复初始化',()=>{
 const db={settings:{},accounts:[],users:[...members,'e','f','g','h'].map(id=>({id,enabled:true}))};
 const gs=grouped();gs.forEach((g,i)=>g.members.push(['e','f','g','h'][i]));configureFairGroups(db,gs,{now:NOW});
 assert.equal(db.settings.fairQuota.members.length,8);assert.equal(db.settings.fairQuota.status,'pending_opus');
 const restarted=JSON.parse(JSON.stringify(db));assert.equal(fairQuotaSummary(restarted,{id:'e'},NOW).v5Available,0);assert.equal(fairQuotaSummary(restarted,{id:'e'},NOW).share,.125);
 restarted.accounts=fixture().accounts;syncFairQuota(restarted,NOW);assert.equal(restarted.settings.fairQuota.balances.e.v5Available,10);syncFairQuota(restarted,NOW);assert.equal(restarted.settings.fairQuota.balances.e.v5Available,10);
});

test('跨组移动与重分不能合并划转，单独移动余额跟人且不增发',()=>{
 const db=enableUsers(fixture(),['e']);configureFairGroups(db,grouped(['e']),{now:NOW,redistributeRemaining:true});
 const moved=grouped();moved[1].members.push('e');const before=structuredClone(db.settings.fairQuota);
 assert.throws(()=>configureFairGroups(db,moved,{now:NOW,redistributeRemaining:true}),/分两次/);assert.deepEqual(db.settings.fairQuota,before);
 configureFairGroups(db,moved,{now:NOW});assert.equal(db.settings.fairQuota.balances.e.v5Available,10);assert.equal(fairQuotaSummary(db,{id:'e'},NOW).groupId,'group_2');
});
test('最多一百成员，配置审计最多保留一千条',()=>{
 const db=enableUsers(fixture());const many=Array.from({length:98},(_,i)=>`extra${i}`);enableUsers(db,many);
 assert.throws(()=>configureFairGroups(db,grouped(many),{now:NOW}),/100/);
 db.settings.fairQuota.configurationHistory=Array.from({length:1000},(_,i)=>({version:i}));
 configureFairGroups(db,grouped(),{now:NOW});assert.equal(db.settings.fairQuota.configurationHistory.length,1000);assert.equal(db.settings.fairQuota.configurationHistory[0].version,1);
});

test('整数百分比不变时保留真实任务估算扣费，不把消费作为恢复重发',()=>{
 const db=fixture(100);db.accounts[0].v5UsageTimeUntilNextPercent=0;syncFairQuota(db,NOW+1);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+2});syncFairQuota(db,NOW+2);
 const before=db.settings.fairQuota.balances.a.v5Available,cost=quoteFairRequest(request).amount;
 const j=job('integer-shot');reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW+2);settleFairQuota(db,j,true,NOW+3);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+4,v5UsagePercent:100});syncFairQuota(db,NOW+4);
 assert.ok(Math.abs(db.settings.fairQuota.balances.a.v5Available-(before-cost))<1e-9);
 assert.equal(db.settings.fairQuota.balances.b.v5Available,25);
 for(let i=5;i<15;i++){db.accounts[0].quotaCheckedAt=NOW+i;syncFairQuota(db,NOW+i);}
 assert.ok(Math.abs(db.settings.fairQuota.balances.a.v5Available-(before-cost))<1e-9);
});
test('连续整数快照保留累计估算消费，显示降一格时不再次扣除隐藏差额',()=>{
 const db=fixture(100);db.accounts[0].v5UsageTimeUntilNextPercent=0;db.accounts[0].quotaCheckedAt=NOW+1;syncFairQuota(db,NOW+1);
 const cost=quoteFairRequest(request).amount;
 for(let i=0;i<12;i++) {const at=NOW+2+i*3,j=job(`integer-${i}`);reserveFairQuota(db,{id:'a'},j,db.accounts[0],at);settleFairQuota(db,j,true,at+1);db.accounts[0].quotaCheckedAt=at+2;syncFairQuota(db,at+2);}
 assert.ok(Math.abs(db.settings.fairQuota.balances.a.v5Available-(25-12*cost))<1e-9);assert.equal(db.settings.fairQuota.balances.b.v5Available,25);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+50,v5UsagePercent:99});syncFairQuota(db,NOW+50);
 assert.ok(Math.abs(db.settings.fairQuota.balances.a.v5Available-(25-12*cost))<1e-9);assert.equal(db.settings.fairQuota.balances.b.v5Available,25);
});
test('整数容差不妨碍按时间恢复，且 Anlas 精确消费与充值独立对账',()=>{
 const db=fixture(80),j=job('with-refill');const cost=reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW).amount;settleFairQuota(db,j,true,NOW+1);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+300000,v5UsagePercent:80,quotaFixed:10400});syncFairQuota(db,NOW+300000);
 assert.ok(Math.abs(db.settings.fairQuota.balances.a.v5Available-(20-cost+.125))<1e-9);
 assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2600);assert.equal(db.settings.fairQuota.balances.b.anlasFixedAvailable,2600);
 const paid=job('paid-independent',{...request,width:1536});const quote=reserveFairQuota(db,{id:'a'},paid,db.accounts[0],NOW+300001);settleFairQuota(db,paid,true,NOW+300002);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+300003,quotaFixed:10400-quote.amount});syncFairQuota(db,NOW+300003);
 assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2600-quote.amount);assert.equal(db.settings.fairQuota.balances.b.anlasFixedAvailable,2600);
});
test('大于一百分点的偏差才校准，正向只补官方下界，负向保守扣减',()=>{
 const db=fixture(80);db.accounts[0].v5UsageTimeUntilNextPercent=0;db.accounts[0].quotaCheckedAt=NOW+1;syncFairQuota(db,NOW+1);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+2,v5UsagePercent:90});syncFairQuota(db,NOW+2);
 assert.ok(Math.abs(Object.values(db.settings.fairQuota.balances).reduce((n,b)=>n+b.v5Available,0)-89)<1e-9);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+3,v5UsagePercent:90});syncFairQuota(db,NOW+3);
 assert.ok(Math.abs(Object.values(db.settings.fairQuota.balances).reduce((n,b)=>n+b.v5Available,0)-89)<1e-9);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+4,v5UsagePercent:50});syncFairQuota(db,NOW+4);
 assert.ok(Math.abs(Object.values(db.settings.fairQuota.balances).reduce((n,b)=>n+b.v5Available,0)-50)<1e-9);
});

test('同组两个子成员独立消费与退款，其他组不承担消费，恢复按最终份额',()=>{
 const db=enableUsers(fixture(80),['child_one','child_two']);
 configureFairGroups(db,grouped(['child_one','child_two']),{now:NOW,redistributeRemaining:true});
 const s=db.settings.fairQuota,share=.25/3,cost=quoteFairRequest(request).amount;
 for(const id of ['a','child_one','child_two']) {
  assert.ok(Math.abs(s.balances[id].v5Available-20/3)<1e-9);
  assert.ok(Math.abs(s.balances[id].anlasFixedAvailable-2500/3)<1e-9);
  assert.equal(fairQuotaSummary(db,{id},NOW).share,share);
 }
 const untouched=structuredClone(Object.fromEntries(['b','c','d'].map(id=>[id,s.balances[id]])));
 const j1=job('child-one-use'),j2=job('child-two-use');
 reserveFairQuota(db,{id:'child_one'},j1,db.accounts[0],NOW);reserveFairQuota(db,{id:'child_two'},j2,db.accounts[0],NOW);
 settleFairQuota(db,j1,true,NOW);settleFairQuota(db,j2,false,NOW);settleFairQuota(db,j2,false,NOW);settleFairQuota(db,j1,false,NOW);
 assert.ok(Math.abs(s.balances.child_one.v5Available-(20/3-cost))<1e-9);assert.ok(Math.abs(s.balances.child_two.v5Available-20/3)<1e-9);
 for(const id of ['b','c','d'])assert.deepEqual(s.balances[id],untouched[id]);
 syncFairQuota(db,NOW+300000);
 assert.ok(Math.abs(s.balances.child_one.v5Available-(20/3-cost+.5*share))<1e-9);
 assert.ok(Math.abs(s.balances.child_two.v5Available-(20/3+.5*share))<1e-9);
 for(const id of ['b','c','d'])assert.ok(Math.abs(s.balances[id].v5Available-20.125)<1e-9);
});

function fallbackFixture() {
 const db=fixture(100),s=db.settings.fairQuota;s.autoAnlasFallback=true;s.balances.a.v5Available=0;
 Object.assign(db.accounts[0],{v5UsagePercent:75,v5UsageTimeUntilNextPercent:0});Object.assign(s.snapshot,{v5:75,seconds:0});return db;
}
test('本地自动转扣需开关，保持原参数；V5付费报价26，旧模型仍免费',()=>{
 assert.equal(quoteFairRequest(request,{forceAnlas:true}).amount,26);assert.equal(quoteFairRequest(request,{forceAnlas:true}).resource,'anlas');
 assert.equal(quoteFairRequest({...request,model:'nai-diffusion-4-5-full'},{forceAnlas:true}).resource,'free');
 const db=fallbackFixture(),s=db.settings.fairQuota;s.autoAnlasFallback=false;
 assert.throws(()=>reserveFairQuota(db,{id:'a'},job('off'),db.accounts[0],NOW),/不会自动扣/);
 s.autoAnlasFallback=true;const j=job('enabled'),before=structuredClone(j.request),c=reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW);
 assert.deepEqual(j.request,before);assert.equal(c.billingMode,'anlas_fallback');assert.equal(c.upstreamBilling,'shared_or_anlas');assert.equal(c.amount,26);assert.equal(c.v5Equivalent,100/1730);assert.equal(c.sharedV5Reserved,100/1730);
 assert.equal(s.balances.a.v5Available,0);assert.equal(s.balances.a.anlasFixedAvailable,2474);
 assert.equal(s.balances.b.anlasFixedAvailable,2500);assert.equal(s.balances.b.v5Available,25);
});
test('官方Anlas恒定不退本地转扣，同值快照及重启后延迟官方扣款不双扣',()=>{
 let db=fallbackFixture();const j=job('unchanged');reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW);settleFairQuota(db,j,true,NOW+1);
 for(let i=2;i<6;i++){db.accounts[0].quotaCheckedAt=NOW+i;syncFairQuota(db,NOW+i);assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2474);assert.equal(db.settings.fairQuota.fallbackBuffer.fixed,26);}
 db=JSON.parse(JSON.stringify(db));Object.assign(db.accounts[0],{quotaFixed:9974,quotaCheckedAt:NOW+6});syncFairQuota(db,NOW+6);
 assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2474);assert.equal(db.settings.fairQuota.balances.b.anlasFixedAvailable,2500);assert.equal(db.settings.fairQuota.fallbackBuffer.fixed,0);
 db.accounts[0].quotaCheckedAt=NOW+7;syncFairQuota(db,NOW+7);assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2474);
 const q=fairQuotaSummary(db,{id:'a'},NOW+7);assert.equal(q.localAnlasFallbackSpent,26);assert.equal(q.localAnlasFallbackFixedSpent,26);assert.equal(fairQuotaSummary(db,{id:'b'},NOW+7).localAnlasFallbackSpent,0);
});
test('本地转扣与普通付费并发，官方实际Anlas下降只扣一次，充值仍按实际增量分配',()=>{
 const db=fallbackFixture(),fallback=job('fallback-paid'),ordinary=job('ordinary-paid',{...request,width:1536});
 const f=reserveFairQuota(db,{id:'a'},fallback,db.accounts[0],NOW),p=reserveFairQuota(db,{id:'b'},ordinary,db.accounts[0],NOW);
 settleFairQuota(db,fallback,true,NOW+1);settleFairQuota(db,ordinary,true,NOW+1);
 Object.assign(db.accounts[0],{quotaFixed:10000-f.amount-p.amount,quotaCheckedAt:NOW+2});syncFairQuota(db,NOW+2);
 assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2500-f.amount);assert.equal(db.settings.fairQuota.balances.b.anlasFixedAvailable,2500-p.amount);
 Object.assign(db.accounts[0],{quotaFixed:10400-f.amount-p.amount,quotaCheckedAt:NOW+3});syncFairQuota(db,NOW+3);
 assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2600-f.amount);assert.equal(db.settings.fairQuota.balances.b.anlasFixedAvailable,2600-p.amount);
 assert.equal(db.settings.fairQuota.fallbackBuffer.fixed,0);
});
test('官方未扣Anlas时真实充值只分新增，不消除转扣buffer或补回本地扣款',()=>{
 const db=fallbackFixture(),j=job('virtual');reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW);settleFairQuota(db,j,true,NOW+1);
 Object.assign(db.accounts[0],{quotaFixed:10400,quotaCheckedAt:NOW+2});syncFairQuota(db,NOW+2);
 assert.equal(db.settings.fairQuota.balances.a.anlasFixedAvailable,2574);assert.equal(db.settings.fairQuota.balances.b.anlasFixedAvailable,2600);assert.equal(db.settings.fairQuota.fallbackBuffer.fixed,26);
});
test('四个本地转扣预留原子扣各自余额，失败幂等退款且不累计成功转扣',()=>{
 const db=fallbackFixture(),s=db.settings.fairQuota;for(const id of members)s.balances[id].v5Available=0;
 Object.assign(db.accounts[0],{v5UsagePercent:0});s.snapshot.v5=0;
 const jobs=members.map(id=>job(`fallback-${id}`));jobs.forEach((j,i)=>reserveFairQuota(db,{id:members[i]},j,db.accounts[0],NOW));
 for(const id of members)assert.equal(s.balances[id].anlasFixedAvailable,2474);
 settleFairQuota(db,jobs[0],false,NOW+1);settleFairQuota(db,jobs[0],false,NOW+2);settleFairQuota(db,jobs[0],true,NOW+3);
 assert.equal(s.balances.a.anlasFixedAvailable,2500);assert.equal(s.fallbackBuffer.fixed,0);assert.equal(fairQuotaSummary(db,{id:'a'},NOW+3).localAnlasFallbackSpent,0);
 settleFairQuota(db,jobs[1],true,NOW+4);settleFairQuota(db,jobs[1],true,NOW+5);assert.equal(s.fallbackBuffer.fixed,26);assert.equal(s.sharedV5Debt,0);
});
test('转扣预留不可超支，购买Anlas仍须显式授权且与固定分离',()=>{
 const db=fallbackFixture(),s=db.settings.fairQuota;s.balances.a.anlasFixedAvailable=30;s.balances.a.anlasAvailable=30;
 reserveFairQuota(db,{id:'a'},job('last'),db.accounts[0],NOW);assert.throws(()=>reserveFairQuota(db,{id:'a'},job('over'),db.accounts[0],NOW));assert.equal(s.balances.a.anlasFixedAvailable,4);
 const purchased=fallbackFixture();Object.assign(purchased.accounts[0],{quotaFixed:0,quotaPurchased:1000,quotaCheckedAt:NOW+1});syncFairQuota(purchased,NOW+1);
 assert.throws(()=>reserveFairQuota(purchased,{id:'a'},job('purchase-no'),purchased.accounts[0],NOW+1),/未经明确授权/);
 const j=job('purchase-yes',{...request,allowPurchasedAnlas:true}),c=reserveFairQuota(purchased,{id:'a'},j,purchased.accounts[0],NOW+1);assert.equal(c.fixed,0);assert.equal(c.purchased,26);settleFairQuota(purchased,j,true,NOW+2);
 Object.assign(purchased.accounts[0],{quotaCheckedAt:NOW+3});syncFairQuota(purchased,NOW+3);assert.equal(purchased.settings.fairQuota.balances.a.anlasPurchasedAvailable,224);assert.equal(purchased.settings.fairQuota.fallbackBuffer.purchased,26);
 Object.assign(purchased.accounts[0],{quotaPurchased:974,quotaCheckedAt:NOW+4});syncFairQuota(purchased,NOW+4);assert.equal(purchased.settings.fairQuota.balances.a.anlasPurchasedAvailable,224);assert.equal(purchased.settings.fairQuota.fallbackBuffer.purchased,0);
});
test('共享V5潜在消费记全局负债，不直接扣他人钱包；整数同步不凭空恢复',()=>{
 const db=fallbackFixture(),s=db.settings.fairQuota,j=job('shared-usage');const c=reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW);settleFairQuota(db,j,true,NOW+1);
 assert.equal(s.sharedV5Debt,c.v5Equivalent);const before=structuredClone(s.balances);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+2,v5UsagePercent:75});syncFairQuota(db,NOW+2);
 assert.deepEqual(s.balances,before);assert.equal(s.sharedV5Debt,c.v5Equivalent);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+3,v5UsagePercent:75-c.v5Equivalent});syncFairQuota(db,NOW+3);
 assert.deepEqual(s.balances,before);assert.equal(s.sharedV5Debt,c.v5Equivalent);
});
test('恢复先偿还共享负债，普通V5调用遵守负债边界，公共条耗尽仍可本地转扣',()=>{
 const db=fallbackFixture(),s=db.settings.fairQuota,j=job('debt');const c=reserveFairQuota(db,{id:'a'},j,db.accounts[0],NOW);settleFairQuota(db,j,true,NOW+1);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW+2,v5UsagePercent:75-c.v5Equivalent,v5UsageTimeUntilNextPercent:600});syncFairQuota(db,NOW+2);
 syncFairQuota(db,NOW+60002);assert.equal(s.sharedV5Debt,0);
 assert.ok(Math.abs(s.balances.a.v5Available-(.1-c.v5Equivalent)/4)<1e-9);
 const blocked=fallbackFixture();blocked.settings.fairQuota.sharedV5Debt=75;
 assert.throws(()=>reserveFairQuota(blocked,{id:'b'},job('normal-blocked'),blocked.accounts[0],NOW),/公共额度/);
 const depleted=fixture(0);depleted.settings.fairQuota.autoAnlasFallback=true;depleted.accounts[0].v5UsageIsNegative=true;
 const paid=reserveFairQuota(depleted,{id:'a'},job('zero-allowed'),depleted.accounts[0],NOW);assert.equal(paid.billingMode,'anlas_fallback');assert.equal(paid.sharedV5Reserved,0);
});
