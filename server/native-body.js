const DEFAULT_MAX_BYTES=32*1024*1024;
const fail=(statusCode,message)=>{throw Object.assign(new Error(message),{statusCode,status:statusCode});};

// 兼容 Aaalice/WOF 的官方 multipart 布局，只解析明确引用的图片分块。
export async function readNativeBody(req,{jsonReader,maxBytes=DEFAULT_MAX_BYTES}={}){
  const contentType=String(req.headers?.['content-type'] || '');
  const mediaType=contentType.split(';',1)[0].trim().toLowerCase();
  if(mediaType==='application/json'){
    if(typeof jsonReader!=='function')fail(500,'JSON 读取器尚未配置');
    return jsonReader(req);
  }
  if(mediaType!=='multipart/form-data')fail(415,'生图请求仅支持 application/json 或 multipart/form-data');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)fail(500,'请求体大小限制配置无效');
  const boundaries=[...contentType.matchAll(/;\s*boundary=(?:"([^"]*)"|([^;\s]+))/gi)];
  const boundary=boundaries[0]?.[1] ?? boundaries[0]?.[2] ?? '';
  if(boundaries.length!==1||! /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/.test(boundary)||boundary.endsWith(' '))fail(400,'multipart boundary 缺失或无效');
  const declared=Number(req.headers?.['content-length']);
  if(Number.isFinite(declared)&&declared>maxBytes)fail(413,'生图请求体超过大小限制');
  const chunks=[];let size=0;
  try{
    for await(const chunk of req){
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
      if(size>maxBytes)fail(413,'生图请求体超过大小限制');
      chunks.push(bytes);
    }
  }catch(error){if(error?.statusCode===413)throw error;fail(400,'无法读取 multipart 请求体');}
  let form;
  try{form=await new Response(Buffer.concat(chunks),{headers:{'content-type':contentType}}).formData();}
  catch{fail(400,'multipart 请求体格式错误');}
  const parts=[...form.entries()];
  if(parts.length>36)fail(422,'multipart 附件数量过多');
  const requests=parts.filter(([name])=>name==='request');
  if(requests.length>1)fail(422,'multipart 必须只有一个 request 部件');
  if(!requests.length){if(parts.length)fail(422,'multipart 包含未识别的部件');fail(400,'multipart 缺少 request 部件');}
  const value=requests[0][1];
  if(typeof value!=='string'&&value.type&&value.type.split(';',1)[0].toLowerCase()!=='application/json')fail(422,'request 部件必须是 JSON');
  let parsed;
  try{parsed=JSON.parse(typeof value==='string'?value:await value.text());}
  catch{fail(400,'request 部件不是有效 JSON');}
  if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')fail(400,'request 部件必须是 JSON 对象');
  const attachments=new Map();
  for(const [name,part] of parts){
    if(name==='request')continue;
    if(!/^(?:image|mask|reference_image|ref_multiple_\d{1,2}|director_ref_\d{1,2})$/.test(name)||attachments.has(name)||typeof part==='string')fail(422,'multipart 包含未知、重复或非文件的图片部件');
    const type=String(part.type||'').split(';',1)[0].toLowerCase();
    // 部分启动器给二进制 Vibe 编码也声明 image/png，内容由生成解析器验证。
    if(type&&!['image/png','image/jpeg','image/webp','application/octet-stream'].includes(type))fail(422,'multipart 图片部件的类型不受支持');
    if(!part.size||part.size>8*1024*1024)fail(422,'multipart 单个图片部件必须非空且不超过 8 MiB');
    attachments.set(name,{part,base64:null,used:false});
  }
  const expand=async(container,key)=>{
    if(!container||typeof container!=='object'||Array.isArray(container))return;
    const reference=container[key];
    if(typeof reference!=='string'||!attachments.has(reference))return;
    const item=attachments.get(reference);item.used=true;
    item.base64??=Buffer.from(await item.part.arrayBuffer()).toString('base64');
    container[key]=item.base64;
  };
  for(const field of ['image','mask'])await expand(parsed,field);
  const parameters=parsed.parameters;
  for(const field of ['image','mask','reference_image'])await expand(parameters,field);
  if(parameters&&typeof parameters==='object'&&!Array.isArray(parameters)){
    for(const field of ['reference_image_multiple_cached','director_reference_images_cached']){
      if(Array.isArray(parameters[field]))for(const entry of parameters[field])await expand(entry,'data');
    }
    for(const field of ['reference_image_multiple','director_reference_images']){
      if(Array.isArray(parameters[field]))for(let i=0;i<parameters[field].length;i++){
        const holder={data:parameters[field][i]};await expand(holder,'data');parameters[field][i]=holder.data;
      }
    }
  }
  if([...attachments.values()].some(item=>!item.used))fail(422,'multipart 包含 request 中未引用的图片部件');
  return parsed;
}
