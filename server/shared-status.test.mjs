import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedAccountStatus} from './shared-status.js';
const NOW=1800000000000;
function fixture(){return {settings:{fairQuota:{members:['member'],boundAccountId:'opus'}},users:[{id:'member',token:'member-secret'},{id:'other',token:'other-secret'}],accounts:[{id:'opus',token:'upstream-secret',username:'secret-name',enabled:true,subscriptionActive:true,subscriptionExpiresAt:NOW+86400000,quotaTier:3,quotaCheckedAt:NOW,v5UsagePercent:80,v5UsageIsNegative:false,v5UsageTimeUntilNextPercent:600,quotaFixed:9000,quotaPurchased:200}],jobs:[]};}
test('白名单返回只读汇总，没有上游与成员隐私',()=>{
 const db=fixture();db.accounts[0].quotaError='private upstream error';db.jobs.push({userToken:'member-secret',status:'failed',completedAt:NOW,error:'private prompt error',request:{prompt:'secret prompt'}});
 const before=structuredClone(db),s=sharedAccountStatus(db,NOW);assert.deepEqual(db,before);assert.equal(s.status,'quota_sync_error');assert.equal(s.quotaSyncError,true);assert.equal(s.recentFailures,1);
 assert.deepEqual(Object.keys(s).sort(),['status','subscriptionActive','expiresAt','officialCheckedAt','stale','v5Percent','v5IsNegative','refillSecondsPerPercent','anlasFixed','anlasPurchased','running','queued','concurrencyLimit','cooldownUntil','quotaSyncError','recentFailures'].sort());
 for(const secret of ['upstream-secret','member-secret','other-secret','secret-name','private upstream error','secret prompt'])assert.equal(JSON.stringify(s).includes(secret),false);
});
test('未绑定不能展示试用池及其他上游额度',()=>{
 const db=fixture();db.settings.fairQuota.boundAccountId=null;const s=sharedAccountStatus(db,NOW);
 assert.equal(s.status,'pending_opus');assert.equal(s.v5Percent,null);assert.equal(s.anlasFixed,null);assert.equal(s.subscriptionActive,null);
});
test('过期、禁用、非 Opus 与订阅无效均不可用',()=>{
 for(const change of [{enabled:false},{quotaTier:0},{subscriptionActive:false},{subscriptionExpiresAt:NOW},{subscriptionExpiresAt:'invalid'}]) {
  const db=fixture();Object.assign(db.accounts[0],change);assert.equal(sharedAccountStatus(db,NOW).status,'inactive_opus');
 }
 for(const expiry of [NOW+1000,(NOW+1000)/1000,new Date(NOW+1000).toISOString()]) {const db=fixture();db.accounts[0].subscriptionExpiresAt=expiry;assert.equal(sharedAccountStatus(db,NOW).status,'active');assert.equal(sharedAccountStatus(db,NOW+1000).status,'inactive_opus');}
});
test('快照十分钟失效及未来异常快照，不把未知数字伪造成零',()=>{
 const db=fixture();assert.equal(sharedAccountStatus(db,NOW+600001).status,'stale');
 db.accounts[0].quotaCheckedAt=NOW+61000;assert.equal(sharedAccountStatus(db,NOW).stale,true);
 Object.assign(db.accounts[0],{quotaCheckedAt:NOW,v5UsagePercent:null,quotaFixed:'',quotaPurchased:undefined,v5UsageTimeUntilNextPercent:NaN});
 const s=sharedAccountStatus(db,NOW);assert.equal(s.status,'unknown_balance');for(const field of ['v5Percent','anlasFixed','anlasPurchased','refillSecondsPerPercent'])assert.equal(s[field],null);
});
test('负用量标记保留，零与暂停恢复不是未知，冷却只显示未来时间',()=>{
 const db=fixture();Object.assign(db.accounts[0],{v5UsagePercent:0,v5UsageIsNegative:true,v5UsageTimeUntilNextPercent:0,quotaPurchased:0,cooldownUntil:NOW+30000});
 const s=sharedAccountStatus(db,NOW);assert.equal(s.v5Percent,0);assert.equal(s.v5IsNegative,true);assert.equal(s.refillSecondsPerPercent,0);assert.equal(s.anlasPurchased,0);assert.equal(s.status,'cooldown');assert.equal(s.cooldownUntil,new Date(NOW+30000).toISOString());
 assert.equal(sharedAccountStatus(db,NOW+30000).cooldownUntil,null);
});
test('队列与失败只汇总成员任务，最近失败排除一小时前与未来事件',()=>{
 const db=fixture();db.jobs=[{userToken:'member-secret',status:'running'},{userToken:'member-secret',status:'queued'},{userToken:'other-secret',status:'running'},{userToken:'other-secret',status:'queued'},
 {userToken:'member-secret',status:'failed',completedAt:NOW-3599999},{userToken:'member-secret',status:'failed',completedAt:NOW-3600001},{userToken:'member-secret',status:'failed',completedAt:NOW+1},{userToken:'other-secret',status:'failed',completedAt:NOW}];
 const s=sharedAccountStatus(db,NOW);assert.equal(s.running,1);assert.equal(s.queued,1);assert.equal(s.recentFailures,1);assert.equal(s.concurrencyLimit,4);
});
