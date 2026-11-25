import { deflateSync } from 'node:zlib';

// 所有像素在测试内合成，不读取图片文件或任何账户资料。
export function syntheticPng(width = 1024, height = 1024) {
  const checksum = data => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type), result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    name.copy(result, 4); data.copy(result, 8);
    result.writeUInt32BE(checksum(Buffer.concat([name, data])), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
  ]).toString('base64');
}

export function preciseParameters(image = syntheticPng(), count = 1, description = 'character') {
  return {
    director_reference_images: Array(count).fill(image),
    director_reference_information_extracted: Array(count).fill(1),
    director_reference_strength_values: Array(count).fill(1),
    director_reference_secondary_strength_values: Array(count).fill(0),
    director_reference_descriptions: Array.from({ length: count }, () => ({
      caption: { base_caption: description, char_captions: [] },
      use_coords: false, use_order: true
    }))
  };
}

export function syntheticOpus(now = Date.now(), { fixed = 10000, purchased = 0 } = {}) {
  return {
    id: 'synthetic-opus', enabled: true, quotaTier: 3, subscriptionActive: true,
    subscriptionExpiresAt: now + 86400000, quotaFixed: fixed, quotaPurchased: purchased,
    v5UsagePercent: 80, v5UsageIsNegative: false, v5UsageTimeUntilNextPercent: 0, quotaCheckedAt: now
  };
}
