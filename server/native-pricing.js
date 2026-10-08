// 2026-10-07 核对官方公开前端的 50464 / 63509 模块及 Vibe / Precise 文档。
// 官方生图公式先对基础费用取整，再乘 SMEA、V5 和图生图强度，最后取整。
const A = 2.951823174884865e-6;
const B = 5.753298233447344e-7;
const MP = 1048576;
const fail = message => { throw Object.assign(new Error(message), {status:422, statusCode:422}); };
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const present = value => Array.isArray(value) ? value.length > 0 : Boolean(value);

export function quoteNativeRequest(request = {}, options = {}) {
  const p = request.nativeParameters || request.parameters || {};
  const width = Number(request.width ?? p.width), height = Number(request.height ?? p.height);
  const pixels = width * height;
  const maxPixels = request.operation === 'encode-vibe' ? 16*1024*1024 : 3145728;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels > maxPixels) fail('无法计价：图片尺寸无效或超过官方上限');
  const count = Number(request.n_samples ?? p.n_samples ?? request.n ?? 1);
  if (count !== 1) fail('多图必须逐张排队与结算');
  if (request.operation === 'encode-vibe') {
    if (!/^nai-diffusion-4(?:-5)?-(?:full|curated|curated-preview)$/.test(request.model) || !request.operationParameters?.image) fail('Vibe 编码参数不完整');
    return {resource:'anlas', amount:2, estimated:false, breakdown:{encoding:2}};
  }
  if (request.operation === 'upscale') {
    if (request.model !== 'nai-diffusion-5-curated' || !request.operationParameters?.image) fail('放大参数不完整');
    const amount = pixels <= MP ? 1 : pixels <= 1747627 ? 2 : pixels <= 2446678 ? 3 : 4;
    return {resource:'anlas', amount, estimated:false, breakdown:{upscale:amount}};
  }
  if (request.operation !== undefined) fail('该操作尚未建立公平计价规则');
  // 旧账本中保存过简写，保留重启后的历史任务兼容；原生入口仍只接受官方模型名。
  const model = request.model === 'nai-diffusion-5' ? 'nai-diffusion-5-full' : String(request.model || '');
  const v5 = /^nai-diffusion-5-full(?:-inpainting)?$/.test(model);
  const legacy = /^nai-diffusion-(?:(?:furry-)?3(?:-inpainting)?|4-(?:full|curated-preview|curated-inpainting|full-inpainting)|4-5-(?:full|curated)(?:-inpainting)?)$/.test(model);
  if (!v5 && !legacy) fail('该模型尚未建立公平计价规则');
  const steps = Number(request.steps ?? p.steps), action = request.action || 'generate';
  if (!Number.isInteger(steps) || steps < 1 || steps > 50) fail('无法计价：步数无效');
  if (!['generate','img2img','infill'].includes(action)) fail('该动作尚未建立公平计价规则');
  const refs = (plain, cached) => {
    const a=p[plain] || [], b=p[cached] || [];
    if (!Array.isArray(a) || !Array.isArray(b) || a.length && b.length) fail('参考数据格式不明确，无法计价');
    const values = a.length ? a : b.map(item => item?.data);
    if (values.length > 16 || values.some(value => typeof value !== 'string' || value.length < 100)) fail('参考数据无效，请先上传或编码');
    return values.length;
  };
  const vibes = refs('reference_image_multiple','reference_image_multiple_cached');
  const precise = refs('director_reference_images','director_reference_images_cached');
  if (present(p.reference_image)) fail('单张 Vibe 必须先归一为参考数组');
  if (v5 && (vibes || precise)) fail('V5 官方尚不支持 Vibe 或 Precise Reference');
  if (precise && (!model.startsWith('nai-diffusion-4-5-') || vibes)) fail('Precise Reference 仅支持 V4.5 且不能与 Vibe 同用');
  if (vibes && action === 'infill') fail('局部重绘不能使用 Vibe');
  let strength = 1;
  if (action !== 'generate') {
    if (!present(p.image) || action === 'infill' && !present(p.mask)) fail('图生图或局部重绘缺少底图或遮罩');
    strength = action === 'infill' ? p.img2img?.strength ?? p.inpaintImg2ImgStrength ?? 1 : p.strength;
    if (!numeric(strength) || strength < 0 || strength > 1) fail('无法计价：图生图强度无效');
  } else if (present(p.image) || present(p.mask)) fail('纯文生图不能携带底图或遮罩');
  const sm = Boolean(request.sm ?? p.sm), dyn = Boolean(request.sm_dyn ?? p.sm_dyn);
  if (action !== 'generate' && (sm || dyn)) fail('图生图不能使用 SMEA');
  const base = Math.max(2, Math.ceil(Math.ceil(A*pixels+B*pixels*steps)*(sm ? dyn ? 1.4 : 1.2 : 1)*(v5 ? 1.5 : 1)*strength));
  if (base > 140) fail('本次基础生成费用超过官方单张上限，请降低尺寸或步数');
  const vibeCost = model.startsWith('nai-diffusion-4-') ? 2*Math.max(0,vibes-4) : 0;
  const extras = vibeCost + 5*precise;
  // Opus 生成校准：标准 Opus Precise 保留基础免费，只收每个参考 5 Anlas。
  const free = pixels <= MP && steps <= 28;
  const breakdown = {generation:free ? 0 : base, vibe:vibeCost, precise:5*precise};
  if (v5 && free && options.forceAnlas !== true) return {resource:'v5', amount:(100/1730)*(pixels/MP)*(A+B*steps)/(A+B*23)*strength, estimated:true, breakdown};
  if (legacy && free && extras === 0) return {resource:'free', amount:0, estimated:false, breakdown};
  const amount = (legacy && free ? 0 : base) + extras;
  return {resource:'anlas', amount, estimated:true, breakdown:{...breakdown,generation:amount-extras}};
}
