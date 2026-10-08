import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {quoteNativeRequest} from './native-pricing.js';
import {configureFairQuota, syncFairQuota, reserveFairQuota, settleFairQuota, quoteFairRequest} from './fair-quota.js';

// 对照独立保存的官方报价结果；测试数据不包含官网代码和任何真实账户。
const fixture=JSON.parse(readFileSync(new URL('./fixtures/official-image-pricing-20261007.json',import.meta.url),'utf8'));
const expected=(name,args)=>{
  const key=JSON.stringify(args);
  const row=fixture.calls[name].find(item=>JSON.stringify(item.args)===key);
  assert.ok(row,`官方报价样例缺失：${name}`);
  return row.expected;
};
const official={GI:(...args)=>expected('GI',args),H_:(...args)=>expected('H_',args),tY:(...args)=>expected('tY',args)};
const opus={subscription:{tier:3,active:true,usage:{isNegative:false}}};
const image='eA=='.repeat(40);
const input=(extra={})=>({model:'nai-diffusion-4-5-full',width:1024,height:1024,steps:23,n_samples:1,...extra});
function officialParameters(request){
  const p=request.nativeParameters||request.parameters||{};
  return {...p,width:request.width,height:request.height,steps:request.steps,n_samples:1,
    sm:request.sm??p.sm,sm_dyn:request.sm_dyn??p.sm_dyn,
    ...(request.action==='infill'?{inpaintImg2ImgStrength:p.img2img?.strength??p.inpaintImg2ImgStrength??1}:{})};
}

test('官网固定报价校准：基础付费、V5 两次取整、图生图强度和 V3 SMEA',()=>{
  let compared=0;
  const models=['nai-diffusion-3','nai-diffusion-furry-3','nai-diffusion-4-full','nai-diffusion-4-curated-preview','nai-diffusion-4-5-full','nai-diffusion-4-5-curated','nai-diffusion-5-full'];
  for(const model of models)for(const [width,height,steps] of [[1024,1024,29],[1024,1536,23],[1536,1536,37]])for(const strength of [1,0.01,0.3,0.7]){
    const request=input({model,width,height,steps,...(strength===1?{}:{action:'img2img',nativeParameters:{image,strength,noise:0}})});
    const expected=official.GI(officialParameters(request),opus,model);
    if(expected===-3){assert.throws(()=>quoteNativeRequest(request),/140|费用|计价/);continue;}
    const actual=quoteNativeRequest(request);
    assert.equal(actual.resource,'anlas');assert.equal(actual.amount,expected,JSON.stringify({model,width,height,steps,strength}));compared++;
  }
  for(const sm_dyn of [false,true])for(const steps of [29,37]){
    const request=input({model:'nai-diffusion-3',steps,nativeParameters:{sm:true,sm_dyn}});
    assert.equal(quoteNativeRequest(request).amount,official.GI(officialParameters(request),opus,request.model));compared++;
  }
  assert.ok(compared>=80);
});

test('官方免费判定边界：1MP、28 步，标准图生图按当前前端规则',()=>{
  for(const request of [input(),input({steps:28}),input({width:512,height:512}),input({action:'img2img',nativeParameters:{image,strength:0.7}}),input({model:'nai-diffusion-4-5-full-inpainting',action:'infill',nativeParameters:{image,mask:image}})]){
    assert.equal(official.GI(officialParameters(request),opus,request.model),0);
    assert.equal(quoteNativeRequest(request).resource,'free');
  }
  for(const request of [input({steps:29}),input({width:1088})]){
    assert.ok(official.GI(officialParameters(request),opus,request.model)>0);
    assert.equal(quoteNativeRequest(request).resource,'anlas');
  }
});

test('V5 用量条保留估算标记，本地 Anlas 续用与官网强制付费原函数一致',()=>{
  for(const steps of [1,17,23,28])for(const [width,height] of [[512,512],[832,1216],[1024,1024]]){
    const request=input({model:'nai-diffusion-5-full',steps,width,height});
    const normal=quoteNativeRequest(request),fallback=quoteNativeRequest(request,{forceAnlas:true});
    assert.equal(normal.resource,'v5');assert.equal(normal.estimated,true);assert.ok(normal.amount>0);
    assert.equal(fallback.resource,'anlas');assert.equal(fallback.amount,official.GI(officialParameters(request),opus,request.model,true));
  }
  assert.equal(quoteNativeRequest(input({model:'nai-diffusion-5-full'}),{forceAnlas:true}).amount,26);
});

test('V4 Vibe 参考数量附加取官网原函数，V3 不收 V4 编码附加费',()=>{
  for(const count of [1,4,5,8,16]){
    const reference_image_multiple=Array(count).fill(image);
    for(const model of ['nai-diffusion-4-full','nai-diffusion-4-5-full']){
      const result=quoteNativeRequest(input({model,nativeParameters:{reference_image_multiple}}));
      assert.equal(result.amount,official.H_(count));
      assert.equal(result.resource,count<=4?'free':'anlas');
    }
    for(const model of ['nai-diffusion-3','nai-diffusion-furry-3'])assert.equal(quoteNativeRequest(input({model,nativeParameters:{reference_image_multiple}})).amount,0);
  }
  const cached=Array(5).fill(null).map((_,i)=>({data:image,cache_secret_key:`synthetic-${i}`}));
  assert.equal(quoteNativeRequest(input({nativeParameters:{reference_image_multiple_cached:cached}})).amount,2);
  assert.throws(()=>quoteNativeRequest(input({nativeParameters:{reference_image_multiple_cached:[{cache_secret_key:'no-data'}]}})),/参考数据/);
  assert.throws(()=>quoteNativeRequest(input({nativeParameters:{reference_image_multiple:[image],reference_image_multiple_cached:cached}})),/不明确/);
});

test('Precise 真实校准：标准单张保留基础免费，每张参考加 5；不能与 Vibe 或 V5 混用',()=>{
  for(const count of [1,2,16]){
    const request=input({nativeParameters:{director_reference_images:Array(count).fill(image)}});
    const q=quoteNativeRequest(request);
    // Opus 实测官方只扣 5；采用官网 s8 报价传参，不注入另一 UI 提示分支的 characterRef。
    assert.equal(q.amount,official.GI(officialParameters(request),opus,request.model)+5*count);
    assert.equal(q.amount,5*count);assert.equal(q.breakdown.generation,0);assert.equal(q.breakdown.precise,5*count);
  }
  for(const extra of [{steps:29},{width:1536}]){
    const request=input({...extra,nativeParameters:{director_reference_images:[image]}});
    assert.equal(quoteNativeRequest(request).amount,official.GI(officialParameters(request),opus,request.model)+5);
    assert.ok(quoteNativeRequest(request).breakdown.generation>0);
  }
  const cached=input({nativeParameters:{director_reference_images_cached:[{data:image,cache_secret_key:'synthetic-precise'}]}});
  assert.equal(quoteNativeRequest(cached).amount,5);
  assert.throws(()=>quoteNativeRequest(input({model:'nai-diffusion-5-full',nativeParameters:{director_reference_images:[image]}})),/V5/);
  assert.throws(()=>quoteNativeRequest(input({nativeParameters:{director_reference_images:[image],reference_image_multiple:[image]}})),/不能与 Vibe/);
  assert.throws(()=>quoteNativeRequest(input({model:'nai-diffusion-4-full',nativeParameters:{director_reference_images:[image]}})),/仅支持 V4.5/);
});

test('重绘按提交面积及重绘强度；嵌套参数与扁平参数报价一致',()=>{
  for(const strength of [0,0.25,0.7,1]){
    const request=input({model:'nai-diffusion-4-5-full-inpainting',action:'infill',width:1536,nativeParameters:{image,mask:image,img2img:{strength,color_correct:true}}});
    const alternate={...request,nativeParameters:{image,mask:image,inpaintImg2ImgStrength:strength}};
    assert.equal(quoteNativeRequest(request).amount,official.GI(officialParameters(request),opus,request.model));
    assert.deepEqual(quoteNativeRequest(request),quoteNativeRequest(alternate));
    const differentMask={...request,nativeParameters:{...request.nativeParameters,mask:'AA=='.repeat(60)}};
    assert.equal(quoteNativeRequest(request).amount,quoteNativeRequest(differentMask).amount);
  }
  assert.throws(()=>quoteNativeRequest(input({action:'infill',nativeParameters:{image}})),/遮罩/);
  assert.throws(()=>quoteNativeRequest(input({action:'infill',nativeParameters:{image,mask:image,reference_image_multiple:[image]}})),/不能使用 Vibe/);
});

test('放大阶梯按官网原函数及输入像素，Vibe 编码固定 2 点且独立于生成尺寸限制',()=>{
  for(const [width,height] of [[1,1],[1024,1024],[1048577,1],[1747627,1],[1747628,1],[2446678,1],[2446679,1],[1536,2048]]){
    const q=quoteNativeRequest(input({operation:'upscale',model:'nai-diffusion-5-curated',width,height,operationParameters:{image}}));
    assert.equal(q.amount,official.tY(width,height,opus));assert.equal(q.resource,'anlas');
  }
  for(const [width,height] of [[512,512],[2048,2048],[4096,4096]]){
    const q=quoteNativeRequest(input({operation:'encode-vibe',width,height,operationParameters:{image,information_extracted:1}}));
    assert.equal(q.amount,2);assert.equal(q.resource,'anlas');
  }
  assert.throws(()=>quoteNativeRequest(input({operation:'upscale',model:'nai-diffusion-5-curated',width:2048,height:2048,operationParameters:{image}})),/尺寸|上限/);
  assert.throws(()=>quoteNativeRequest(input({operation:'encode-vibe',model:'nai-diffusion-5-full',operationParameters:{image}})),/Vibe 编码参数/);
});

test('无效尺寸、强度、参考数、收费上限和未支持动作在预扣前拒绝',()=>{
  for(const extra of [{width:0},{width:Infinity},{width:1.5},{height:-1},{width:2048,height:2048},{steps:51},{action:'unknown'},
    {action:'img2img',nativeParameters:{image,strength:'0.7'}},{action:'img2img',nativeParameters:{image,strength:-0.1}},
    {action:'img2img',nativeParameters:{image,strength:1.1}},{nativeParameters:{reference_image_multiple:Array(17).fill(image)}}])assert.throws(()=>quoteNativeRequest(input(extra)),error=>error.status===422);
  const expensive=input({model:'nai-diffusion-5-full',width:1536,height:2048,steps:50});
  assert.equal(official.GI(officialParameters(expensive),opus,expensive.model),-3);
  assert.throws(()=>quoteNativeRequest(expensive),/140|费用|计价/);
});

test('本站顺序多图按独立单张报价，不把官方原生批量价格混入同一个报价',()=>{
  const request=input();
  assert.equal(official.GI({...officialParameters(request),n_samples:2},opus,request.model),17);
  assert.equal(quoteNativeRequest(request).amount,0);
  assert.throws(()=>quoteNativeRequest({...request,n_samples:2}),/逐张/);
});

test('新操作经过公平账本预扣和幂等退款，成功只结算一次',()=>{
  const now=1800000000000;
  const db={settings:{},accounts:[{id:'opus',enabled:true,quotaTier:3,subscriptionActive:true,quotaFixed:10000,quotaPurchased:0,v5UsagePercent:80,v5UsageIsNegative:false,v5UsageTimeUntilNextPercent:600,quotaCheckedAt:now}]};
  configureFairQuota(db,['a','b','c','d']);syncFairQuota(db,now);
  const request=input({operation:'encode-vibe',operationParameters:{image,information_extracted:1}});
  assert.deepEqual(quoteFairRequest(request),quoteNativeRequest(request));
  const balance=db.settings.fairQuota.balances.a;
  const initial=balance.anlasFixedAvailable;
  const failed={id:'encoding-failed',request};
  const held=reserveFairQuota(db,{id:'a'},failed,db.accounts[0],now);
  assert.equal(held.amount,2);assert.equal(balance.anlasFixedAvailable,initial-2);
  settleFairQuota(db,failed,false,now+1);settleFairQuota(db,failed,false,now+2);
  assert.equal(balance.anlasFixedAvailable,initial);
  const success={id:'upscale-ok',request:input({operation:'upscale',model:'nai-diffusion-5-curated',operationParameters:{image}})};
  reserveFairQuota(db,{id:'a'},success,db.accounts[0],now+3);
  settleFairQuota(db,success,true,now+4);settleFairQuota(db,success,true,now+5);settleFairQuota(db,success,false,now+6);
  assert.equal(balance.anlasFixedAvailable,initial-1);assert.equal(db.settings.fairQuota.spent.anlas,1);
  const precise={id:'precise-ok',request:input({nativeParameters:{director_reference_images:[image]}})};
  reserveFairQuota(db,{id:'a'},precise,db.accounts[0],now+7);
  assert.equal(precise.fairCharge.amount,5);assert.equal(balance.anlasFixedAvailable,initial-6);
  settleFairQuota(db,precise,true,now+8);settleFairQuota(db,precise,true,now+9);
  assert.equal(balance.anlasFixedAvailable,initial-6);assert.equal(db.settings.fairQuota.spent.anlas,6);
});
