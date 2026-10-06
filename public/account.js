import { startSharedStatus, stopSharedStatus } from '/shared-status.js';
const $ = id => document.getElementById(id);
const stateNames = { pending_opus:'等待管理员接入有效 Opus', inactive_opus:'订阅暂不可用', stale:'官方余额等待刷新', unknown_balance:'官方余额未知', ambiguous_opus:'等待管理员选择上游', active:'额度已同步' };
async function api(path, body) {
  const r = await fetch('/api/member/' + path, { method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', headers:body === undefined ? {} : {'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) { if (r.status === 401) { stopSharedStatus(); $('login').hidden=false; $('account').hidden=true; } throw new Error(data.message || data.error || '请求失败'); }
  return data;
}
const number = n => Number(n || 0).toLocaleString('zh-CN', {maximumFractionDigits:3});
async function load() {
  const data = await api('me'), q=data.quota; startSharedStatus();
  $('login').hidden=true; $('account').hidden=false; $('welcome').textContent=data.username+' · 我的额度';
  $('group').textContent=q?.member ? `${q.groupName} · ${q.groupSize} 人均分 · 占总额度 ${number(q.share*100)}%` : '尚未分配到组，请联系管理员';
  $('status').textContent=(stateNames[q?.status] || '等待分配额度') + (q?.autoAnlasFallback ? ' · V5 不足时自动按 Anlas 转扣（本站记账；上游可能消耗公共 V5）' : '');
  $('v5').textContent=`${number(q?.v5Available)} / ${number(q?.v5Capacity)}%`;
  $('v5bar').max=q?.v5Capacity || 1; $('v5bar').value=q?.v5Available || 0;
  $('recovery').textContent=`预留 ${number(q?.v5Reserved)}% · `+(q?.refillSecondsPerPercent>0 ? `个人每天约恢复 ${number(86400/q.refillSecondsPerPercent*q.share)} 个百分点` : '恢复速度等待官方数据');
  $('fixed').textContent=number(q?.anlasFixedAvailable); $('purchased').textContent=number(q?.anlasPurchasedAvailable);
  $('fixedHeld').textContent=`预留 ${number(q?.anlasFixedReserved)}`; $('purchasedHeld').textContent=`预留 ${number(q?.anlasPurchasedReserved)}`;
  $('jobs').replaceChildren();
  const status={done:'成功',failed:'失败',queued:'排队',running:'生成中'}, resource={v5:'V5 百分点',anlas:'Anlas',free:'免费'}, settlement={refunded:'已退款',settled:'已结算',reserved:'预留'};
  for (const j of data.jobs) { const row=document.createElement('tr'); for (const value of [new Date(j.createdAt).toLocaleString(),j.model,status[j.status]||j.status,j.charge ? `${settlement[j.charge.status]||j.charge.status} · ${number(j.charge.amount)} ${j.charge.billingMode==='anlas_fallback'?'Anlas（V5 不足转扣）':resource[j.charge.resource]||j.charge.resource}${j.charge.estimated?'（估算）':''}` : '—']) { const cell=document.createElement('td');cell.textContent=value;row.append(cell); } $('jobs').append(row); }
  if (!data.jobs.length) { const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.textContent='暂无调用记录';row.append(cell);$('jobs').append(row); }
}
function run(fn) { return async event => { event?.preventDefault(); $('message').textContent='';try { await fn(); } catch(e) { $('message').textContent=e.message; } }; }
$('loginForm').onsubmit=run(async()=>{ await api('login',{username:$('username').value,password:$('password').value});$('password').value='';await load(); });
$('refresh').onclick=run(load);
$('logout').onclick=run(async()=>{await api('logout',{});stopSharedStatus();$('apiKey').value='';$('keyPanel').hidden=true;$('login').hidden=false;$('account').hidden=true;});
$('showKey').onclick=run(async()=>{const data=await api('key');$('apiKey').value=data.apiKey;$('baseUrl').value=data.baseUrl;$('keyPanel').hidden=false;});
$('hideKey').onclick=()=>{$('keyPanel').hidden=true;$('apiKey').value='';};
$('copyKey').onclick=run(async()=>{await navigator.clipboard.writeText($('apiKey').value);$('message').textContent='已复制自己的 API Key';});
load().catch(()=>{});
