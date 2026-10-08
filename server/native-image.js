import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export const NATIVE_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode, status: statusCode }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const active = value => value !== undefined && value !== null && value !== '' && value !== false && (!Array.isArray(value) || value.length > 0);
const BASE_MODELS = new Set(['nai-diffusion-3', 'nai-diffusion-furry-3', 'nai-diffusion-4-curated-preview', 'nai-diffusion-4-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-5-full']);
const INPAINT_MODELS = new Map([...BASE_MODELS].map(model => [`${model.replace('-curated-preview', '-curated')}-inpainting`, model]));
const PARAMETERS = new Set(`width height steps n_samples scale cfg_rescale sampler noise_schedule seed negative_prompt uc params_version ucPreset qualityToggle ucPresetId qualityPresetId dynamic_thresholding dynamic_thresholding_percentile dynamic_thresholding_mimic_scale uncond_scale controlnet_strength legacy legacy_uc legacy_v3_extend add_original_image autoSmea sm sm_dyn skip_cfg_above_sigma skip_cfg_below_sigma deliberate_euler_ancestral_bug prefer_brownian cfg_sched_eligibility explike_fine_detail minimize_sigma_inf uncond_per_vibe wonky_vibe_correlation image_format stream use_coords characterPrompts v4_prompt v4_negative_prompt normalize_reference_strength_multiple reference_image reference_strength reference_information_extracted reference_image_multiple reference_image_multiple_cached reference_strength_multiple reference_information_extracted_multiple director_reference_images director_reference_images_cached director_reference_descriptions director_reference_information_extracted director_reference_strength_values director_reference_secondary_strength_values image mask image_cache_secret_key mask_cache_secret_key reference_image_cache_secret_key strength noise extra_noise_seed color_correct img2img inpaintImg2ImgStrength straight_alpha tag_hint_transparent_background tag_hint_qt tag_hint_uc_preset version`.split(' '));
const BOOLEAN_PARAMETERS = `qualityToggle dynamic_thresholding legacy legacy_uc legacy_v3_extend add_original_image autoSmea sm sm_dyn deliberate_euler_ancestral_bug prefer_brownian use_coords normalize_reference_strength_multiple color_correct straight_alpha tag_hint_transparent_background explike_fine_detail minimize_sigma_inf uncond_per_vibe wonky_vibe_correlation`.split(' ');

function number(value, min, max, field, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(422, `${field} 必须是 ${min} 到 ${max} 之间的${integer ? '整数' : '数值'}。`);
  return value;
}
function checkKeys(value, allowed, message) {
  if (Object.keys(value).some(key => !allowed.has(key))) fail(422, message);
}
function imageDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_IMAGE_PIXELS) fail(422, '图片尺寸过大或无效；最多 8192 像素边长、1600 万像素。');
  return { width, height };
}

// 严格验证编码，不接受 URL、空白、截断或混入控制字符的字符串。
function decodeBase64(value, label, { maxBytes = MAX_IMAGE_BYTES, dataUrl = true } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 + 64) fail(422, `${label} 必须是有效且不超过大小限制的 base64 数据。`);
  let encoded = value;
  let mimeType = null;
  if (value.startsWith('data:')) {
    const match = dataUrl && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(value);
    if (!match) fail(422, `${label} 只接受 PNG、JPEG、WebP 的 base64 图片。`);
    [, mimeType, encoded] = match;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1 || (encoded.includes('=') && encoded.length % 4 !== 0)) fail(422, `${label} 的 base64 编码无效。`);
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) fail(422, `${label} 的 base64 编码或大小无效。`);
  return { bytes, mimeType, base64: bytes.toString('base64') };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0; }

function pngDimensions(bytes) {
  let offset = 8, dimensions, depth, channels, interlace, ended = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail(422, 'PNG 图片损坏或被截断。');
    if (!dimensions && type !== 'IHDR') fail(422, 'PNG 缺少图像头。');
    if (type === 'IHDR') {
      if (dimensions || length !== 13) fail(422, 'PNG 图像头无效。');
      dimensions = imageDimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
      depth = bytes[offset + 16]; const color = bytes[offset + 17];
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      interlace = bytes[offset + 20];
      if (!channels || !depths[color].includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || interlace > 1) fail(422, 'PNG 图片格式无效。');
    } else if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    else if (type === 'acTL') fail(422, '不支持动画图片，请导出静态 PNG。');
    else if (type === 'IEND') { if (length !== 0) fail(422, 'PNG 结束标记无效。'); ended = true; offset += 12; break; }
    offset += length + 12;
  }
  if (!ended || offset !== bytes.length || !compressed.length) fail(422, 'PNG 图片缺少完整像素数据。');
  // 限制实际解压尺寸，避免伪造小图像头的压缩炸弹；同时验证每条扫描线。
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows = passes.map(([x,y,dx,dy]) => ({ width: Math.max(0, Math.ceil((dimensions.width-x)/dx)), height: Math.max(0, Math.ceil((dimensions.height-y)/dy)) })).filter(p => p.width && p.height).map(p => ({ size: Math.ceil(p.width * channels * depth / 8) + 1, count: p.height }));
  const expected = rows.reduce((sum, row) => sum + row.size * row.count, 0);
  if (expected > 64 * 1024 * 1024 + 8192) fail(422, 'PNG 解压后的像素数据过大，请降低分辨率或导出 8 位图片。');
  let pixels;
  try { pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }); } catch { fail(422, 'PNG 像素数据无法解压或超过图像声明尺寸。'); }
  if (pixels.length !== expected) fail(422, 'PNG 实际像素数据与尺寸不匹配。');
  offset = 0;
  for (const row of rows) for (let i = 0; i < row.count; i++) { if (pixels[offset] > 4) fail(422, 'PNG 像素过滤器无效。'); offset += row.size; }
  return dimensions;
}

function jpegDimensions(bytes) {
  if (bytes.length < 12 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) fail(422, 'JPEG 图片损坏或被截断。');
  let offset = 2, dimensions;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) fail(422, 'JPEG 标记无效。');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) { if (!dimensions) break; return dimensions; }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || dimensions) break;
      dimensions = imageDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      if (bytes[offset + 2] !== 8 || ![1, 3, 4].includes(bytes[offset + 7]) || length !== 8 + 3 * bytes[offset + 7]) break;
    }
    offset += length;
  }
  fail(422, 'JPEG 缺少有效图像尺寸或扫描数据。');
}

function webpDimensions(bytes) {
  if (bytes.length < 30 || bytes.readUInt32LE(4) + 8 !== bytes.length) fail(422, 'WebP 图片损坏或被截断。');
  let offset = 12, dimensions, foundPixels = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), data = offset + 8;
    if (data + size > bytes.length) fail(422, 'WebP 图片数据损坏。');
    let actual;
    if (type === 'VP8X') {
      if (size !== 10 || (bytes[data] & 2)) fail(422, '不支持动画 WebP 图片。');
      dimensions = imageDimensions(bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1);
    } else if (type === 'VP8 ') {
      if (size < 10 || (bytes[data] & 1) || bytes.toString('hex', data + 3, data + 6) !== '9d012a') fail(422, 'WebP 图像头无效。');
      actual = imageDimensions(bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff);
    } else if (type === 'VP8L') {
      if (size < 5 || bytes[data] !== 0x2f || bytes[data + 4] >> 5) fail(422, 'WebP 图像头无效。');
      const bits = bytes.readUInt32LE(data + 1);
      actual = imageDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else if (type === 'ANIM' || type === 'ANMF') fail(422, '不支持动画图片。');
    if (actual) {
      if (foundPixels || (dimensions && (dimensions.width !== actual.width || dimensions.height !== actual.height))) fail(422, 'WebP 图像尺寸不一致。');
      dimensions = actual; foundPixels = true;
    }
    offset = data + size + (size % 2);
  }
  if (!foundPixels || offset !== bytes.length) fail(422, 'WebP 缺少有效像素数据。');
  return dimensions;
}

export function validateNativeImage(value, label = 'image') {
  const decoded = decodeBase64(value, label);
  const { bytes } = decoded;
  let actualType, dimensions;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) { actualType = 'image/png'; dimensions = pngDimensions(bytes); }
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) { actualType = 'image/jpeg'; dimensions = jpegDimensions(bytes); }
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') { actualType = 'image/webp'; dimensions = webpDimensions(bytes); }
  else fail(422, `${label} 不是可识别的 PNG、JPEG 或 WebP 图片。`);
  if (decoded.mimeType && decoded.mimeType !== actualType) fail(422, `${label} 的 MIME 类型与图片内容不一致。`);
  return { ...dimensions, mimeType: actualType, base64: decoded.base64, byteLength: bytes.length };
}

function validateCaption(value, label, maxCharacters = 24, inheritedUseCoords) {
  if (!object(value) || !object(value.caption) || typeof value.caption.base_caption !== 'string' || !Array.isArray(value.caption.char_captions) || value.caption.char_captions.length > maxCharacters) fail(422, `${label} 提示词结构无效。`);
  checkKeys(value, new Set(['caption', 'use_coords', 'use_order', 'legacy_uc']), `${label} 含不支持的字段。`);
  checkKeys(value.caption, new Set(['base_caption', 'char_captions']), `${label} caption 含不支持的字段。`);
  if (value.caption.base_caption.length > 50000) fail(422, '提示词过长。');
  for (const key of ['use_coords', 'use_order', 'legacy_uc']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(422, `${label} 标志必须是布尔值。`);
  const useCoords = value.use_coords ?? inheritedUseCoords;
  for (const character of value.caption.char_captions) {
    if (!object(character) || typeof character.char_caption !== 'string' || character.char_caption.length > 10000 || !Array.isArray(character.centers) || character.centers.length > 16) fail(422, `${label} 角色提示词无效。`);
    checkKeys(character, new Set(['char_caption', 'centers']), `${label} 角色字段无效。`);
    for (const center of character.centers) {
      if (!object(center)) fail(422, '角色坐标无效。');
      checkKeys(center, new Set(['x','y']), '角色坐标字段无效。');
      // 自动布局客户端会提交 centers:[{}]；仅补齐未指定的分量，不修改布局开关或已填坐标。
      if (useCoords === false) { center.x ??= 0.5; center.y ??= 0.5; }
      number(center.x, 0, 1, '角色 x'); number(center.y, 0, 1, '角色 y');
    }
  }
}
function numericList(parameters, field, count, min, max, fallback) {
  if (parameters[field] === undefined && fallback !== undefined) parameters[field] = Array(count).fill(fallback);
  const values = parameters[field];
  if (!Array.isArray(values) || values.length !== count) fail(422, `${field} 数量必须与参考图数量一致。`);
  values.forEach(value => number(value, min, max, field));
}
function references(parameters, direct, cached, { image, count = 16 }) {
  if (active(parameters[direct]) && active(parameters[cached])) fail(422, '相同参考图不能同时使用普通字段和缓存字段。');
  const key = active(parameters[cached]) ? cached : direct;
  const values = parameters[key] ?? [];
  if (!Array.isArray(values) || values.length > count) fail(422, '参考图列表无效或数量过多。');
  const list = values.map(value => {
    if (key === cached) {
      if (!object(value)) fail(422, '参考图缓存字段必须同时包含数据。');
      checkKeys(value, new Set(['cache_secret_key', 'data']), '参考图缓存字段无效。');
      // 不信任客户端对上游缓存的声明；每次都携带数据，计费按实际数量计算。
      value = value.data;
    }
    if (image) return validateNativeImage(value, '参考图').base64;
    const encoded = decodeBase64(value, 'Vibe 编码', { maxBytes: 2 * 1024 * 1024, dataUrl: false });
    const bytes = encoded.bytes;
    if (bytes.length < 100 || bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes[0] === 0xff && bytes[1] === 0xd8 || bytes.toString('ascii', 0, 4) === 'RIFF' || bytes.toString('ascii', 0, 3) === 'GIF') fail(422, 'V4/V4.5 Vibe 需要预先编码的数据；原图请先调用 encode-vibe。');
    return encoded.base64;
  });
  if (values.length || Object.hasOwn(parameters, direct) || Object.hasOwn(parameters, cached)) parameters[direct] = list;
  delete parameters[cached];
  return list.length;
}

export function parseNativeImageRequest(body) {
  if (!object(body)) fail(400, 'Expected a JSON object.');
  checkKeys(body, new Set(['input', 'model', 'action', 'parameters', 'use_new_shared_trial', 'allowPurchasedAnlas']), '请求含尚未支持的顶层字段。');
  if (body.allowPurchasedAnlas !== undefined && typeof body.allowPurchasedAnlas !== 'boolean') fail(422, 'allowPurchasedAnlas 必须是布尔值。');
  const action = body.action ?? 'generate';
  if (!['generate', 'img2img', 'infill'].includes(action)) fail(422, '不支持此生图操作；可使用 generate、img2img 或 infill。');
  const baseModel = INPAINT_MODELS.get(body.model) ?? body.model;
  if (!BASE_MODELS.has(baseModel)) fail(422, 'Unsupported NovelAI model.');
  if (INPAINT_MODELS.has(body.model) && action !== 'infill') fail(422, '局部重绘模型必须配合 action=infill 使用。');
  // 2026-10-07 真实上游校准：基础 V4.5 模型拒绝 infill；必须使用重绘模型名。
  const model = action === 'infill' ? [...INPAINT_MODELS].find(([, base]) => base === baseModel)[0] : baseModel;
  if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 50000) fail(400, 'input must be a non-empty prompt string (max 50000 characters).');
  if (!object(body.parameters)) fail(400, 'parameters must be an object.');
  const parameters = structuredClone(body.parameters);
  for (const field of ['controlnet_model', 'controlnet_condition', 'characterRef', 'upscale', 'upscaled_enhance']) if (Object.hasOwn(parameters, field) && !active(parameters[field])) delete parameters[field];
  // 旧官网参数模板会附带关闭的 LoRA 字段；空值可以忽略，启用权重仍须明确拒绝。
  for (const field of ['lora_unet_weights', 'lora_clip_weights']) if (Object.hasOwn(parameters, field) && (!active(parameters[field]) || object(parameters[field]) && Object.keys(parameters[field]).length === 0)) delete parameters[field];
  for (const field of [...BOOLEAN_PARAMETERS, 'uncond_scale', 'dynamic_thresholding_percentile', 'dynamic_thresholding_mimic_scale', 'cfg_sched_eligibility', 'version']) if (parameters[field] === null) delete parameters[field];
  // 未适配的付费功能不透传，防止通过新字段绕过成本预估。
  checkKeys(parameters, PARAMETERS, '包含尚未支持的生成参数；请关闭 ControlNet、自动放大或其他未支持的扩展。');
  const width = number(parameters.width, 128, 2048, 'width', true), height = number(parameters.height, 128, 2048, 'height', true);
  if (width * height > 3145728) fail(422, '生成尺寸不能超过官方 3145728 像素上限。');
  const steps = number(parameters.steps, 1, 50, 'steps', true);
  const sampleCount = number(parameters.n_samples ?? 1, 1, 4, 'n_samples', true);
  parameters.n_samples = sampleCount;
  parameters.scale = number(parameters.scale ?? 5, 0, 10, 'scale');
  parameters.cfg_rescale = number(parameters.cfg_rescale ?? 0, 0, 1, 'cfg_rescale');
  for (const field of BOOLEAN_PARAMETERS) if (parameters[field] !== undefined && typeof parameters[field] !== 'boolean') fail(422, `${field} 必须是布尔值。`);
  for (const field of ['negative_prompt', 'uc']) if (parameters[field] !== undefined && (typeof parameters[field] !== 'string' || parameters[field].length > 50000)) fail(422, '负面提示词必须是字符串且不超过 50000 字符。');
  if (parameters.negative_prompt === undefined && typeof parameters.uc === 'string') parameters.negative_prompt = parameters.uc;
  if (parameters.seed !== undefined && (!Number.isSafeInteger(parameters.seed) || parameters.seed < -1)) fail(422, 'seed must be a safe non-negative integer or -1 for random.');
  parameters.seed = parameters.seed === undefined || parameters.seed === -1 ? randomBytes(4).readUInt32LE(0) : parameters.seed % 4294967296;
  if (parameters.extra_noise_seed !== undefined) number(parameters.extra_noise_seed, -1, 4294967295, 'extra_noise_seed', true);
  for (const field of ['params_version', 'ucPreset', 'tag_hint_qt', 'tag_hint_uc_preset', 'version']) if (parameters[field] !== undefined) number(parameters[field], 0, 20, field, true);
  for (const field of ['ucPresetId', 'qualityPresetId']) if (parameters[field] !== undefined && (typeof parameters[field] !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(parameters[field]))) fail(422, '提示词预设标识无效。');
  for (const field of ['skip_cfg_above_sigma', 'skip_cfg_below_sigma']) if (parameters[field] != null) number(parameters[field], 0, 1000, field);
  if (parameters.uncond_scale !== undefined) number(parameters.uncond_scale, 0, 100, 'uncond_scale');
  if (parameters.dynamic_thresholding_percentile !== undefined) number(parameters.dynamic_thresholding_percentile, 0, 1, 'dynamic_thresholding_percentile');
  if (parameters.dynamic_thresholding_mimic_scale !== undefined) number(parameters.dynamic_thresholding_mimic_scale, 0, 100, 'dynamic_thresholding_mimic_scale');
  if (parameters.cfg_sched_eligibility !== undefined && (typeof parameters.cfg_sched_eligibility !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(parameters.cfg_sched_eligibility))) fail(422, 'cfg_sched_eligibility 参数无效。');
  if (parameters.controlnet_strength !== undefined) number(parameters.controlnet_strength, 0, 2, 'controlnet_strength');
  const samplers = new Set(['k_euler', 'k_euler_ancestral', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde', 'k_dpm_2', 'k_dpm_2_ancestral', 'k_dpm_adaptive', 'ddim', 'ddim_v3', 'k_lms']);
  parameters.sampler ??= 'k_dpmpp_2m_sde';
  if (!samplers.has(parameters.sampler)) fail(422, '不支持该采样器。');
  parameters.noise_schedule ??= 'karras';
  if (!['native', 'karras', 'exponential', 'polyexponential'].includes(parameters.noise_schedule)) fail(422, '不支持该噪声调度器。');
  if (parameters.image_format !== undefined && parameters.image_format !== 'png') fail(422, '网关目前仅支持 PNG 输出。');
  const v3 = baseModel.endsWith('-3'), v5 = baseModel.startsWith('nai-diffusion-5-');
  if (parameters.autoSmea) fail(422, '暂不支持自动选择 SMEA；请在客户端明确选择 sm / sm_dyn。');
  if (!v3 && (parameters.sm || parameters.sm_dyn || parameters.autoSmea)) fail(422, '当前模型不支持 SMEA；请关闭该选项。');
  if (parameters.sm_dyn && !parameters.sm) fail(422, 'SMEA DYN 需要启用 SMEA。');
  // 官网负向角色提示词通常不带 use_coords，沿用正向提示词或顶层的布局模式。
  const useCoords = parameters.v4_prompt?.use_coords ?? parameters.use_coords;
  for (const field of ['v4_prompt', 'v4_negative_prompt']) if (active(parameters[field])) { if (v3) fail(422, 'V3 不支持多角色提示词结构。'); validateCaption(parameters[field], field, 24, useCoords); }
  if (parameters.characterPrompts !== undefined && (!Array.isArray(parameters.characterPrompts) || parameters.characterPrompts.length > 24)) fail(422, '角色提示词列表无效。');
  if (active(parameters.characterPrompts) && (v3 || !parameters.v4_prompt)) fail(422, '角色提示词需要当前模型的 v4_prompt 结构。');
  // characterPrompts 是启动器界面元数据；实际提示词以已经验证的 v4_prompt 为准。
  delete parameters.characterPrompts;
  let imageInfo;
  if (action === 'generate') {
    if (active(parameters.image) || active(parameters.mask) || active(parameters.image_cache_secret_key) || active(parameters.mask_cache_secret_key) || active(parameters.img2img)) fail(422, '文生图不能携带底图或遮罩；请选择 img2img 或 infill。');
    // 部分客户端保存整套默认参数；无底图时这些滑块不生效，也不能影响计费。
    for (const field of ['strength', 'noise', 'inpaintImg2ImgStrength']) {
      if (parameters[field] !== undefined) number(parameters[field], 0, 1, field);
      delete parameters[field];
    }
    if (!active(parameters.img2img)) delete parameters.img2img;
  } else {
    imageInfo = validateNativeImage(parameters.image, '底图');
    if (imageInfo.width !== width || imageInfo.height !== height) fail(422, '底图尺寸必须与 width、height 一致，请在客户端先调整尺寸。');
    parameters.image = imageInfo.base64;
    parameters.strength = number(parameters.strength ?? (action === 'infill' ? 1 : 0.7), 0, 1, 'strength');
    parameters.noise = number(parameters.noise ?? 0, 0, 1, 'noise');
    if (parameters.sm || parameters.sm_dyn) fail(422, '图生图与局部重绘不支持 SMEA。');
    if (action === 'infill') {
      const mask = validateNativeImage(parameters.mask, '遮罩');
      if (mask.mimeType !== 'image/png' || mask.width !== imageInfo.width || mask.height !== imageInfo.height) fail(422, '遮罩必须是与底图尺寸相同的 PNG。');
      parameters.mask = mask.base64;
      if (parameters.inpaintImg2ImgStrength !== undefined) {
        number(parameters.inpaintImg2ImgStrength, 0, 1, 'inpaintImg2ImgStrength');
        if (v3) fail(422, 'V3 不支持局部重绘强度。');
        if (parameters.img2img !== undefined && (!object(parameters.img2img) || parameters.img2img.strength !== parameters.inpaintImg2ImgStrength)) fail(422, '局部重绘的两个强度字段不一致。');
        parameters.img2img ??= { strength: parameters.inpaintImg2ImgStrength, color_correct: true };
      }
      if (parameters.img2img !== undefined) {
        if (v3 || !object(parameters.img2img)) fail(422, '该模型不支持局部重绘的 img2img 参数。');
        checkKeys(parameters.img2img, new Set(['strength', 'color_correct']), '局部重绘 img2img 含未知参数。');
        number(parameters.img2img.strength, 0, 1, 'img2img.strength');
        if (parameters.img2img.color_correct !== undefined && typeof parameters.img2img.color_correct !== 'boolean') fail(422, 'img2img.color_correct 必须是布尔值。');
      }
    } else if (active(parameters.mask) || active(parameters.mask_cache_secret_key) || active(parameters.img2img)) fail(422, '遮罩和局部重绘参数只能用于 action=infill。');
  }
  if (action !== 'infill' && parameters.inpaintImg2ImgStrength !== undefined) fail(422, '局部重绘强度只能用于 action=infill。');
  delete parameters.inpaintImg2ImgStrength;
  for (const field of ['image_cache_secret_key', 'mask_cache_secret_key', 'reference_image_cache_secret_key']) delete parameters[field];
  if (active(parameters.reference_image)) {
    if (active(parameters.reference_image_multiple) || active(parameters.reference_image_multiple_cached)) fail(422, '不能同时使用单张和多张 Vibe 字段。');
    parameters.reference_image_multiple = [parameters.reference_image];
    parameters.reference_strength_multiple = [parameters.reference_strength ?? 0.6];
    parameters.reference_information_extracted_multiple = [parameters.reference_information_extracted ?? 1];
  }
  delete parameters.reference_image; delete parameters.reference_strength; delete parameters.reference_information_extracted;
  const hasVibes = active(parameters.reference_image_multiple) || active(parameters.reference_image_multiple_cached);
  const hasPrecise = active(parameters.director_reference_images) || active(parameters.director_reference_images_cached);
  if (hasVibes && v5) fail(422, 'V5 官方尚不支持 Vibe Transfer；请改用 V3、V4 或 V4.5。');
  if (hasVibes && action === 'infill') fail(422, '官方局部重绘暂不支持 Vibe Transfer；请关闭 Vibe 或改用 V4.5 Precise Reference。');
  if (hasPrecise && !baseModel.startsWith('nai-diffusion-4-5-')) fail(422, 'Precise Reference 仅支持 V4.5。');
  if (hasVibes && hasPrecise) fail(422, '官方暂不支持同时使用 Vibe Transfer 与 Precise Reference。');
  const vibeCount = references(parameters, 'reference_image_multiple', 'reference_image_multiple_cached', { image: v3 });
  if (vibeCount) {
    numericList(parameters, 'reference_strength_multiple', vibeCount, 0, 1);
    if (v3) numericList(parameters, 'reference_information_extracted_multiple', vibeCount, 0, 1, 1);
    else if (active(parameters.reference_information_extracted_multiple)) numericList(parameters, 'reference_information_extracted_multiple', vibeCount, 0, 1);
  } else if (active(parameters.reference_strength_multiple) || active(parameters.reference_information_extracted_multiple)) fail(422, 'Vibe 强度参数缺少对应参考图。');
  const preciseCount = references(parameters, 'director_reference_images', 'director_reference_images_cached', { image: true });
  if (preciseCount) {
    for (const reference of parameters.director_reference_images) {
      const dimensions = validateNativeImage(reference, 'Precise Reference');
      if (!['1024x1536', '1536x1024', '1472x1472'].includes(`${dimensions.width}x${dimensions.height}`)) fail(422, 'Precise Reference 请先在客户端按官方尺寸处理：1024×1536、1536×1024 或 1472×1472。');
    }
    numericList(parameters, 'director_reference_information_extracted', preciseCount, 0, 1, 1);
    numericList(parameters, 'director_reference_strength_values', preciseCount, -1, 1, 1);
    numericList(parameters, 'director_reference_secondary_strength_values', preciseCount, -1, 2, 0);
    if (!Array.isArray(parameters.director_reference_descriptions) || parameters.director_reference_descriptions.length !== preciseCount) fail(422, 'Precise Reference 描述数量与参考图不一致。');
    for (const description of parameters.director_reference_descriptions) validateCaption(description, 'Precise Reference', 0);
  } else if (['director_reference_descriptions', 'director_reference_information_extracted', 'director_reference_strength_values', 'director_reference_secondary_strength_values'].some(field => active(parameters[field]))) fail(422, 'Precise Reference 参数缺少对应图片。');
  delete parameters.stream;
  return {
    prompt: body.input, tag: body.input, artist: '', action, model, baseModel, sampleCount,
    negative: parameters.negative_prompt ?? '', width, height, steps, requestedSteps: steps,
    scale: parameters.scale, cfg: parameters.cfg_rescale, sampler: parameters.sampler, noiseSchedule: parameters.noise_schedule,
    seed: parameters.seed, nativeParameters: parameters, nocache: true,
  };
}

export function parseNativeAuxiliaryRequest(body, operation) {
  if (!object(body)) fail(400, 'Expected a JSON object.');
  if (!['encode-vibe', 'upscale'].includes(operation)) fail(422, '不支持此图片操作。');
  if (body.allowPurchasedAnlas !== undefined && typeof body.allowPurchasedAnlas !== 'boolean') fail(422, 'allowPurchasedAnlas 必须是布尔值。');
  const image = validateNativeImage(body.image);
  const operationParameters = { image: image.base64 };
  if (operation === 'encode-vibe') {
    if (Object.hasOwn(body, 'mask')) fail(422, 'Vibe 编码暂不支持 mask；请先导出需要编码的完整参考图。');
    checkKeys(body, new Set(['image', 'model', 'information_extracted', 'allowPurchasedAnlas']), 'Vibe 编码含不支持的字段。');
    if (!['nai-diffusion-4-curated-preview', 'nai-diffusion-4-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-5-full'].includes(body.model)) fail(422, 'Vibe 编码仅支持 V4 和 V4.5；V3 使用原图，V5 尚不支持 Vibe。');
    operationParameters.model = body.model;
    operationParameters.information_extracted = number(body.information_extracted ?? 1, 0, 1, 'information_extracted');
  } else {
    checkKeys(body, new Set(['image', 'model', 'declared_blur_sigma', 'scale', 'width', 'height', 'allowPurchasedAnlas']), '放大请求含不支持的字段。');
    if (body.width !== undefined && body.width !== image.width || body.height !== undefined && body.height !== image.height) fail(422, '声明的图片尺寸与实际内容不一致。');
    if (body.model !== undefined && body.model !== 'nai-diffusion-5-curated') fail(422, '不支持此放大模型。');
    if (body.scale !== undefined && body.scale !== 2) fail(422, '当前官方放大接口仅支持 2 倍边长放大。');
    operationParameters.model = 'nai-diffusion-5-curated';
    operationParameters.declared_blur_sigma = number(body.declared_blur_sigma ?? 0, 0, 0, 'declared_blur_sigma');
    if (image.width * image.height > 3145728) fail(422, '独立放大输入不能超过官方 3145728 像素上限。');
  }
  return { operation, operationParameters, action: operation, model: operationParameters.model, width: image.width, height: image.height, steps: 1, requestedSteps: 1, prompt: operation, tag: operation, artist: '', negative: '', seed: 0, sampleCount: 1, nocache: true };
}
