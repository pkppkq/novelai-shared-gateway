// 共享状态仅返回白名单汇总；不改变账本、不调用上游，也不返回个人账户资料。
const STALE_MS = 10 * 60 * 1000;
const rows = value => Array.isArray(value) ? value : Object.values(value || {});
const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
function timestamp(value) {
  if(value === null || value === undefined || value === '') return null;
  const numeric=number(value);
  const result=numeric===null?Date.parse(value):numeric<1e11?numeric*1000:numeric;
  return Number.isFinite(result)&&result>=0&&result<=8640000000000000?result:null;
}
const iso = value => value===null?null:new Date(value).toISOString();
const bool = value => typeof value==='boolean'?value:null;

export function sharedAccountStatus(db, now = Date.now()) {
  const state=db?.settings?.fairQuota;
  const members=new Set(state?.members || []);
  const tokens=new Set(rows(db?.users).filter(u=>members.has(u.id)&&typeof u.token==='string'&&u.token).map(u=>u.token));
  const jobs=rows(db?.jobs).filter(j=>tokens.has(j.userToken));
  const base={status:'pending_opus',subscriptionActive:null,expiresAt:null,officialCheckedAt:null,stale:true,
    v5Percent:null,v5IsNegative:null,refillSecondsPerPercent:null,anlasFixed:null,anlasPurchased:null,
    running:jobs.filter(j=>j.status==='running').length,queued:jobs.filter(j=>j.status==='queued').length,
    concurrencyLimit:4,cooldownUntil:null,quotaSyncError:false,
    recentFailures:jobs.filter(j=>{const at=timestamp(j.completedAt ?? j.failedAt ?? j.updatedAt);return j.status==='failed'&&at!==null&&at<=now&&at>=now-3600000;}).length};
  // 未绑定时不挑选其他上游账户，防止把试用池资料带入共享状态。
  if(!state?.boundAccountId) return base;
  const account=rows(db?.accounts).find(a=>a.id===state.boundAccountId);
  if(!account) return {...base,status:'inactive_opus'};
  const checked=timestamp(account.quotaCheckedAt),expires=timestamp(account.subscriptionExpiresAt),cooldown=timestamp(account.cooldownUntil);
  const stale=checked===null || checked>now+60000 || now-checked>STALE_MS;
  const quotaSyncError=Boolean(account.quotaError);
  const validSubscription=account.enabled===true&&account.subscriptionActive===true&&number(account.quotaTier)===3&&(!account.subscriptionExpiresAt || (expires!==null&&expires>now));
  const v5=number(account.v5UsagePercent),fixed=number(account.quotaFixed),purchased=number(account.quotaPurchased);
  const cooling=cooldown!==null&&cooldown>now;
  const status=!validSubscription?'inactive_opus':quotaSyncError?'quota_sync_error':stale?'stale':cooling?'cooldown':v5===null||fixed===null||purchased===null?'unknown_balance':'active';
  return {...base,status,subscriptionActive:bool(account.subscriptionActive),expiresAt:iso(expires),officialCheckedAt:iso(checked),stale,
    v5Percent:v5,v5IsNegative:bool(account.v5UsageIsNegative),refillSecondsPerPercent:number(account.v5UsageTimeUntilNextPercent),
    anlasFixed:fixed,anlasPurchased:purchased,cooldownUntil:cooling?iso(cooldown):null,quotaSyncError};
}
