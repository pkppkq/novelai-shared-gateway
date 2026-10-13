// 原生流式接口按大端长度分帧，帧内只编码明确的 final / error 字段。
// 图片完成并由现有任务账本结算后才返回，不把预览当成最终结果。
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

function text(value) {
  const bytes = Buffer.from(String(value), 'utf8');
  const header = Buffer.alloc(5);
  header[0] = 0xdb;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

function sampleIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new RangeError('原生图片样本编号无效');
  return Buffer.from([index]);
}

function frame(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  if (length > MAX_FRAME_BYTES) throw new RangeError('原生图片响应超过单帧限制');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(length);
  return Buffer.concat([prefix, ...parts]);
}

export function nativeImagesMsgpack(images, failure = null) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 4) throw new RangeError('原生图片响应数量无效');
  const frames = images.map((image, index) => {
    if (!Buffer.isBuffer(image) || !image.length) throw new TypeError('原生图片响应缺少二进制图片');
    const binary = Buffer.alloc(5);
    binary[0] = 0xc6;
    binary.writeUInt32BE(image.length, 1);
    return frame([Buffer.from([0x83]), text('event_type'), text('final'), text('samp_ix'), sampleIndex(index), text('image'), binary, image]);
  });
  // 多图逐张结算；前面的成功图保留，后续失败通过 error 帧说明，不能冒充全量成功。
  if (failure) {
    if (failure.index !== images.length) throw new RangeError('原生图片失败样本编号不连续');
    frames.push(frame([Buffer.from([0x83]), text('event_type'), text('error'), text('samp_ix'), sampleIndex(failure.index), text('message'), text(String(failure.message || '生成失败').slice(0, 2000))]));
  }
  return Buffer.concat(frames);
}
