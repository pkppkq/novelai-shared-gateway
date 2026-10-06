export const sizeMap = {
  '竖图': { width: 832, height: 1216 },
  '横图': { width: 1216, height: 832 },
  '方图': { width: 1024, height: 1024 },
  '2K竖图': { width: 1088, height: 1600 },
  '2K横图': { width: 1600, height: 1088 },
  '2K方图': { width: 1344, height: 1344 },
  '4K竖图': { width: 1344, height: 1984 },
  '4K横图': { width: 1984, height: 1344 },
  '4K方图': { width: 1728, height: 1728 }
};

// Shared site pricing: standard <=28-step images keep 1/8 credits.
// Paid sizes/steps follow NovelAI's single-image formula (SMEA/DYN are disabled).
// Verified 2026-10-05: https://novelai.net/_next/static/chunks/1601-6ba10aad6d763f0c.js
export function generationPrice({ size = '竖图', width, height, model, steps = 28 } = {}) {
  const dimensions = sizeMap[size] || sizeMap['竖图'];
  const pixels = Number(width ?? dimensions.width) * Number(height ?? dimensions.height);
  const v5 = model === 'nai-diffusion-5-full';
  if (steps <= 28 && pixels <= 1024 * 1024) return v5 ? 8 : 1;
  const base = Math.ceil(2.951823174884865e-6 * pixels + 5.753298233447344e-7 * pixels * steps);
  // Round BEFORE the V5 multiplier, then round again, exactly as on the official site.
  return Math.max(2, Math.ceil(base * (v5 ? 1.5 : 1)));
}
