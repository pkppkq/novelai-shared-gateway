import { quoteNativeRequest } from './native-pricing.js';
// 所有修改必须在存储事务内执行；账本与任务一起持久化，避免重启后重复扣款。
const STALE_MS = 10 * 60 * 1000;
const number = (v) => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const stamp = (v) => { const n=number(v);return n!==null ? (n<1e11?n*1000:n) : Date.parse(v || '') || 0; };
const rows = (v) => Array.isArray(v) ? v : Object.values(v || {});
const fail = (message, status = 402) => { const e = new Error(message); e.status = e.statusCode = status; throw e; };
const active = (a,now) => a?.enabled === true && !a?.quotaError && Number(a?.quotaTier) === 3 && a?.subscriptionActive === true && (!a.subscriptionExpiresAt || stamp(a.subscriptionExpiresAt)>now);
const sum = (s, field) => Object.values(s.balances).reduce((n, b) => n + b[field], 0);
const held = (s, id, resource) => Object.values(s.reservations).filter(c => c.userId === id && c.status === 'reserved').reduce((n,c) => n+(c.resource===resource?c.amount:resource==='anlasFixed'?(c.fixed||0):resource==='anlasPurchased'?(c.purchased||0):0),0);
const sharedHeld = s => Object.values(s.reservations).filter(c=>c.status==='reserved').reduce((n,c)=>n+(c.resource==='v5'?c.amount:(c.sharedV5Reserved||0)),0);
const anyHeld = (s) => Object.values(s.reservations).some(c => c.status === 'reserved');
const totals = (s) => {for(const b of Object.values(s.balances)) b.anlasAvailable=b.anlasFixedAvailable+b.anlasPurchasedAvailable;};

const emptyBalance = () => ({v5Available:0,anlasAvailable:0,anlasFixedAvailable:0,anlasPurchasedAvailable:0});
function upgradeGroups(s) {
  if (!s.groups) s.groups=s.members.map((id,i)=>({id:`group_${i+1}`,name:`第 ${i+1} 组`,members:[id]}));
  for(const group of s.groups){group.share ??= .25;group.memberWeights=Object.fromEntries(group.members.map(id=>[id,group.memberWeights?.[id] ?? 1]));}
  s.version=2;s.configVersion ||= 1;s.configurationHistory ||= [];
  s.spent.fallbackFixed ||= 0;s.spent.fallbackPurchased ||= 0;s.spent.fallbackV5 ||= 0;
  s.fallbackBuffer ||= {fixed:0,purchased:0};s.fallbackTotalsByUser ||= {};s.sharedV5Debt ||= 0;
  return s;
}
const groupFor = (s,id) => s.groups.find(g=>g.members.includes(id));
const weight = (s,id) => { const group=groupFor(s,id);if(!group)return 0;const total=group.members.reduce((n,member)=>n+(group.memberWeights?.[member] ?? 1),0);return total>0?(group.share ?? .25)*((group.memberWeights?.[id] ?? 1)/total):0; };
export function assertFairQuotaIdle(db) {
  if(anyHeld(db.settings?.fairQuota || {reservations:{}})||rows(db.jobs).some(job=>['queued','running'].includes(job.status)))fail('有排队、运行或预留额度的任务，请结清后调整',409);
}

export function configureFairQuota(db, memberIds) {
  if (!Array.isArray(memberIds) || memberIds.length !== 4 || new Set(memberIds).size !== 4 || memberIds.some(id => typeof id !== 'string' || !id)) fail('公平分配需要四个不同的用户 ID', 400);
  db.settings ||= {};
  if (db.settings.fairQuota) {
    if (JSON.stringify(db.settings.fairQuota.members) !== JSON.stringify(memberIds)) fail('已有账本不能直接更换成员',409);
    return upgradeGroups(db.settings.fairQuota);
  }
  return db.settings.fairQuota = upgradeGroups({ version: 2, enabled: true, members: [...memberIds], boundAccountId: null,
    balances: Object.fromEntries(memberIds.map(id => [id,emptyBalance()])),
    reservations: {}, snapshot: null, spent: {v5:0,anlas:0,anlasFixed:0,anlasPurchased:0}, creditedV5:0, lastRefillAt:0,lastSettlementAt:0,status:'pending_opus' });
}

// 仅由管理员接口调用。额度只存在于叶子钱包，组没有第二份可消费余额。
export function configureFairGroups(db, groups, options = {}) {
  if (!Array.isArray(groups) || groups.length!==4) fail('必须配置四个顶层共享组',400);
  const ids=new Set(),members=new Set(),users=rows(db.users);
  const normalized=groups.map(g=>{
    if (!g || typeof g.id!=='string' || !g.id.trim() || ids.has(g.id) || !Array.isArray(g.members)) fail('组 ID 必须唯一且成员必须为数组',400);
    ids.add(g.id);
    for(const id of g.members) {
      const user=users.find(u=>u.id===id);
      const oldState=db.settings?.fairQuota;
      const oldGroups=oldState?.groups || oldState?.members?.map((member,index)=>({id:`group_${index+1}`,members:[member]})) || [];
      const remainsDisabled=user?.enabled===false&&oldGroups.some(group=>group.id===g.id&&group.members.includes(id));
      // 停用只阻止登录与调用，不收回份额；已有停用成员留在原组时可继续管理其他成员。
      if(typeof id!=='string' || members.has(id) || !user || !(user.enabled===true||remainsDisabled)) fail('成员必须唯一且有效；停用成员只能保留在原组',400);
      members.add(id);
    }
    const share=g.share ?? 0.25;
    if(typeof share!=='number'||!Number.isFinite(share)||share<0||share>1)fail('组份额必须介于 0 和 1',400);
    if(!g.members.length&&share!==0)fail('空组份额必须为零',400);
    if(g.memberWeights!==undefined&&(!g.memberWeights||Array.isArray(g.memberWeights)||typeof g.memberWeights!=='object'))fail('成员权重必须为对象',400);
    const memberWeights=Object.fromEntries(g.members.map(id=>{const value=g.memberWeights?.[id] ?? 1;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1000000)fail('成员权重必须介于 0 和 1000000',400);return [id,value];}));
    if(share>0&&Object.values(memberWeights).reduce((n,value)=>n+value,0)<=0)fail('有份额的组至少需要一名正权重成员',400);
    return {share,memberWeights,id:g.id,name:typeof g.name==='string'&&g.name.trim()?g.name.trim().slice(0,80):g.id,members:[...g.members]};
  });
  if(!members.size)fail('至少保留一名共享成员',400);
  if(Math.abs(normalized.reduce((n,g)=>n+g.share,0)-1)>1e-9)fail('四个组份额总和必须为 100%',400);
  assertFairQuotaIdle(db);
  if(members.size>100) fail('共享成员总数不能超过 100',400);
  if(Object.keys(options).some(k=>!['now','redistributeRemaining','actorId'].includes(k))) fail('不支持的分组配置选项',400);
  if(options.redistributeRemaining!==undefined && typeof options.redistributeRemaining!=='boolean') fail('redistributeRemaining 必须是布尔值',400);
  db.settings ||= {};
  const existing=db.settings.fairQuota ? structuredClone(db.settings.fairQuota) : null;
  if(existing && anyHeld(existing)) fail('有任务正在预留额度，请结清后调整分组',409);
  if(existing) {
    for(const [id,b] of Object.entries(existing.balances)) {
      if(!members.has(id) && ['v5Available','anlasFixedAvailable','anlasPurchasedAvailable'].some(f=>b[f]>1e-9)) fail('不能移除仍持有额度的成员，请先处理其余额',409);
    }
  }
  // 先按旧份额完成当前时刻的恢复，再切换后续分配比例。
  const now=options.now ?? Date.now();
  if(!Number.isFinite(now) || now<0) fail('配置时间无效',400);
  const draft={...db,settings:{...db.settings,fairQuota:existing}};
  if(existing) syncFairQuota(draft,now);
  const s=existing || configureFairQuota(draft,['__seed_1','__seed_2','__seed_3','__seed_4']);
  upgradeGroups(s);
  if(existing) {
    for(const [id,b] of Object.entries(s.balances)) {
      if(!members.has(id) && ['v5Available','anlasFixedAvailable','anlasPurchasedAvailable'].some(f=>b[f]>1e-9)) fail('不能移除仍持有额度的成员，请先处理其余额',409);
    }
  }
  if(options.redistributeRemaining===true) {
    for(const g of normalized) for(const id of g.members) {
      const oldGroup=groupFor(s,id),b=s.balances[id];
      if(oldGroup && oldGroup.id!==g.id && ['v5Available','anlasFixedAvailable','anlasPurchasedAvailable'].some(f=>b[f]>1e-9)) fail('有余额成员跨组移动与剩余额度重分必须分两次执行',409);
    }
  }
  const before=structuredClone(s.groups),beforeBalances=structuredClone(s.balances);
  const balances=Object.fromEntries([...members].map(id=>[id,s.balances[id] || emptyBalance()]));
  if(options.redistributeRemaining===true) {
    // 显式重分只转移该组现有钱包总额，不增发余额，也不重分历史消费。
    for(const g of normalized) for(const field of ['v5Available','anlasFixedAvailable','anlasPurchasedAvailable']) {
      const amount=g.members.reduce((total,id)=>total+balances[id][field],0);
      const totalWeight=g.members.reduce((total,id)=>total+g.memberWeights[id],0);
      // 零份额组若全部权重为零，保留已有钱包，避免除零或静默抹去余额。
      if(totalWeight>0)for(const id of g.members) balances[id][field]=amount*(g.memberWeights[id]/totalWeight);
    }
  }
  s.groups=normalized;s.members=[...members];s.balances=balances;s.version=2;s.configVersion+=1;
  s.configurationHistory.push({at:now,actorId:options.actorId || null,version:s.configVersion,before,after:structuredClone(normalized),beforeBalances,afterBalances:structuredClone(balances),redistributeRemaining:options.redistributeRemaining===true});
  s.configurationHistory=s.configurationHistory.slice(-1000);
  totals(s);db.settings.fairQuota=s;return s;
}

// 管理调账始终在独立副本上执行，所有验证通过才提交。
export function manageFairMember(db, body, now=Date.now()) {
  assertFairQuotaIdle(db);
  const draft={...db,users:structuredClone(db.users),settings:structuredClone(db.settings)};
  const s=syncFairQuota(draft,now);
  if(!s?.enabled)fail('共享账本尚未配置',409);
  if(!Number.isInteger(body.expectedConfigVersion)||body.expectedConfigVersion!==s.configVersion)fail('配置已变化，请刷新后重新预览',409);
  const beforeBalances=structuredClone(s.balances),before=structuredClone(s.groups);
  const sourceId=body.action==='transfer-quota'?body.fromUserId:body.userId;
  const targetId=body.action==='transfer-quota'?body.toUserId:body.transferToUserId;
  const source=draft.users.find(u=>u.id===sourceId),target=draft.users.find(u=>u.id===targetId);
  if(!source)fail('成员不存在',404);
  if(!target||target.id===source.id)fail('请选择另一名成员接收余额',400);
  let autoJoined=null,shareChanges=[];
  const transferred={v5:0,anlasFixed:0,anlasPurchased:0};
  if(body.action==='transfer-quota') {
    if(!s.balances[target.id])fail('转账接收成员必须已加入共享分组',400);
    if(!s.balances[source.id])fail('转出成员未加入共享分组',400);
    if(!Object.hasOwn(transferred,body.resource)||typeof body.amount!=='number'||!Number.isFinite(body.amount)||body.amount<=0)fail('转账资源或数量无效',400);
    if(body.resource!=='v5'&&!Number.isInteger(body.amount))fail('Anlas 转账数量必须为整数',400);
    const field=body.resource+'Available';
    if(s.balances[source.id][field]+1e-9<body.amount)fail('转出成员余额不足',409);
    if(body.resource==='v5'&&s.balances[target.id][field]+body.amount>100*weight(s,target.id)+1e-9)fail('接收成员 V5 超出容量，请先增加其份额或减少转账量',409);
    s.balances[source.id][field]-=body.amount;s.balances[target.id][field]+=body.amount;transferred[body.resource]=body.amount;
  } else {
    const originalShares=Object.fromEntries(s.members.map(id=>[id,weight(s,id)]));
    const originalGroup=groupFor(s,source.id);
    if(!s.balances[target.id]){
      if(!originalGroup)fail('删除未分组成员时，请选择已分组成员接收；双方均未分组无法继承份额',400);
      if(target.enabled!==true)fail('未分组接收成员必须已启用，才能继承共享份额',400);
      // 直接替换原位置与权重，不先增加成员分摊，避免其他成员份额发生短暂或永久改变。
      const memberWeight=originalGroup.memberWeights[source.id] ?? 1;
      originalGroup.members=originalGroup.members.map(id=>id===source.id?target.id:id);
      originalGroup.memberWeights[target.id]=memberWeight;delete originalGroup.memberWeights[source.id];
      s.members=s.members.map(id=>id===source.id?target.id:id);s.balances[target.id]=emptyBalance();
      autoJoined={userId:target.id,groupId:originalGroup.id,memberWeight,share:weight(s,target.id)};
    }
    if(s.members.includes(source.id)&&s.members.length<=1)fail('不能删除最后一名共享成员，请选择启用的未分组成员继承份额',409);
    for(const resource of Object.keys(transferred)) {
      const amount=s.balances[source.id]?.[resource+'Available'] || 0;
      transferred[resource]=amount;s.balances[target.id][resource+'Available']+=amount;
    }
    // 删除接收的 V5 可以暂时超容量，恢复函数只在余额低于容量后继续入账。
    delete s.balances[source.id];s.members=s.members.filter(id=>id!==source.id);
    // 按删除前的全局份额精确转给指定接收者，不让组内其他成员被动分走份额。
    const finalShares={...originalShares,[source.id]:0,[target.id]:(originalShares[target.id] || 0)+(originalShares[source.id] || 0)};
    s.groups=s.groups.map(g=>{
      const members=g.members.filter(id=>id!==source.id);
      return {...g,members,share:members.reduce((n,id)=>n+(finalShares[id] || 0),0),memberWeights:Object.fromEntries(members.map(id=>[id,(finalShares[id] || 0)*100]))};
    });
    shareChanges=[...new Set([...Object.keys(originalShares),source.id,target.id])].map(userId=>({userId,beforeShare:originalShares[userId] || 0,afterShare:finalShares[userId] || 0}));
    draft.users=draft.users.filter(u=>u.id!==source.id);
  }
  totals(s);s.configVersion+=1;
  s.configurationHistory.push({at:now,actorId:'administrator',action:body.action==='transfer-quota'?'transfer-quota':'delete-member',version:s.configVersion,sourceId,targetId,transferred,autoJoined,shareChanges,before,after:structuredClone(s.groups),beforeBalances,afterBalances:structuredClone(s.balances)});
  s.configurationHistory=s.configurationHistory.slice(-1000);
  const result={configVersion:s.configVersion,groups:s.groups,transferred,autoJoined,shareChanges,users:draft.users.map(user=>({id:user.id,quota:fairQuotaSummary(draft,user,now)})),...(body.action==='transfer-quota'?{fromUserId:sourceId,toUserId:targetId}:{deletedUserId:sourceId,transferToUserId:targetId})};
  if(body.action==='preview-delete-member')result.configVersion=body.expectedConfigVersion;
  else {db.settings=draft.settings;db.users=draft.users;}
  return result;
}

function distribute(s, resource, delta) {
  const field = `${resource}Available`;
  if (delta >= 0) {
    let actual = 0;
    for (const id of s.members) {
      const b = s.balances[id];
      const add = resource === 'v5' ? Math.min(delta*weight(s,id), Math.max(0,100*weight(s,id)-held(s,id,'v5')-b[field])) : delta*weight(s,id);
      b[field] += add; actual += add;
    }
    totals(s);return actual;
  }
  // 官方余额低于账本时只削减未预留额度，不把其他人的余额变成负数。
  const total = sum(s,field), factor = total > 0 ? Math.max(0,total+delta)/total : 0;
  for(const b of Object.values(s.balances)) b[field] *= factor;
  totals(s);
  return 0;
}

function readSnapshot(a) {
  const percent=number(a.v5UsagePercent), fixed=number(a.quotaFixed), purchased=number(a.quotaPurchased);
  return {at:stamp(a.quotaCheckedAt),v5: a.v5UsageIsNegative ? 0 : percent === null ? null : Math.max(0,Math.min(100,percent)),
    anlas:fixed === null || purchased === null ? null : Math.max(0,fixed+purchased),anlasFixed:fixed===null?null:Math.max(0,fixed),anlasPurchased:purchased===null?null:Math.max(0,purchased),
    seconds:number(a.v5UsageTimeUntilNextPercent)};
}

export function syncFairQuota(db, now = Date.now()) {
  const s=db.settings?.fairQuota;
  if(!s?.enabled) return s || null;
  upgradeGroups(s);
  const accounts=rows(db.accounts);
  if(!s.boundAccountId) {
    const eligible=accounts.filter(a=>active(a,now));
    if(eligible.length!==1) {s.status=eligible.length?'ambiguous_opus':'pending_opus';return s;}
    s.boundAccountId=eligible[0].id;
  }
  const account=accounts.find(a=>a.id===s.boundAccountId);
  if(!active(account,now)) {s.status='inactive_opus';return s;}
  const incoming=readSnapshot(account);
  if(!incoming.at || incoming.at>now+60000 || now-incoming.at>STALE_MS) {s.status='stale';return s;}
  s.status='active';
  if(!s.snapshot) {
    if(incoming.v5===null || incoming.anlas===null) {s.status='unknown_balance';return s;}
    s.snapshot=incoming;s.lastRefillAt=now;
    distribute(s,'v5',incoming.v5);distribute(s,'anlasFixed',incoming.anlasFixed);distribute(s,'anlasPurchased',incoming.anlasPurchased);
    return s;
  }
  const old=s.snapshot;
  // 官方字段表示恢复完整 1% 的秒数。旧快照超过十分钟后不再推算恢复。
  const until=Math.min(now,old.at+STALE_MS);
  if(old.seconds>0 && until>s.lastRefillAt) {
    const elapsed=(until-s.lastRefillAt)/1000/old.seconds;
    const projected=Math.min(100,old.v5+Math.max(0,until-old.at)/1000/old.seconds);
    // 本地转扣可能仍消耗共享 V5。先用恢复偿还此估算负债，不能重复发放给个人。
    const repaid=Math.min(s.sharedV5Debt,elapsed);s.sharedV5Debt-=repaid;
    const reserves=sharedHeld(s);
    const room=Math.max(0,projected-s.spent.v5-reserves-sum(s,'v5Available'));
    s.creditedV5+=distribute(s,'v5',Math.min(elapsed-repaid,room));
  }
  s.lastRefillAt=Math.max(s.lastRefillAt,until);
  // 并发生成期间的快照无法归属消费，待全部结清且取得新快照后校准。
  if(incoming.at>old.at && incoming.at>=s.lastSettlementAt && !anyHeld(s) && incoming.v5!==null && incoming.anlas!==null) {
    // 官方 V5 常只返回整数百分比，单张消费尚不可见时不能按余额差额退回估算扣费。
    // 日常恢复只由上面的官方恢复周期驱动；快照仅校准超过显示精度的偏差。
    const v5Total=sum(s,'v5Available');
    const tolerance=Number.isInteger(incoming.v5)?1:0;
    const difference=incoming.v5-v5Total;
    const deficit=incoming.v5-(v5Total-s.sharedV5Debt);
    if(deficit < -tolerance-1e-9) {
      // 余额明显高估时直接降至官方值，不借显示容差继续透支。
      distribute(s,'v5',deficit);
    } else if(difference > tolerance+1e-9) {
      // 正向校准最多补到官方显示区间的下界，不把尚未显示的消费再次发放。
      distribute(s,'v5',difference-tolerance);
    }
    for(const [resource,pool] of [['anlasFixed','fixed'],['anlasPurchased','purchased']]) {
      // 本地转扣不是已证实的上游 Anlas 消费，绝不加进普通充值校正。
      let delta=incoming[resource]-old[resource]+s.spent[resource];
      if(delta<0) {
        // 抵消凭据跨相同快照及重启保留，也吸收随后才出现的官方扣款，避免双扣。
        const matched=Math.min(s.fallbackBuffer[pool],-delta);
        s.fallbackBuffer[pool]-=matched;delta+=matched;
      }
      distribute(s,resource,delta);
    }
    s.snapshot=incoming;s.spent={v5:0,anlas:0,anlasFixed:0,anlasPurchased:0,fallbackFixed:0,fallbackPurchased:0,fallbackV5:0};s.creditedV5=0;s.lastRefillAt=now;
  }
  // 未能对账的旧基准也不能无限使用，否则连续任务可能永远绕过过期检查。
  if(now-s.snapshot.at>STALE_MS) s.status='stale';
  return s;
}

export function quoteFairRequest(request = {}, options = {}) {
  return quoteNativeRequest(request, options);
}

export function reserveFairQuota(db,user,job,account,now=Date.now()) {
  const s=syncFairQuota(db,now);
  if(!s?.enabled) return null;
  if(!s.members.includes(user.id)) fail('该用户未加入共享分组账本',403);
  if(s.status!=='active') fail(`共享 Opus 额度暂不可用：${s.status}`,503);
  if(account.id!==s.boundAccountId) fail('共享账本只能使用绑定的 Opus 账号',503);
  if(!job.id) fail('任务缺少持久化 ID',500);
  const previous=s.reservations[job.id];
  if(previous) {if(previous.userId!==user.id) fail('任务账本归属不符',409);if(previous.status==='refunded') fail('已退款任务不能重新提交',409);job.fairCharge=previous;return previous;}
  const request=job.request || job.requestPayload;
  let q=quoteFairRequest(request);
  let fallback=false,v5Equivalent=0,sharedV5Reserved=0;
  if(q.resource==='v5' && s.autoAnlasFallback===true && s.balances[user.id].v5Available+1e-9<q.amount) {
    fallback=true;v5Equivalent=q.amount;q=quoteFairRequest(request,{forceAnlas:true});
    const latest=readSnapshot(account);
    const projected=latest.v5===null?null:Math.min(100,latest.v5+(latest.seconds>0?Math.max(0,now-latest.at)/1000/latest.seconds:0));
    sharedV5Reserved=projected!==null&&projected>0?v5Equivalent:0;
  }
  const field=q.resource==='v5'?'v5Available':'anlasAvailable';
  let fixed=0,purchased=0;
  if(q.resource==='anlas') {
    fixed=Math.min(q.amount,s.balances[user.id].anlasFixedAvailable);purchased=q.amount-fixed;
    if(purchased>0 && (job.request||job.requestPayload)?.allowPurchasedAnlas!==true) fail('个人固定 Anlas 不足；未经明确授权不会扣购买 Anlas');
    if(purchased>s.balances[user.id].anlasPurchasedAvailable+1e-9) fail('个人购买 Anlas 不足');
    if(purchased>0) {
      // 上游优先使用固定余额，不能指定购买池；禁止混用导致其他成员被扣款。
      const official=readSnapshot(account),fixedReserved=s.members.reduce((n,id)=>n+held(s,id,'anlasFixed'),0);
      if(fixed>0 || official.anlasFixed!==0 || fixedReserved>0 || s.spent.anlasFixed>0 || s.spent.fallbackFixed>0) fail('暂不能使用购买 Anlas：请等待官方固定余额完全耗尽并完成对账；不支持混合固定与购买余额');
    }
  }
  if(q.resource!=='free') {
    if(s.balances[user.id][field]+1e-9<q.amount) fail(q.resource==='v5'?'个人 V5 恢复额度不足，请等待恢复；不会自动扣 Anlas':'个人 Anlas 不足');
    if(q.resource==='v5' && sum(s,field)-s.sharedV5Debt-sharedHeld(s)+s.members.reduce((n,id)=>n+held(s,id,'v5'),0)-q.amount<1) fail('V5 公共额度已达到安全保留边界，请等待恢复');
    // 未结清并发会延后账本校准，但新快照下降必须立即限制派发。
    const latest=readSnapshot(account);
    const reserved=q.resource==='v5'?sharedHeld(s):s.members.reduce((n,id)=>n+held(s,id,q.resource),0);
    const projected=q.resource==='v5'
      ? latest.v5===null?null:Math.min(100,latest.v5+(latest.seconds>0?Math.max(0,now-latest.at)/1000/latest.seconds:0))
      : latest.anlas;
    const margin=q.resource==='v5'?1:0;
    const fallbackSpent=q.resource==='v5'?s.spent.fallbackV5:s.spent.fallbackFixed+s.spent.fallbackPurchased;
    if(projected===null || projected-reserved-s.spent[q.resource]-fallbackSpent-q.amount<margin) fail('官方公共额度不足或等待并发对账，请稍后重试');
    if(q.resource==='anlas') {
      for(const [resource,amount] of [['anlasFixed',fixed],['anlasPurchased',purchased]]) {
        const globalHeld=s.members.reduce((n,id)=>n+held(s,id,resource),0);
        const pendingFallback=resource==='anlasFixed'?s.spent.fallbackFixed:s.spent.fallbackPurchased;
        if(latest[resource]-globalHeld-s.spent[resource]-pendingFallback+1e-9<amount) fail('官方 Anlas 子余额不足或等待并发对账');
      }
      s.balances[user.id].anlasFixedAvailable-=fixed;s.balances[user.id].anlasPurchasedAvailable-=purchased;totals(s);
    } else s.balances[user.id][field]-=q.amount;
  }
  const charge={...q,fixed,purchased,...(fallback?{billingMode:'anlas_fallback',v5Equivalent,sharedV5Reserved,upstreamBilling:'shared_or_anlas'}:{}),configVersion:s.configVersion,groupId:groupFor(s,user.id)?.id,userId:user.id,accountId:account.id,status:'reserved',reservedAt:now};
  s.reservations[job.id]=charge;job.fairCharge=charge;
  return charge;
}

export function settleFairQuota(db,job,success,now=Date.now()) {
  const s=db.settings?.fairQuota,c=s?.reservations?.[job.id];
  if(!c || c.status!=='reserved') return c || null;
  upgradeGroups(s);
  c.status=success?'settled':'refunded';c.settledAt=now;
  if(c.resource!=='free') {
    if(success) {
      if(c.billingMode==='anlas_fallback') {
        s.spent.fallbackFixed+=c.fixed;s.spent.fallbackPurchased+=c.purchased;s.spent.fallbackV5+=c.sharedV5Reserved||0;
        s.fallbackBuffer.fixed+=c.fixed;s.fallbackBuffer.purchased+=c.purchased;s.sharedV5Debt+=c.sharedV5Reserved||0;
        const total=s.fallbackTotalsByUser[c.userId] ||= {fixed:0,purchased:0,v5Equivalent:0};
        total.fixed+=c.fixed;total.purchased+=c.purchased;total.v5Equivalent+=c.v5Equivalent;
      } else {s.spent[c.resource]+=c.amount;if(c.resource==='anlas'){s.spent.anlasFixed+=c.fixed;s.spent.anlasPurchased+=c.purchased;}}
    }
    else if(c.resource==='anlas'){s.balances[c.userId].anlasFixedAvailable+=c.fixed;s.balances[c.userId].anlasPurchasedAvailable+=c.purchased;totals(s);}
    else s.balances[c.userId].v5Available+=c.amount;
  }
  s.lastSettlementAt=Math.max(s.lastSettlementAt,now);job.fairCharge=c;
  return c;
}

export function fairQuotaSummary(db,user,now=Date.now()) {
  const s=syncFairQuota(db,now);
  if(!s?.enabled) return null;
  const b=s.balances[user.id],group=groupFor(s,user.id),share=weight(s,user.id);
  const localFallback=s.fallbackTotalsByUser[user.id] || {fixed:0,purchased:0,v5Equivalent:0};
  return {enabled:true,status:s.status,member:Boolean(b),share,autoAnlasFallback:s.autoAnlasFallback===true,
    localAnlasFallbackSpent:localFallback.fixed+localFallback.purchased,localAnlasFallbackFixedSpent:localFallback.fixed,localAnlasFallbackPurchasedSpent:localFallback.purchased,localFallbackV5Equivalent:localFallback.v5Equivalent,groupId:group?.id??null,groupName:group?.name??null,groupSize:group?.members.length??0,boundAccountId:s.boundAccountId,
    v5Available:b?.v5Available??0,v5Capacity:100*share,v5Reserved:b?held(s,user.id,'v5'):0,
    anlasAvailable:b?.anlasAvailable??0,anlasReserved:b?held(s,user.id,'anlas'):0,
    anlasFixedAvailable:b?.anlasFixedAvailable??0,anlasPurchasedAvailable:b?.anlasPurchasedAvailable??0,
    anlasFixedReserved:b?held(s,user.id,'anlasFixed'):0,anlasPurchasedReserved:b?held(s,user.id,'anlasPurchased'):0,
    v5Estimated:true,quotaCheckedAt:s.snapshot?.at??null,refillSecondsPerPercent:s.snapshot?.seconds??null};
}
