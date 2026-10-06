let events = null, active = false;
const box = document.createElement('section');
box.innerHTML = `<h2>共享账户状态 <small>只读</small></h2><p id="sharedConnection" class="muted">等待连接</p><div class="cards"><article><h2>订阅与队列</h2><strong id="sharedState">—</strong><p id="sharedSubscription"></p><p id="sharedQueue"></p><p id="sharedCooldown"></p></article><article><h2>公共 V5 余量</h2><strong id="sharedV5">—</strong><p id="sharedRefill"></p><small>显示官方最近一次查询值，不等同于你的个人余额。</small></article><article><h2>公共 Anlas</h2><strong id="sharedFixed">—</strong><p id="sharedPurchased"></p><small>订阅与购买额度独立记录。</small></article></div><p id="sharedUpdated" class="muted"></p><p id="sharedError" class="notice" hidden></p>`;
document.getElementById('status').after(box);
const $ = id => document.getElementById(id);
const n = value => value == null ? '未知' : Number(value).toLocaleString('zh-CN', {maximumFractionDigits:3});
const date = value => {if (!value) return '未知'; const d = new Date(value);return Number.isNaN(d.getTime()) ? '未知' : d.toLocaleString('zh-CN');};
const labels = { pending_opus:'等待 Opus', inactive_opus:'订阅不可用', stale:'余额已过期', active:'可用', cooldown:'限流冷却', quota_sync_error:'同步异常', disabled:'账户停用', unknown_balance:'余额未知' };
function render(s) {
  $('sharedState').textContent=labels[s.status] || s.status;
  $('sharedSubscription').textContent=s.subscriptionActive && s.status!=='inactive_opus' ? `Opus 有效 · 到期 ${date(s.expiresAt)}` : '没有可用的 Opus 订阅';
  $('sharedQueue').textContent=`生成中 ${n(s.running)} / ${n(s.concurrencyLimit)} · 排队 ${n(s.queued)}`;
  $('sharedCooldown').textContent=s.cooldownUntil && new Date(s.cooldownUntil).getTime()>Date.now() ? `冷却至 ${date(s.cooldownUntil)}` : '当前无冷却';
  $('sharedV5').textContent=s.v5Percent==null ? '未知' : `${n(s.v5Percent)}%${s.v5IsNegative?'（已透支）':''}`;
  $('sharedRefill').textContent=s.refillSecondsPerPercent>0 ? `约 ${n(86400/s.refillSecondsPerPercent)} 个百分点 / 天` : '恢复速度未知或已暂停';
  $('sharedFixed').textContent=`${n(s.anlasFixed)} 订阅`;
  $('sharedPurchased').textContent=`购买 Anlas：${n(s.anlasPurchased)}`;
  $('sharedUpdated').textContent=`官方余额更新：${date(s.officialCheckedAt)}。每 60 秒查询，生成结束后也刷新；队列变化通常在 2 秒内推送。`;
  const problems=[];if(s.quotaSyncError)problems.push('官方余额同步异常');if(s.stale)problems.push(s.officialCheckedAt?'余额数据已过期，请勿作为当前余量':'尚无共享 Opus 的官方余额数据');if(s.recentFailures)problems.push(`最近一小时失败 ${n(s.recentFailures)} 次`);
  $('sharedError').hidden=!problems.length;$('sharedError').textContent=problems.join(' · ');
  $('sharedConnection').textContent='状态连接正常 · 接收于 '+new Date().toLocaleTimeString('zh-CN');
}
function connect() {
  if (!active || document.hidden || events) return;
  events=new EventSource('/api/member/shared-events');
  $('sharedConnection').textContent='正在连接共享状态…';
  events.addEventListener('shared-status',event=>{try{render(JSON.parse(event.data));}catch{$('sharedConnection').textContent='状态数据无效，请刷新页面';}});
  events.addEventListener('auth-expired',()=>{stopSharedStatus();$('sharedConnection').textContent='登录已过期，请重新登录';});
  events.onerror=()=>{$('sharedConnection').textContent='状态连接中断，正在重连；以下为上次接收的数据';};
  events.onopen=()=>{$('sharedConnection').textContent='状态连接已建立';};
}
export function startSharedStatus(){active=true;connect();}
export function stopSharedStatus(){active=false;events?.close();events=null;$('sharedConnection').textContent='状态连接已关闭';}
document.addEventListener('visibilitychange',()=>{if(document.hidden){events?.close();events=null;}else connect();});
window.addEventListener('pagehide',()=>{events?.close();events=null;});
