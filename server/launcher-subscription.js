import { fairQuotaSummary } from './fair-quota.js';

const rows=value=>Array.isArray(value)?value:Object.values(value || {});
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,value):0;
const wholeBalance=value=>Math.floor(nonnegative(value)+1e-9);
function expiration(value){
  if(value===null||value===undefined||value===''||typeof value==='boolean')return 0;
  const numeric=Number(value),milliseconds=Number.isFinite(numeric)?numeric<1e11?numeric*1000:numeric:Date.parse(value);
  return Number.isFinite(milliseconds)&&milliseconds>0?Math.floor(milliseconds/1000):0;
}

// 兼容启动器的官方字段名，内容仅表示调用者本地配额，不是共享上游的总余额。
// 在副本中估算恢复，查询不改变真实余额、审计或配置，也不返回任何上游标识。
export function launcherSubscription(db,user,now=Date.now()){
  if(!user||user.enabled===false)throw Object.assign(new Error('成员未启用'),{statusCode:403});
  const draft={...db,settings:structuredClone(db.settings || {})};
  const quota=fairQuotaSummary(draft,user,now);
  if(!quota?.member)throw Object.assign(new Error('该用户未加入共享分组账本'),{statusCode:403});
  const account=rows(db.accounts).find(a=>a.id===quota.boundAccountId);
  const expires=expiration(account?.subscriptionExpiresAt);
  const active=quota.status==='active'&&account?.enabled===true&&account?.subscriptionActive===true&&Number(account?.quotaTier)===3&&expires>Math.floor(now/1000);
  const percent=nonnegative(quota.v5Available),share=nonnegative(quota.share),seconds=nonnegative(quota.refillSecondsPerPercent);
  const recovery=active&&share>0&&seconds>0?Math.ceil(seconds/share):0;
  return {
    tier:active?3:0,active,expiresAt:active?expires:0,
    trainingStepsLeft:{fixedTrainingStepsLeft:wholeBalance(quota.anlasFixedAvailable),purchasedTrainingSteps:wholeBalance(quota.anlasPurchasedAvailable)},
    perks:{imageGeneration:active,unlimitedImageGeneration:active,unlimitedImageGenerationLimits:active?[{resolution:1048576,maxPrompts:1}]:[]},
    usage:{percent,isNegative:percent<=0,timeUntilNextPercent:Number.isSafeInteger(recovery)?recovery:0}
  };
}
