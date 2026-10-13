// 2026-10-10 核对官网模型定义、计价模块及 10 月 8 日 Medium 公告。
export const V5_MEDIUM_MODEL = 'nai-diffusion-5-full-medium';
export const V5_MEDIUM_INPAINT_MODEL = 'nai-diffusion-5-full-medium-inpainting';
export const V5_MEDIUM_STEPS = 14;
export const V5_MEDIUM_ANLAS_STEP_FACTOR = 1 / 1.06521739;
// 官方公告称默认规格约省 42% 用量；用于本地百分点估算，不是逐张官方账单。
export const V5_MEDIUM_USAGE_FACTOR = 0.58;
export const isV5MediumModel = model => model === V5_MEDIUM_MODEL || model === V5_MEDIUM_INPAINT_MODEL;
