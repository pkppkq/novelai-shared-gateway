import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeImagesMsgpack } from './native-stream.js';
import { readNativeEvents } from '../test-support/native-stream-client.mjs';

test('NAI 原生 MessagePack 由独立客户端解码，保留二进制和零号样本', () => {
  for (const length of [8, 255, 256, 65535, 65536]) {
    const image = Buffer.alloc(length, 0x89);
    const frames = nativeImagesMsgpack([image]);
    assert.equal(frames.readUInt32BE(0), frames.length - 4);
    const [event] = readNativeEvents(frames);
    assert.equal(event.event_type, 'final');
    assert.equal(event.samp_ix, 0);
    assert.ok(event.image instanceof Uint8Array);
    assert.deepEqual(Buffer.from(event.image), image);
  }
});

test('四张图按顺序分帧，部分成功保留已完成图片并发送中文错误帧', () => {
  const images = [0, 1, 2, 3].map(value => Buffer.from([value, 0, 255]));
  const events = readNativeEvents(nativeImagesMsgpack(images));
  assert.deepEqual(events.map(event => event.samp_ix), [0, 1, 2, 3]);
  for (const [index, event] of events.entries()) assert.deepEqual(Buffer.from(event.image), images[index]);
  const partial = readNativeEvents(nativeImagesMsgpack(images.slice(0, 1), { index: 1, message: '下一张失败，已退回本张额度' }));
  assert.equal(partial.length, 2);
  assert.equal(partial[0].event_type, 'final');
  assert.deepEqual(partial[1], { event_type: 'error', samp_ix: 1, message: '下一张失败，已退回本张额度' });
});

test('缺少图片、越界数量与不连续的失败编号不能伪装成功帧', () => {
  for (const images of [[], [Buffer.alloc(0)], ['not binary'], Array(5).fill(Buffer.from('x'))]) assert.throws(() => nativeImagesMsgpack(images));
  assert.throws(() => nativeImagesMsgpack([Buffer.from('x')], { index: 2, message: 'bad index' }));
});
