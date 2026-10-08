import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNovelAiImage } from './server/providers.js';

const account = { token: 'offline-provider-feature-token' };
const env = { NOVELAI_API_URL: 'https://configured-upstream.invalid/' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const originalFetch = globalThis.fetch;

async function captured(run, response = () => new Response(png, { headers: { 'content-type': 'image/png' } })) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return response();
  };
  try { return { value: await run(), calls }; }
  finally { globalThis.fetch = originalFetch; }
}

function request(action = 'generate') {
  return { action, model: 'nai-diffusion-4-5-full', prompt: 'a blue test circle',
    width: 1024, height: 1024, steps: 23, seed: 42,
    nativeParameters: { width: 2048, height: 2048, steps: 50, seed: 9, n_samples: 4,
      scale: 5.5, sampler: 'k_euler', strength: 0.43, noise: 0.12,
      image: png.toString('base64'), mask: png.toString('base64'),
      extra_noise_seed: 77, add_original_image: true,
      reference_image_multiple_cached: [{ data: 'encoded-vibe', cache_secret_key: 'offline-cache-key' }],
      reference_strength_multiple: [0.6],
      director_reference_images: [png.toString('base64')],
      director_reference_strengths: [0.5],
      director_reference_information_extracted: [1],
      director_reference_descriptions: [{ caption: { base_caption: 'character&style', char_captions: [] } }],
      v4_prompt: { caption: { base_caption: 'a blue test circle', char_captions: [] }, use_coords: false },
      stream: 'msgpack' }
  };
}

test('图生图和局部重绘按原动作转发，保留图像、遮罩和已核价的参考强度', async () => {
  for (const action of ['generate', 'img2img', 'infill']) {
    const input = request(action);
    if (action === 'infill') input.model += '-inpainting';
    const before = structuredClone(input);
    const { calls, value } = await captured(() => generateNovelAiImage(input, account, env, { forceStream: false }));
    assert.deepEqual(input, before);
    assert.equal(value.mimeType, 'image/png');
    assert.deepEqual(value.buffer, png);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://configured-upstream.invalid/ai/generate-image');
    assert.equal(calls[0].body.action, action);
    assert.equal(calls[0].body.model, input.model);
    const expected = { ...before.nativeParameters, width: 1024, height: 1024, steps: 23, seed: 42, n_samples: 1 };
    delete expected.stream;
    assert.deepEqual(calls[0].body.parameters, expected);
  }
});

test('V3 动作维持非流式，V4 流式也保留 img2img 动作与收费参数', async () => {
  const v3 = request('img2img'); v3.model = 'nai-diffusion-3';
  const v4 = request('img2img'); v4.model = 'nai-diffusion-4-full';
  const { calls } = await captured(async () => {
    await generateNovelAiImage(v3, account, env);
    await generateNovelAiImage(v4, account, env);
  }, () => Response.json({ image: png.toString('base64') }));
  assert.deepEqual(calls.map(c => c.url), [
    'https://configured-upstream.invalid/ai/generate-image',
    'https://configured-upstream.invalid/ai/generate-image-stream'
  ]);
  for (const call of calls) {
    assert.equal(call.body.action, 'img2img');
    assert.equal(call.body.parameters.strength, 0.43);
    assert.equal(call.body.parameters.n_samples, 1);
    assert.equal(call.body.parameters.image, png.toString('base64'));
  }
  assert.equal(calls[1].body.parameters.stream, 'msgpack');
});

test('Vibe 编码使用固定上游、共享身份和取消信号，二进制完整返回', async () => {
  const signal = new AbortController().signal;
  const parameters = { image: png.toString('base64'), mask: png.toString('base64'), information_extracted: 0.8, model: 'nai-diffusion-4-5-full' };
  const encoding = Buffer.from([0, 255, 3, 4, 5, 128]);
  const { calls, value } = await captured(() => generateNovelAiImage({ operation: 'encode-vibe', action: 'encode-vibe', operationParameters: parameters }, account, env, { signal, forceStream: true }),
    () => new Response(encoding, { headers: { 'content-type': 'application/octet-stream' } }));
  assert.deepEqual(value, { buffer: encoding, mimeType: 'application/octet-stream' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://configured-upstream.invalid/ai/encode-vibe');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${account.token}`);
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(calls[0].body, parameters);
});

test('放大维持官网新版参数并返回图片，不使用客户端URL或自动重试旧付费接口', async () => {
  const parameters = { image: png.toString('base64'), model: 'nai-diffusion-5-curated', declared_blur_sigma: 0 };
  const input = { operation: 'upscale', operationParameters: parameters, url: 'https://untrusted.invalid/steal' };
  const { calls, value } = await captured(() => generateNovelAiImage(input, account, env));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://configured-upstream.invalid/ai/upscale');
  assert.deepEqual(calls[0].body, parameters);
  assert.equal(value.mimeType, 'image/png');
  assert.deepEqual(value.buffer, png);
  await captured(async () => {
    await assert.rejects(generateNovelAiImage(input, account, env), error => error.upstreamStatus === 402);
  }, () => new Response('insufficient credits', { status: 402 }));
});

test('编码和放大错误保留上游状态，空响应及伪装成功的编码JSON不结算成功', async () => {
  for (const operation of ['encode-vibe', 'upscale']) {
    const input = { operation, operationParameters: { image: png.toString('base64'), model: 'nai-diffusion-4-5-full' } };
    for (const status of [400, 401, 402, 422, 429, 500]) {
      const { calls } = await captured(async () => {
        await assert.rejects(generateNovelAiImage(input, account, env), error => error.upstreamStatus === status);
      }, () => new Response('offline failure', { status }));
      assert.equal(calls.length, 1);
    }
    await captured(async () => {
      await assert.rejects(generateNovelAiImage(input, account, env), /empty operation result/);
    }, () => new Response());
  }
  await captured(async () => {
    await assert.rejects(generateNovelAiImage({ operation: 'encode-vibe', operationParameters: {} }, account, env), /binary encoding data/);
  }, () => Response.json({ error: 'invalid image' }));
});

test('未知操作或动作在联网前拒绝', async () => {
  const { calls } = await captured(async () => {
    await assert.rejects(generateNovelAiImage({ operation: '../user/data' }, account, env), /Unsupported NovelAI operation/);
    await assert.rejects(generateNovelAiImage({ action: 'unknown' }, account, env), /Unsupported NovelAI image action/);
    await assert.rejects(generateNovelAiImage({ operation: 'encode-vibe' }, account, env), /parameters are required/);
    await assert.rejects(generateNovelAiImage({ operation: 'encode-vibe', operationParameters: {} }, {}, env), /No enabled NovelAI account/);
  });
  assert.equal(calls.length, 0);
});

function msgpack(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from([0xc4, value.length]), value]);
  if (typeof value === 'string') {
    const text = Buffer.from(value);
    return Buffer.concat([Buffer.from([0xa0 | text.length]), text]);
  }
  const fields = Object.entries(value);
  return Buffer.concat([Buffer.from([0x80 | fields.length]), ...fields.flatMap(([key, item]) => [msgpack(key), msgpack(item)])]);
}

function streamBody(events) {
  return Buffer.concat(events.map(event => {
    const frame = msgpack(event);
    const length = Buffer.alloc(4); length.writeUInt32BE(frame.length);
    return Buffer.concat([length, frame]);
  }));
}

test('流式预览后报错或缺失最终结果必须失败，不能把预览当作已完成扣费', async () => {
  const intermediate = { event_type: 'intermediate', image: png };
  for (const events of [[intermediate], [intermediate, { event_type: 'error', message: 'offline stream failure' }]]) {
    await captured(async () => {
      await assert.rejects(generateNovelAiImage(request('img2img'), account, env), /without a final image|stream error/);
    }, () => new Response(streamBody(events), { headers: { 'content-type': 'application/octet-stream' } }));
  }
  const { value } = await captured(() => generateNovelAiImage(request('img2img'), account, env),
    () => new Response(streamBody([intermediate, { event_type: 'final', image: png }]), { headers: { 'content-type': 'application/octet-stream' } }));
  assert.deepEqual(value.buffer, png);
});
