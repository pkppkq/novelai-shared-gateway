import test from 'node:test';
import assert from 'node:assert/strict';
import { launcherSubscription } from './launcher-subscription.js';
import { configureFairQuota,syncFairQuota } from './fair-quota.js';
const NOW=1800000000000;
function fixture(){
 const db={users:['a','b','c','d','outsider'].map(id=>({id,enabled:true,token:'private-'+id})),settings:{},accounts:[{id:'secret-opus',token:'upstream-secret',enabled:true,quotaTier:3,subscriptionActive:true,subscriptionExpiresAt:NOW+86400000,quotaCheckedAt:NOW,v5UsagePercent:80,v5UsageTimeUntilNextPercent:600,quotaFixed:10000,quotaPurchased:1000}]};
 configureFairQuota(db,['a','b','c','d']);syncFairQuota(db,NOW);return db;
}
test('启动器只见个人本地余额和真实百分点，接口无写入与标识泄漏',()=>{
 const db=fixture(),before=structuredClone(db),result=launcherSubscription(db,db.users[0],NOW);
 assert.deepEqual(result,{tier:3,active:true,expiresAt:(NOW+86400000)/1000,trainingStepsLeft:{fixedTrainingStepsLeft:2500,purchasedTrainingSteps:250},perks:{imageGeneration:true,unlimitedImageGeneration:true,unlimitedImageGenerationLimits:[{resolution:1048576,maxPrompts:1}]},usage:{percent:20,isNegative:false,timeUntilNextPercent:2400}});
 assert.deepEqual(db,before);for(const secret of ['secret-opus','upstream-secret','private-a','private-b'])assert.ok(!JSON.stringify(result).includes(secret));
 db.settings.fairQuota.balances.b.anlasFixedAvailable=9000;assert.equal(launcherSubscription(db,db.users[0],NOW).trainingStepsLeft.fixedTrainingStepsLeft,2500);
});
test('无共享成员和停用成员不能取得启动器订阅',()=>{
 const db=fixture();for(const user of [db.users[4],{...db.users[0],enabled:false},null])assert.throws(()=>launcherSubscription(db,user,NOW),e=>e.statusCode===403);
});
test('过期、停用、非Opus、配额过期与同步错误不会被启动器误认为有效订阅',()=>{
 for(const patch of [{subscriptionExpiresAt:NOW-1000},{enabled:false},{subscriptionActive:false},{quotaTier:2},{quotaCheckedAt:NOW-700000},{quotaError:'failed'},{subscriptionExpiresAt:'invalid'},{subscriptionExpiresAt:null}]){
  const db=fixture();Object.assign(db.accounts[0],patch);const result=launcherSubscription(db,db.users[0],NOW);
  assert.equal(result.active,false);assert.equal(result.tier,0);assert.equal(result.expiresAt,0);assert.equal(result.perks.unlimitedImageGeneration,false);assert.equal(result.usage.timeUntilNextPercent,0);
 }
});
test('零份额零余额安全返回；有余额也不按比例放大，Anlas保守整数化',()=>{
 const db=fixture(),s=db.settings.fairQuota;s.groups[0].share=0;s.groups[1].share=.5;s.groups[0].memberWeights={a:0};s.balances.a.v5Available=0;s.balances.a.anlasFixedAvailable=3329.9999999999995;s.balances.a.anlasPurchasedAvailable=8.9;
 let result=launcherSubscription(db,db.users[0],NOW);assert.equal(result.usage.percent,0);assert.equal(result.usage.isNegative,true);assert.equal(result.usage.timeUntilNextPercent,0);assert.equal(result.trainingStepsLeft.fixedTrainingStepsLeft,3330);assert.equal(result.trainingStepsLeft.purchasedTrainingSteps,8);
 s.balances.a.v5Available=.345;result=launcherSubscription(db,db.users[0],NOW);assert.equal(result.usage.percent,.345);assert.equal(result.usage.isNegative,false);
});
test('秒和ISO到期时间均兼容，恢复按个人份额向上取整且不落盘',()=>{
 const db=fixture();db.accounts[0].subscriptionExpiresAt=new Date(NOW+86400000).toISOString();db.accounts[0].v5UsageTimeUntilNextPercent=601;synced(db);
 let result=launcherSubscription(db,db.users[0],NOW);assert.equal(result.expiresAt,(NOW+86400000)/1000);assert.equal(result.usage.timeUntilNextPercent,2404);
 db.accounts[0].subscriptionExpiresAt=(NOW+86400000)/1000;const before=structuredClone(db);result=launcherSubscription(db,db.users[0],NOW+1000);assert.equal(result.active,true);assert.ok(result.usage.percent>20);assert.deepEqual(db,before);
 function synced(db){db.settings.fairQuota.snapshot.seconds=601;}
});
