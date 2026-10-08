import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readNativeBody } from './native-body.js';
const payload={input:'test prompt',model:'nai-diffusion-4-5-full',parameters:{width:1024,height:1024,steps:23}};
function stream(bytes,contentType,headers={}){const req=Readable.from([bytes.subarray(0,13),bytes.subarray(13)]);req.headers={'content-type':contentType,...headers};return req;}
async function multipart(parts){const form=new FormData();for(const [name,value] of parts)typeof value==='string'?form.append(name,value):form.append(name,value,'blob');const response=new Response(form);return {bytes:Buffer.from(await response.arrayBuffer()),contentType:response.headers.get('content-type')};}
const parse=async parts=>{const {bytes,contentType}=await multipart(parts);return readNativeBody(stream(bytes,contentType));};
test('JSON直接委托已有读取器，保留返回值、错误与流处理行为',async()=>{
 const req=stream(Buffer.from('{}'),'Application/JSON; charset=utf-8');let called=0;const marker={kept:true};assert.equal(await readNativeBody(req,{jsonReader:incoming=>{assert.equal(incoming,req);called++;return marker;},maxBytes:1}),marker);assert.equal(called,1);assert.equal(req.readableEnded,false);
 const expected=new Error('existing-reader-error');await assert.rejects(readNativeBody(req,{jsonReader:()=>{throw expected;}}),error=>error===expected);
});
test('Aaalice request JSON Blob和普通文本字段都能解析',async()=>{
 assert.deepEqual(await parse([['request',new Blob([JSON.stringify(payload)],{type:'application/json'})]]),payload);
 assert.deepEqual(await parse([['request',JSON.stringify(payload)]]),payload);
});
test('拒重复request和未引用附图，不在错误消息包含请求内容',async()=>{
 for(const parts of [[['request','{}'],['request','{}']],[['request','{}'],['image',new Blob(['secret-token-body'],{type:'image/png'})]],[['unknown','secret-token-body']],[['request',new Blob(['secret-token-body'],{type:'image/png'})]]])await assert.rejects(parse(parts),error=>error.statusCode===422&&!error.message.includes('secret-token-body'));
});

test('Aaalice 官方 multipart 按 JSON 引用解析底图、遮罩和缓存参考，不凭文件名覆盖字段',async()=>{
 const bytes=Buffer.from('synthetic-binary-payload');const expected=bytes.toString('base64');
 const body={...payload,action:'infill',parameters:{...payload.parameters,image:'image',mask:'mask',director_reference_images_cached:[{cache_secret_key:'synthetic-cache',data:'director_ref_0'}]}};
 const parsed=await parse([['image',new Blob([bytes],{type:'image/png'})],['mask',new Blob([bytes],{type:'image/png'})],['director_ref_0',new Blob([bytes],{type:'image/png'})],['request',new Blob([JSON.stringify(body)],{type:'application/json'})]]);
 assert.equal(parsed.parameters.image,expected);assert.equal(parsed.parameters.mask,expected);assert.equal(parsed.parameters.director_reference_images_cached[0].data,expected);assert.equal(parsed.parameters.director_reference_images_cached[0].cache_secret_key,'synthetic-cache');
 const shared={...payload,parameters:{...payload.parameters,reference_image_multiple_cached:[{cache_secret_key:'cache-a',data:'ref_multiple_0'},{cache_secret_key:'cache-b',data:'ref_multiple_0'}]}};
 const reused=await parse([['request',JSON.stringify(shared)],['ref_multiple_0',new Blob([bytes],{type:'image/png'})]]);assert.deepEqual(reused.parameters.reference_image_multiple_cached.map(value=>value.data),[expected,expected]);
});

test('encode-vibe 和放大接受顶层 image 分块，未知、重复、文本附件均拒绝',async()=>{
 const bytes=Buffer.from('synthetic-binary-payload');
 assert.deepEqual(await parse([['request',JSON.stringify({model:'nai-diffusion-4-5-full',image:'image',information_extracted:1})],['image',new Blob([bytes],{type:'image/png'})]]),{model:'nai-diffusion-4-5-full',image:bytes.toString('base64'),information_extracted:1});
 for(const parts of [
  [['request','{"image":"image"}'],['image','secret-image']],
  [['request','{"image":"image"}'],['image',new Blob([bytes])],['image',new Blob([bytes])]],
  [['request','{"image":"unknown"}'],['unknown',new Blob([bytes])]],
  [['request','{"image":"image"}'],['image',new Blob([bytes],{type:'text/html'})]],
  [['request','{"image":"image"}'],['image',new Blob([])]],
 ])await assert.rejects(parse(parts),error=>error.statusCode===422&&!error.message.includes('secret-image'));
});

test('multipart 默认允许超过旧 2 MiB 的图片请求，仍限制单附件 8 MiB',async()=>{
 const bytes=Buffer.alloc(2*1024*1024+1,42);const result=await parse([['request','{"image":"image"}'],['image',new Blob([bytes],{type:'image/png'})]]);assert.equal(Buffer.from(result.image,'base64').length,bytes.length);
 await assert.rejects(parse([['request','{"image":"image"}'],['image',new Blob([Buffer.alloc(8*1024*1024+1)],{type:'image/png'})]]),error=>error.statusCode===422);
});
test('缺失boundary、损坏multipart、非法JSON或非对象均返回400',async()=>{
 for(const type of ['multipart/form-data','multipart/form-data; boundary=','multipart/form-data; boundary=a; boundary=b','multipart/form-data; boundary="bad@boundary"'])await assert.rejects(readNativeBody(stream(Buffer.from('secret'),' '+type)),error=>error.statusCode===400);
 await assert.rejects(readNativeBody(stream(Buffer.from('secret'),'multipart/form-data; boundary=test')),error=>error.statusCode===400&&!error.message.includes('secret'));
 for(const value of ['secret-token-invalid','null','[]','"a"'])await assert.rejects(parse([['request',value]]),error=>error.statusCode===400&&!error.message.includes(value));
 await assert.rejects(parse([]),error=>error.statusCode===400);
});
test('按实际流字节限制请求大小，Content-Length提前拒绝，边界大小可接受',async()=>{
 const {bytes,contentType}=await multipart([['request',JSON.stringify(payload)]]);
 await assert.rejects(readNativeBody(stream(bytes,contentType),{maxBytes:bytes.length-1}),error=>error.statusCode===413);
 assert.deepEqual(await readNativeBody(stream(bytes,contentType),{maxBytes:bytes.length}),payload);
 const req=stream(bytes,contentType,{'content-length':String(bytes.length+1)});await assert.rejects(readNativeBody(req,{maxBytes:bytes.length}),error=>error.statusCode===413);assert.equal(req.readableEnded,false);
});
test('不支持的Content-Type不消费流；支持带引号boundary',async()=>{
 const req=stream(Buffer.from('secret'),'application/octet-stream');await assert.rejects(readNativeBody(req),error=>error.statusCode===415);assert.equal(req.readableEnded,false);
 const boundary='quoted-boundary';const bytes=Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="request"\r\n\r\n{}\r\n--'+boundary+'--\r\n');assert.deepEqual(await readNativeBody(stream(bytes,'multipart/form-data; boundary="'+boundary+'"')),{});
});
