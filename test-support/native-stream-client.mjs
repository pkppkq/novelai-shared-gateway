import assert from 'node:assert/strict';
import { decode } from './msgpack.mjs';

// 使用客户端同版本的独立 MessagePack 解码库验协议，不复用服务端编码逻辑。
export function readNativeEvents(buffer) {
  const events = [];
  let offset = 0;
  while (offset < buffer.length) {
    assert.ok(buffer.length - offset >= 4, '缺少大端帧长度');
    const length = buffer.readUInt32BE(offset);
    assert.ok(length > 0 && length <= 64 * 1024 * 1024, '无效帧长度');
    offset += 4;
    assert.ok(offset + length <= buffer.length, '帧被截断');
    events.push(decode(buffer.subarray(offset, offset + length)));
    offset += length;
  }
  return events;
}
