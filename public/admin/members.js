const $=id=>document.getElementById(id);let state=null,upstream=null;
async function adminApi(path,method='GET',body) {
  const response=await fetch(path,{method,credentials:'same-origin',headers:{'x-admin-token':$('adminToken').value,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  let result;try{result=await response.json();}catch{throw new Error('管理端响应异常，请检查连接');}
  if(!response.ok)throw new Error(result.message||result.error||'请求失败');return result;
}
async function api(body) {return adminApi('/api/admin/member-management',body?'POST':'GET',body);}
const amount=value=>value===null||value===undefined||value===''?'未知':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:3});
const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN'):'未知';
async function loadUpstream() {
  // 不请求明文密钥，只提取当前绑定上游的白名单状态，丢弃其余响应资料。
  const summary=await adminApi('/api/admin/summary');
  const id=summary.settings?.fairQuota?.boundAccountId || state?.users?.find(u=>u.quota?.boundAccountId)?.quota.boundAccountId;
  const account=summary.accounts?.find(a=>a.id===id);
  upstream=account?{id,enabled:account.enabled===true,tier:account.quotaTier,inFlight:Number(account.inFlight||0),v5:account.v5UsagePercent,negative:account.v5UsageIsNegative,fixed:account.quotaFixed,purchased:account.quotaPurchased,checkedAt:account.quotaCheckedAt,syncError:Boolean(account.quotaError),cooldownUntil:account.cooldownUntil}:null;
  $('refreshUpstream').disabled=!upstream;$('toggleUpstream').disabled=!upstream;$('upstreamPst').disabled=!upstream;$('saveUpstreamPst').disabled=!upstream;
  if(!upstream){$('upstreamStatus').textContent='尚未绑定共享 Opus，请先完成上游绑定。';$('upstreamQuota').textContent='';$('upstreamUpdated').textContent='';return;}
  const names={active:'可用',pending_opus:'等待 Opus',inactive_opus:'暂不可用',stale:'额度快照过期',unknown_balance:'余额未知',ambiguous_opus:'等待绑定'};
  $('upstreamStatus').textContent=`${upstream.enabled?'已启用':'已暂停'} · ${Number(upstream.tier)===3?'Opus':'订阅待核验'} · ${names[state?.status]||'等待校验'} · 生成中 ${upstream.inFlight}`;
  $('upstreamQuota').textContent=`公共 V5 ${amount(upstream.v5)}%${upstream.negative?'（暂不可用）':''} · 订阅 Anlas ${amount(upstream.fixed)} · 购买 Anlas ${amount(upstream.purchased)}`;
  const cooling=Date.parse(upstream.cooldownUntil||'')>Date.now();
  $('upstreamUpdated').textContent=`官方查询时间：${date(upstream.checkedAt)}${upstream.syncError?' · 查询失败，请检查凭据后刷新':''}${cooling?' · 冷却至 '+date(upstream.cooldownUntil):''}`;
  $('toggleUpstream').textContent=upstream.enabled?'暂停共享上游':'启用共享上游';
}

function option(value,label){const o=document.createElement('option');o.value=value;o.textContent=label;return o;}
async function load(){state=await api();$('autoFallback').checked=state.autoAnlasFallback===true;$('dashboard').hidden=false;$('groupNames').replaceChildren();$('members').replaceChildren();$('userId').replaceChildren(option('','创建新账户'));
  for(const g of state.groups){const label=document.createElement('label');label.textContent='组名';const input=document.createElement('input');input.value=g.name;input.dataset.groupId=g.id;input.maxLength=60;label.append(input);$('groupNames').append(label);}
  for(const u of state.users){$('userId').append(option(u.id,(u.username||u.note||u.id)+(u.enabled?'':'（已停用）')));const tr=document.createElement('tr');const name=document.createElement('td');name.textContent=u.username||u.note||u.id;const assignment=document.createElement('td');const select=document.createElement('select');select.dataset.userId=u.id;select.append(option('','不在任何组'));for(const g of state.groups)select.append(option(g.id,g.name));select.value=state.groups.find(g=>g.members.includes(u.id))?.id||'';if(!u.enabled)select.disabled=true;assignment.append(select);const share=document.createElement('td');share.textContent=((u.quota?.share||0)*100).toFixed(2)+'%';const balance=document.createElement('td');balance.textContent=[u.quota?.v5Available,u.quota?.anlasFixedAvailable,u.quota?.anlasPurchasedAvailable].map(v=>Number(v||0).toFixed(2)).join(' / ');tr.append(name,assignment,share,balance);$('members').append(tr);}
  await loadUpstream();
}
function run(fn){return async e=>{e?.preventDefault();$('message').textContent='';try{await fn();}catch(err){$('message').textContent=err.message;}};}
$('connect').onsubmit=run(load);$('refresh').onclick=run(load);
$('userId').onchange=()=>{$('username').value=state?.users.find(u=>u.id===$('userId').value)?.username||'';$('password').value='';};
$('credentials').onsubmit=run(async()=>{await api({action:'credentials',userId:$('userId').value,username:$('username').value,password:$('password').value});$('password').value='';await load();$('message').textContent='登录凭据已保存。新账户请分配到组。';});
$('saveGroups').onclick=run(async()=>{const groups=state.groups.map(g=>({id:g.id,name:[...$('groupNames').querySelectorAll('input')].find(i=>i.dataset.groupId===g.id).value,members:[...$('members').querySelectorAll('select')].filter(s=>s.value===g.id).map(s=>s.dataset.userId)}));await api({action:'groups',groups,redistributeRemaining:$('redistribute').checked});$('redistribute').checked=false;await load();$('message').textContent='分组与份额已保存。';});
$('adminToken').value=localStorage.getItem('nai.adminToken')||'';

$('saveFallback').onclick=run(async()=>{await api({action:'fallback-policy',enabled:$('autoFallback').checked});await load();$('message').textContent='续用规则已保存，仅影响之后的任务。';});

$('refreshUpstream').onclick=run(async()=>{
  if(!upstream)throw new Error('尚未绑定共享 Opus');
  const result=await adminApi('/api/admin/accounts/quota','POST',{ids:[upstream.id]});
  await load();$('message').textContent=result.failed?'官方额度查询失败，请检查凭据；未发起生图。':'官方额度已刷新，未发起生图。';
});
$('toggleUpstream').onclick=run(async()=>{
  if(!upstream)throw new Error('尚未绑定共享 Opus');
  const id=upstream.id,enable=!upstream.enabled;
  if(enable){const result=await adminApi('/api/admin/accounts/quota','POST',{ids:[id]});if(result.failed){await load();throw new Error('官方额度查询失败，保持暂停，请检查 PST。');}}
  await adminApi('/api/admin/accounts/'+encodeURIComponent(id),'PATCH',{enabled:enable});
  await load();$('message').textContent=enable?'共享上游已启用。':'共享上游已暂停，新的生成不会派发。';
});
$('upstreamCredentials').onsubmit=run(async()=>{
  if(!upstream)throw new Error('尚未绑定共享 Opus');
  const token=$('upstreamPst').value.trim();if(!/^pst-[A-Za-z0-9_-]+$/.test(token))throw new Error('请输入完整的 NovelAI PST。');
  if(upstream.inFlight>0)throw new Error('仍有生成进行中，请等待完成后更新 PST。');
  const id=upstream.id;$('saveUpstreamPst').disabled=true;
  try {
    await adminApi('/api/admin/accounts/'+encodeURIComponent(id),'PATCH',{token});
    $('upstreamPst').value='';
    const result=await adminApi('/api/admin/accounts/quota','POST',{ids:[id]});
    await load();$('message').textContent=result.failed?'PST 已更新，上游保持暂停；官方查询失败，请检查凭据。':'PST 已更新且额度已刷新，上游保持暂停。确认后点击“启用共享上游”。';
  } finally {$('saveUpstreamPst').disabled=!upstream;}
});
