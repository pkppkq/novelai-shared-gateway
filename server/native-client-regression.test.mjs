import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeImageRequest } from './native-image.js';

// 只复刻线上失败请求的结构，提示词和种子使用合成数据。
function clientRequest() {
  const prompts = ['red cat', 'blue bird'];
  const caption = (negative = false) => ({
    caption: {
      base_caption: negative ? 'low quality' : 'two animals in a garden',
      char_captions: prompts.map(prompt => ({
        char_caption: negative ? '' : prompt,
        centers: [{}],
      })),
    },
  });
  return {
    input: 'two animals in a garden',
    model: 'nai-diffusion-5-full',
    action: 'generate',
    use_new_shared_trial: true,
    parameters: {
      width: 832,
      height: 1216,
      steps: 23,
      scale: 7,
      n_samples: 1,
      seed: 4294967301,
      sampler: 'k_euler_ancestral',
      noise_schedule: 'karras',
      stream: 'msgpack',
      use_coords: false,
      characterPrompts: prompts.map(prompt => ({ prompt, uc: '', enabled: true, center: {} })),
      v4_prompt: { ...caption(), use_coords: false, use_order: true },
      v4_negative_prompt: { ...caption(true), legacy_uc: false },
      reference_image_multiple_cached: [],
      reference_strength_multiple: [],
    },
  };
}

function centers(parameters, field) {
  return parameters[field].caption.char_captions.map(character => character.centers);
}

function rejectsCoordinates(body) {
  assert.throws(() => parseNativeImageRequest(body), error => error.statusCode === 422 && /角色 [xy]/.test(error.message));
}

test('历史双角色自动布局请求可通过，补空坐标且不修改调用者对象', () => {
  const body = clientRequest();
  const snapshot = structuredClone(body);
  const parsed = parseNativeImageRequest(body);
  assert.equal(parsed.model, 'nai-diffusion-5-full');
  assert.equal(parsed.width, 832);
  assert.equal(parsed.height, 1216);
  assert.equal(parsed.steps, 23);
  assert.equal(parsed.scale, 7);
  assert.equal(parsed.seed, 5);
  assert.equal(parsed.nativeParameters.seed, 5);
  assert.equal(parsed.nativeParameters.stream, undefined);
  assert.equal(parsed.nativeParameters.characterPrompts, undefined);
  assert.equal(parsed.nativeParameters.v4_prompt.use_coords, false);
  assert.deepEqual(centers(parsed.nativeParameters, 'v4_prompt'), [[{ x: 0.5, y: 0.5 }], [{ x: 0.5, y: 0.5 }]]);
  assert.deepEqual(centers(parsed.nativeParameters, 'v4_negative_prompt'), [[{ x: 0.5, y: 0.5 }], [{ x: 0.5, y: 0.5 }]]);
  assert.deepEqual(body, snapshot);
});

test('自动布局仅补缺失和 null 分量，保留另一分量及有效边界坐标', () => {
  for (const [center, expected] of [
    [{ x: 0, y: 1 }, { x: 0, y: 1 }],
    [{ x: 0.25 }, { x: 0.25, y: 0.5 }],
    [{ y: 0.75 }, { x: 0.5, y: 0.75 }],
    [{ x: null, y: 0.8 }, { x: 0.5, y: 0.8 }],
    [{ x: 0.2, y: null }, { x: 0.2, y: 0.5 }],
    [{ x: undefined, y: null }, { x: 0.5, y: 0.5 }],
  ]) {
    const body = clientRequest();
    for (const field of ['v4_prompt', 'v4_negative_prompt']) body.parameters[field].caption.char_captions[0].centers = [center];
    const parsed = parseNativeImageRequest(body);
    for (const field of ['v4_prompt', 'v4_negative_prompt']) assert.deepEqual(centers(parsed.nativeParameters, field)[0], [expected]);
  }
});

test('负向未声明布局时继承正向，正向未声明时继承顶层', () => {
  const positiveOnly = clientRequest();
  delete positiveOnly.parameters.use_coords;
  assert.deepEqual(centers(parseNativeImageRequest(positiveOnly).nativeParameters, 'v4_negative_prompt')[0], [{ x: 0.5, y: 0.5 }]);

  const topOnly = clientRequest();
  delete topOnly.parameters.v4_prompt.use_coords;
  const parsed = parseNativeImageRequest(topOnly);
  for (const field of ['v4_prompt', 'v4_negative_prompt']) assert.deepEqual(centers(parsed.nativeParameters, field)[0], [{ x: 0.5, y: 0.5 }]);
});

test('正向显式布局优先于顶层；负向显式手动模式保持严格', () => {
  const positiveAuto = clientRequest();
  positiveAuto.parameters.use_coords = true;
  assert.deepEqual(centers(parseNativeImageRequest(positiveAuto).nativeParameters, 'v4_negative_prompt')[0], [{ x: 0.5, y: 0.5 }]);

  const positiveManual = clientRequest();
  positiveManual.parameters.v4_prompt.use_coords = true;
  rejectsCoordinates(positiveManual);

  const negativeManual = clientRequest();
  negativeManual.parameters.v4_negative_prompt.use_coords = true;
  rejectsCoordinates(negativeManual);
});

test('未明确自动布局或手动布局时，空坐标不可静默通过', () => {
  for (const mode of [undefined, true]) {
    const body = clientRequest();
    delete body.parameters.v4_prompt.use_coords;
    if (mode === undefined) delete body.parameters.use_coords;
    else body.parameters.use_coords = mode;
    rejectsCoordinates(body);
  }
  const body = clientRequest();
  body.parameters.v4_prompt.use_coords = true;
  body.parameters.v4_prompt.caption.char_captions.forEach(character => { character.centers = [{ x: 0.25, y: 0.75 }]; });
  // 负向没有自己的模式，必须继承正向手动模式而不是顶层 false。
  rejectsCoordinates(body);
});

test('手动布局完整合法坐标原样保留，负向可显式选择自动布局', () => {
  const body = clientRequest();
  body.parameters.use_coords = true;
  body.parameters.v4_prompt.use_coords = true;
  body.parameters.v4_prompt.caption.char_captions.forEach(character => { character.centers = [{ x: 0, y: 1 }, { x: 1, y: 0 }]; });
  body.parameters.v4_negative_prompt.use_coords = false;
  const parsed = parseNativeImageRequest(body);
  assert.deepEqual(centers(parsed.nativeParameters, 'v4_prompt')[0], [{ x: 0, y: 1 }, { x: 1, y: 0 }]);
  assert.deepEqual(centers(parsed.nativeParameters, 'v4_negative_prompt')[0], [{ x: 0.5, y: 0.5 }]);
});

test('自动布局仍拒绝已填写的非法坐标，不把坏值当空字段', () => {
  for (const field of ['v4_prompt', 'v4_negative_prompt']) {
    for (const axis of ['x', 'y']) {
      for (const invalid of ['0.5', '', false, [], {}, NaN, Infinity, -Infinity, -1, 1.01]) {
        const body = clientRequest();
        body.parameters[field].caption.char_captions[0].centers = [{ x: 0.5, y: 0.5, [axis]: invalid }];
        rejectsCoordinates(body);
      }
    }
  }
});

test('官网与柏宝绘的 DPM++ 2S Ancestral 采样器按原值通过，未知采样器仍拒绝', () => {
  for (const model of ['nai-diffusion-3', 'nai-diffusion-4-full', 'nai-diffusion-4-5-full', 'nai-diffusion-5-full']) {
    const body = clientRequest();
    body.model = model;
    body.parameters.sampler = 'k_dpmpp_2s_ancestral';
    if (model === 'nai-diffusion-3') {
      delete body.parameters.v4_prompt;
      delete body.parameters.v4_negative_prompt;
      delete body.parameters.characterPrompts;
    }
    const parsed = parseNativeImageRequest(body);
    assert.equal(parsed.sampler, 'k_dpmpp_2s_ancestral');
    assert.equal(parsed.nativeParameters.sampler, 'k_dpmpp_2s_ancestral');
  }
  const body = clientRequest();
  body.parameters.sampler = 'unknown_sampler';
  assert.throws(() => parseNativeImageRequest(body), error => error.statusCode === 422 && error.message.includes('采样器'));
});
