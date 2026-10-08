import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { parseNativeImageRequest, parseNativeAuxiliaryRequest, validateNativeImage } from './native-image.js';

function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } return (crc^0xffffffff)>>>0; }
function chunk(type, data) { const header=Buffer.alloc(8), tail=Buffer.alloc(4);header.writeUInt32BE(data.length);header.write(type,4);tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type),data])));return Buffer.concat([header,data,tail]); }
function png(width=128,height=128,{pixels,filter=0}={}) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const rows=pixels??Buffer.alloc((width*4+1)*height);if(filter)for(let i=0;i<height;i++)rows[i*(width*4+1)]=filter;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const image=png().toString('base64');
const reference=png(1024,1536).toString('base64');
const encoding=Buffer.alloc(256,42).toString('base64');
const model='nai-diffusion-4-5-full';
function request(parameters={},extra={}) {return {input:'test prompt',model,action:'generate',parameters:{width:128,height:128,steps:23,seed:123,...parameters},...extra};}
const rejects=(body,message)=>assert.throws(()=>parseNativeImageRequest(body),error=>error.statusCode===422&&(!message||error.message.includes(message)));
const caption={caption:{base_caption:'character',char_captions:[]},legacy_uc:false};
const precise=()=>({director_reference_images:[reference],director_reference_descriptions:[caption],director_reference_information_extracted:[1],director_reference_strength_values:[1],director_reference_secondary_strength_values:[0]});

test('原生单图兼容原 contract，不改变调用者对象，种子保持原归一化语义',()=>{
 const body=request({stream:'msgpack',seed:4294967301,characterPrompts:[],controlnet_model:null});const snapshot=structuredClone(body);const result=parseNativeImageRequest(body);
 assert.equal(result.action,'generate');assert.equal(result.sampleCount,1);assert.equal(result.seed,5);assert.equal(result.nativeParameters.seed,5);assert.equal(result.nativeParameters.stream,undefined);assert.equal(result.nativeParameters.controlnet_model,undefined);assert.deepEqual(body,snapshot);
 for(const seed of [-1,undefined])assert.ok(Number.isInteger(parseNativeImageRequest(request({seed})).seed));
});
test('V3、V4、V4.5、V5 模型和最多四张输入均正确保留',()=>{
 for(const current of ['nai-diffusion-3','nai-diffusion-furry-3','nai-diffusion-4-curated-preview','nai-diffusion-4-full','nai-diffusion-4-5-full','nai-diffusion-4-5-curated','nai-diffusion-5-full']){
  const result=parseNativeImageRequest(request({n_samples:4},{model:current}));assert.equal(result.model,current);assert.equal(result.sampleCount,4);assert.equal(result.nativeParameters.n_samples,4);
 }
 for(const n_samples of [0,5,1.2,'2'])rejects(request({n_samples}));
 rejects(request({}, {model:'nai-diffusion-5-curated'}));
 rejects(request({width:2048,height:2048}),'像素');
});
test('非法参数不能透传未知计费功能，数值和类型边界在入队前拒绝',()=>{
 for(const parameters of [{upscale:{}},{upscaled_enhance:true},{some_new_paid_feature:true},{image:'https://example.invalid/secret'},{scale:NaN},{scale:Infinity},{scale:'5'},{cfg_rescale:1.1},{steps:0},{seed:-2},{sm:true},{sm:'false'},{noise_schedule:'invalid'},{sampler:'invalid'},{v4_prompt:{caption:{base_caption:'x',char_captions:[{char_caption:'x',centers:[{x:NaN,y:0}]}]}}}])rejects(request(parameters));
 rejects(request({}, {cost:0}));
 rejects(request({sm_dyn:true},{model:'nai-diffusion-3'}));
 assert.equal(parseNativeImageRequest(request({sm:true,sm_dyn:true},{model:'nai-diffusion-3'})).nativeParameters.sm_dyn,true);
 rejects(request({autoSmea:true},{model:'nai-diffusion-3'}),'明确选择');
});
test('旧官网 V4 模板和客户端关闭值兼容，活跃未知 LoRA 仍拒绝',()=>{
 const common={uncond_scale:0.00001,skip_cfg_below_sigma:0,lora_unet_weights:null,lora_clip_weights:null,dynamic_thresholding_percentile:0.999,dynamic_thresholding_mimic_scale:10,cfg_sched_eligibility:'enable_for_post_summer_samplers',explike_fine_detail:false,minimize_sigma_inf:false,uncond_per_vibe:true,wonky_vibe_correlation:true,version:1,strength:0.7,noise:0.1,inpaintImg2ImgStrength:1};
 const result=parseNativeImageRequest(request(common));assert.equal(result.nativeParameters.uncond_scale,0.00001);assert.equal(result.nativeParameters.dynamic_thresholding_percentile,0.999);assert.equal(result.nativeParameters.uncond_per_vibe,true);
 for(const field of ['lora_unet_weights','lora_clip_weights','strength','noise','inpaintImg2ImgStrength'])assert.equal(result.nativeParameters[field],undefined);
 for(const value of [null,[],{},false,''])assert.equal(parseNativeImageRequest(request({lora_unet_weights:value,lora_clip_weights:value})).action,'generate');
 for(const parameters of [{lora_unet_weights:{custom:0.5}},{lora_clip_weights:[1]},{uncond_scale:NaN},{dynamic_thresholding_percentile:1.1},{skip_cfg_below_sigma:-1},{explike_fine_detail:'false'},{cfg_sched_eligibility:{unexpected:true}},{strength:1.1}])rejects(request(parameters));
 assert.equal(parseNativeImageRequest(request({uncond_scale:null,version:null,explike_fine_detail:null})).action,'generate');
});
test('图片 base64、MIME、文件签名、CRC、像素解压与尺寸独立验证',()=>{
 assert.deepEqual(validateNativeImage(image),{width:128,height:128,mimeType:'image/png',base64:image,byteLength:Buffer.from(image,'base64').length});
 assert.equal(validateNativeImage('data:image/png;base64,'+image).base64,image);
 assert.equal(validateNativeImage(image.replace(/=+$/,'' )).base64,image);
 const corrupted=png();corrupted[corrupted.length-1]^=1;
 const cases=['secret-token-text','https://example.invalid/x.png','data:image/jpeg;base64,'+image,image+'\n',Buffer.from('<svg/>').toString('base64'),corrupted.toString('base64'),png(128,128,{pixels:Buffer.alloc(10)}).toString('base64'),png(128,128,{filter:5}).toString('base64'),png(1,1,{pixels:Buffer.alloc(1024)}).toString('base64'),png().subarray(0,40).toString('base64')];
 for(const value of cases)assert.throws(()=>validateNativeImage(value),error=>error.statusCode===422&&!error.message.includes('secret-token-text'));
 const huge=png(1,1);huge.writeUInt32BE(9000,16);huge.writeUInt32BE(crc32(huge.subarray(12,29)),29);assert.throws(()=>validateNativeImage(huge.toString('base64')),error=>error.statusCode===422);
});
test('JPEG 和 WebP 按实际格式结构读取尺寸并拒绝截断与动画',()=>{
 // 固定 JPEG 标记样本仅测试结构检查；像素内容由上游解码器最终验证。
 const jpeg=Buffer.from('ffd8ffc0000b080080008001011100ffda0008010100003f0000ffd9','hex');
 assert.equal(validateNativeImage(jpeg.toString('base64')).width,128);
 const vp8=Buffer.from([0,0,0,0x9d,0x01,0x2a,128,0,128,0,0,0]);const header=Buffer.alloc(20);header.write('RIFF');header.writeUInt32LE(12+vp8.length,4);header.write('WEBPVP8 ',8);header.writeUInt32LE(vp8.length,16);const webp=Buffer.concat([header,vp8]);
 assert.equal(validateNativeImage(webp.toString('base64')).height,128);
 for(const bytes of [jpeg.subarray(0,jpeg.length-1),webp.subarray(0,webp.length-1)])assert.throws(()=>validateNativeImage(bytes.toString('base64')),error=>error.statusCode===422);
});
test('图生图使用实际图像尺寸，检查强度、噪声并拒绝遮罩和 SMEA',()=>{
 const body=request({image,strength:0.7,noise:0.1},{action:'img2img'});const result=parseNativeImageRequest(body);assert.equal(result.action,'img2img');assert.equal(result.nativeParameters.image,image);
 for(const parameters of [{image,width:256},{image,strength:1.1},{image,noise:-0.1},{image,mask:image},{image,sm:true},{}])rejects(request(parameters,{action:'img2img'}));
 rejects(request({image}),'请选择');
});
test('局部重绘匹配底图和 PNG 遮罩，映射模型并保留实际强度',()=>{
 const parsed=parseNativeImageRequest(request({image,mask:image,img2img:{strength:0.5,color_correct:true}},{action:'infill'}));
 // 真实上游对基础 V4.5 + infill 返回 400、不扣费；以实测要求的重绘模型为准。
 assert.equal(parsed.model,'nai-diffusion-4-5-full-inpainting');assert.equal(parsed.baseModel,model);assert.equal(parsed.nativeParameters.img2img.strength,0.5);assert.equal(parsed.nativeParameters.strength,1);
 const shorthand=parseNativeImageRequest(request({image,mask:image,inpaintImg2ImgStrength:0.25},{action:'infill'}));assert.equal(shorthand.nativeParameters.img2img.strength,0.25);assert.equal(shorthand.nativeParameters.inpaintImg2ImgStrength,undefined);
 for(const [current,expected] of [['nai-diffusion-3','nai-diffusion-3-inpainting'],['nai-diffusion-4-curated-preview','nai-diffusion-4-curated-inpainting'],['nai-diffusion-5-full','nai-diffusion-5-full-inpainting'],['nai-diffusion-4-curated-inpainting','nai-diffusion-4-curated-inpainting'],['nai-diffusion-4-5-full-inpainting','nai-diffusion-4-5-full-inpainting']])assert.equal(parseNativeImageRequest(request({image,mask:image},{action:'infill',model:current})).model,expected);
 for(const parameters of [{image},{image,mask:png(64,64).toString('base64')},{image,mask:image,img2img:{strength:2}},{image,mask:image,img2img:{strength:0.5,unknown:true}},{image,mask:image,inpaintImg2ImgStrength:0.5,img2img:{strength:0.7}}])rejects(request(parameters,{action:'infill'}));
 rejects(request({image,mask:image,img2img:{strength:0.5}},{action:'infill',model:'nai-diffusion-3'}));
 rejects(request({}, {model:'nai-diffusion-3-inpainting'}));
});
test('V3 Vibe 使用原图；V4/V4.5 要求已编码数据并防止借缓存漏计费',()=>{
 const v3=parseNativeImageRequest(request({reference_image:image,reference_strength:0.6},{model:'nai-diffusion-3'}));assert.deepEqual(v3.nativeParameters.reference_image_multiple,[image]);assert.deepEqual(v3.nativeParameters.reference_information_extracted_multiple,[1]);
 const cached=parseNativeImageRequest(request({reference_image_multiple_cached:[{cache_secret_key:'client-cache-id',data:encoding}],reference_strength_multiple:[0.5]}));assert.deepEqual(cached.nativeParameters.reference_image_multiple,[encoding]);assert.equal(cached.nativeParameters.reference_image_multiple_cached,undefined);
 for(const parameters of [{reference_image_multiple:[image],reference_strength_multiple:[1]},{reference_image_multiple_cached:[{cache_secret_key:'opaque-key'}],reference_strength_multiple:[1]},{reference_image_multiple:[encoding],reference_strength_multiple:[]},{reference_image_multiple:Array(17).fill(encoding),reference_strength_multiple:Array(17).fill(1)},{reference_strength_multiple:[1]}])rejects(request(parameters));
 rejects(request({reference_image_multiple:[encoding],reference_strength_multiple:[1]},{model:'nai-diffusion-5-full'}),'V5');
 rejects(request({image,mask:image,reference_image_multiple:[encoding],reference_strength_multiple:[1]},{action:'infill'}),'局部重绘');
});
test('Precise Reference 只允许官方 V4.5 尺寸，数量相符且不能混用 Vibe',()=>{
 const valid=parseNativeImageRequest(request(precise()));assert.equal(valid.nativeParameters.director_reference_images.length,1);
 assert.equal(parseNativeImageRequest(request({...precise(),image,mask:image},{action:'infill'})).action,'infill');
 rejects(request(precise(),{model:'nai-diffusion-4-full'}),'V4.5');
 rejects(request({...precise(),reference_image_multiple:[encoding],reference_strength_multiple:[1]}),'同时');
 rejects(request({...precise(),director_reference_images:[image]}),'官方尺寸');
 rejects(request({...precise(),director_reference_strength_values:[]}),'数量');
 rejects(request({...precise(),director_reference_descriptions:[{caption:{base_caption:'character',char_captions:[{}]}}]}));
});
test('encode-vibe 预处理只接受 V4/V4.5 和有效图片，保留实际尺寸',()=>{
 const parsed=parseNativeAuxiliaryRequest({image,model,information_extracted:0.8},'encode-vibe');assert.equal(parsed.operation,'encode-vibe');assert.equal(parsed.width,128);assert.equal(parsed.steps,1);assert.equal(parsed.operationParameters.information_extracted,0.8);
 for(const body of [{image,model:'nai-diffusion-5-full'},{image,model,information_extracted:1.1},{image,model,cost:0}])assert.throws(()=>parseNativeAuxiliaryRequest(body,'encode-vibe'),error=>error.statusCode===422);
});
test('购买点数开关只作为网关授权，普通生成及辅助接口均不向上游透传',()=>{
 for(const allowPurchasedAnlas of [true,false]){
  const body=request({}, {allowPurchasedAnlas});const parsed=parseNativeImageRequest(body);assert.equal(parsed.nativeParameters.allowPurchasedAnlas,undefined);assert.equal(body.allowPurchasedAnlas,allowPurchasedAnlas);
  for(const operation of ['encode-vibe','upscale']){const auxiliary=parseNativeAuxiliaryRequest({image,model:operation==='encode-vibe'?model:'nai-diffusion-5-curated',allowPurchasedAnlas},operation);assert.equal(auxiliary.operationParameters.allowPurchasedAnlas,undefined);}
 }
 for(const allowPurchasedAnlas of ['true',1,null]){
  rejects(request({}, {allowPurchasedAnlas}),'布尔值');
  assert.throws(()=>parseNativeAuxiliaryRequest({image,model,allowPurchasedAnlas},'encode-vibe'),error=>error.statusCode===422);
 }
 assert.throws(()=>parseNativeAuxiliaryRequest({image,model,mask:image},'encode-vibe'),error=>error.statusCode===422&&error.message.includes('暂不支持 mask'));
});
test('新版与旧版放大均归一为官网 2 倍接口，按实际像素拒绝谎报尺寸',()=>{
 const modern=parseNativeAuxiliaryRequest({image,model:'nai-diffusion-5-curated',declared_blur_sigma:0},'upscale');
 const legacy=parseNativeAuxiliaryRequest({image,width:128,height:128,scale:2},'upscale');assert.deepEqual(modern.operationParameters,legacy.operationParameters);assert.equal(legacy.width,128);
 for(const body of [{image,width:256,height:128,scale:2},{image,scale:4},{image,declared_blur_sigma:0.5},{image,model:'unknown'}])assert.throws(()=>parseNativeAuxiliaryRequest(body,'upscale'),error=>error.statusCode===422);
});
