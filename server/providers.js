import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { sizeMap } from '../public/generation-pricing.js';

export const MAX_STEPS = 50;
export const DIRECT_URL_MAX_STEPS = 28;

export function normalizeNovelAiRequest(input, settings, options = {}) {
  const defaults = settings.defaults || {};
  const maxSteps = Number.isFinite(Number(options.maxSteps)) ? Number(options.maxSteps) : MAX_STEPS;
  const sizeName = normalizeSizeName(input.size || defaults.size || '竖图');
  const mappedSize = sizeMap[sizeName] || {};
  const tag = normalizePromptText(input.tag || input.prompt || '').trim();
  const artist = normalizePromptText(input.artist ?? settings.defaultArtist ?? '').trim();
  const prompt = [artist, tag].filter(Boolean).join('\n');
  const requestedSteps = input.steps ?? defaults.steps;

  return {
    tag,
    prompt,
    artist,
    model: String(input.model || settings.defaultModel || 'nai-diffusion-4-5-full'),
    negative: normalizePromptText(input.negative ?? settings.defaultNegative ?? ''),
    width: clampNumber(input.width ?? mappedSize.width ?? defaults.width, 128, 2048),
    height: clampNumber(input.height ?? mappedSize.height ?? defaults.height, 128, 2048),
    size: sizeName,
    requestedSteps: requestedSteps === undefined || requestedSteps === '' ? undefined : Number(requestedSteps),
    steps: clampNumber(requestedSteps, 1, maxSteps),
    scale: clampNumber(input.scale ?? defaults.scale, 1, 20),
    cfg: clampNumber(input.cfg ?? defaults.cfg, 0, 1),
    sampler: String(input.sampler || defaults.sampler || 'k_dpmpp_2m_sde'),
    noiseSchedule: String(input.noise_schedule || input.noiseSchedule || defaults.noiseSchedule || 'karras'),
    seed: input.seed === undefined || input.seed === '' ? Math.floor(Math.random() * 2 ** 31) : Number(input.seed),
    cost: input.cost === undefined || input.cost === '' ? undefined : Number(input.cost)
  };
}

function normalizePromptText(value) {
  return String(value).replace(/\\n/g, '\n');
}

function normalizeSizeName(value) {
  return String(value || '').replace(/\s*\(-\d+\)\s*$/, '').trim();
}

export async function generateNovelAiImage(request, account, env, options = {}) {
  if (!account?.token) {
    if (env.MOCK_WHEN_NO_ACCOUNT === 'false') {
      throw new Error('No enabled NovelAI account is available.');
    }
    return generateMockImage(request);
  }

  if (shouldUseNovelAiStream(request, env, options)) {
    return generateNovelAiImageStream(request, account, env, options);
  }

  const baseUrl = (env.NOVELAI_API_URL || 'https://image.novelai.net').replace(/\/$/, '');
  const correlationId = novelAiCorrelationId();
  const response = await novelAiFetch(`${baseUrl}/ai/generate-image`, {
    method: 'POST',
    signal: options.signal,
    headers: {
      authorization: `Bearer ${account.token}`,
      'content-type': 'application/json',
      accept: 'application/x-zip-compressed,image/png,application/json',
      origin: 'https://novelai.net',
      referer: 'https://novelai.net/',
      'x-correlation-id': correlationId,
      'x-initiated-at': new Date().toISOString(),
      'user-agent': 'Mozilla/5.0 Nai2API/1.0'
    },
    body: JSON.stringify({
      action: 'generate',
      input: request.prompt,
      model: request.model,
      parameters: buildNovelAiParameters(request),
      use_new_shared_trial: true
    })
  }, accountProxyUrl(account));

  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    const text = buffer.toString('utf8').slice(0, 1000);
    throw new Error(`NovelAI returned ${response.status} (cid=${correlationId}): ${text}`);
  }

  if (contentType.includes('application/json')) {
    const payload = JSON.parse(buffer.toString('utf8'));
    const base64 = payload.image || payload.data || payload.images?.[0]?.image || payload.images?.[0];
    if (!base64) throw new Error('NovelAI JSON response does not contain image data.');
    return decodeDataUrl(base64);
  }

  if (contentType.includes('zip') || looksLikeZip(buffer)) {
    return extractFirstImageFromZip(buffer);
  }

  return {
    mimeType: contentType.includes('jpeg') ? 'image/jpeg' : 'image/png',
    buffer
  };
}

async function generateNovelAiImageStream(request, account, env, options = {}) {
  const baseUrl = (env.NOVELAI_API_URL || 'https://image.novelai.net').replace(/\/$/, '');
  const correlationId = novelAiCorrelationId();
  const parameters = buildNovelAiParameters(request);
  parameters.stream = 'msgpack';

  const response = await novelAiFetch(`${baseUrl}/ai/generate-image-stream`, {
    method: 'POST',
    signal: options.signal,
    headers: {
      authorization: `Bearer ${account.token}`,
      'content-type': 'application/json',
      accept: 'application/octet-stream,application/x-msgpack,application/json',
      origin: 'https://novelai.net',
      referer: 'https://novelai.net/',
      'x-correlation-id': correlationId,
      'x-initiated-at': new Date().toISOString(),
      'user-agent': 'Mozilla/5.0 Nai2API/1.0'
    },
    body: JSON.stringify({
      action: 'generate',
      input: request.prompt,
      model: request.model,
      parameters,
      use_new_shared_trial: true
    })
  }, accountProxyUrl(account));

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || contentType.includes('application/json')) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const text = buffer.toString('utf8').slice(0, 1000);
      throw new Error(`NovelAI returned ${response.status} (cid=${correlationId}): ${text}`);
    }
    const payload = JSON.parse(buffer.toString('utf8'));
    const base64 = payload.image || payload.data || payload.images?.[0]?.image || payload.images?.[0];
    if (!base64) throw new Error('NovelAI JSON stream response does not contain image data.');
    return decodeDataUrl(base64);
  }

  if (response.body) {
    return extractFinalImageFromNovelAiReadableStream(response.body, {
      request,
      onProgress: options.onProgress
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return extractFinalImageFromNovelAiStream(buffer, {
    request,
    onProgress: options.onProgress
  });
}

export async function fetchNovelAiAccountQuota(token, env = {}, options = {}) {
  if (!token) throw new Error('NovelAI account token is required.');
  const baseUrl = (env.NOVELAI_ACCOUNT_API_URL || 'https://image.novelai.net').replace(/\/$/, '');
  const response = await novelAiFetch(`${baseUrl}/user/data`, {
    method: 'GET',
    signal: options.signal,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      origin: 'https://novelai.net',
      referer: 'https://novelai.net/',
      'user-agent': 'Mozilla/5.0 Nai2API/1.0'
    }
  }, normalizeSocksProxyUrl(options.proxyUrl || ''));

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`NovelAI account returned ${response.status}: ${text.slice(0, 500)}`);
  }

  const payload = text ? JSON.parse(text) : {};
  const subscription = payload.subscription || payload.account?.subscription || {};
  const stepsLeft = subscription.trainingStepsLeft || subscription.training_steps_left || {};
  const fixed = numberOrNull(
    stepsLeft.fixedTrainingStepsLeft
    ?? stepsLeft.fixed_training_steps_left
    ?? subscription.fixedTrainingStepsLeft
    ?? subscription.fixed_training_steps_left
  );
  const purchased = numberOrNull(
    stepsLeft.purchasedTrainingSteps
    ?? stepsLeft.purchased_training_steps
    ?? subscription.purchasedTrainingSteps
    ?? subscription.purchased_training_steps
  );
  const values = [fixed, purchased].filter((value) => value !== null);
  const usage = subscription.usage || payload.usage || {};

  // 新试用接口独立于订阅余额；查询失败时保持未知，不将旧字段当作零额度。
  let trialRemainingImages = null;
  let trialUsedImages = null;
  let trialEligible = false;
  let trialStatusKnown = false;
  try {
    const trialResponse = await novelAiFetch(`${baseUrl}/ai/trial-status`, {
      method: 'GET',
      signal: options.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        origin: 'https://novelai.net',
        referer: 'https://novelai.net/',
        'user-agent': 'Mozilla/5.0 Nai2API/1.0'
      }
    }, normalizeSocksProxyUrl(options.proxyUrl || ''));
    const trialText = await trialResponse.text();
    if (trialResponse.ok) {
      const trial = JSON.parse(trialText);
      const remaining = trial?.remaining_image_actions;
      const used = trial?.used_image_actions;
      trialRemainingImages = Number.isSafeInteger(remaining) && remaining >= 0 ? remaining : null;
      trialUsedImages = Number.isSafeInteger(used) && used >= 0 ? used : null;
      trialEligible = trial?.eligible_for_image_gens === true;
      trialStatusKnown = trialRemainingImages !== null && typeof trial?.eligible_for_image_gens === 'boolean';
    }
  } catch {
    // 试用接口不可用时仍返回已取得的订阅结果，也不记录可能包含凭据的响应。
  }

  return {
    points: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    fixed,
    purchased,
    tier: subscription.tier ?? subscription.subscriptionTier ?? payload.tier ?? null,
    subscriptionActive: subscription.active === true,
    subscriptionExpiresAt: subscription.expiresAt ?? null,
    v5UsagePercent: numberOrNull(usage.percent),
    v5UsageIsNegative: Boolean(usage.isNegative ?? usage.is_negative),
    v5UsageTimeUntilNextPercent: numberOrNull(usage.timeUntilNextPercent ?? usage.time_until_next_percent),
    trialRemainingImages,
    trialUsedImages,
    trialEligible,
    trialStatusKnown,
    raw: payload
  };
}

async function novelAiFetch(url, options = {}, proxyUrl = '') {
  const normalizedProxy = normalizeSocksProxyUrl(proxyUrl);
  if (!normalizedProxy) return fetch(url, options);
  return socksFetch(url, options, normalizedProxy);
}

function accountProxyUrl(account = {}) {
  return normalizeSocksProxyUrl(account.proxyUrl || account.socksProxy || account.proxy || '');
}

function normalizeSocksProxyUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const rawProxy = parseHostPortUserPassProxy(text);
  if (rawProxy) return rawProxy;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `socks5://${text}`;
  const normalized = withScheme.replace(/^sock5:\/\//i, 'socks5://');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('Invalid SOCKS5 proxy URL.');
  }
  if (!['socks5:', 'socks5h:'].includes(url.protocol)) {
    throw new Error('Only socks5:// and socks5h:// proxies are supported.');
  }
  if (!url.hostname) throw new Error('SOCKS5 proxy host is required.');
  if (!url.port) url.port = '1080';
  return url.toString();
}

function parseHostPortUserPassProxy(value = '') {
  const parts = String(value || '').trim().split(':');
  if (parts.length !== 4) return '';
  const [host, port, username, password] = parts.map((part) => part.trim());
  if (!host || !port || !username || !password || !/^\d{1,5}$/.test(port)) return '';
  const url = new URL(`socks5://${host}:${port}`);
  url.username = username;
  url.password = password;
  return url.toString();
}

async function socksFetch(url, options = {}, proxyUrl = '') {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('SOCKS5 proxy requests only support HTTPS targets.');
  const proxy = new URL(proxyUrl);
  const port = Number(target.port || 443);
  const tunnel = await connectSocks5(proxy, target.hostname, port, options.signal);
  const socket = await connectTls(tunnel, target.hostname, options.signal);
  try {
    const request = buildHttpRequest(target, options);
    const response = await writeAndReadHttpResponse(socket, request, options.signal);
    return response;
  } catch (error) {
    destroySocketQuietly(socket);
    throw error;
  }
}

async function connectSocks5(proxy, targetHost, targetPort, signal) {
  const socket = net.connect({
    host: proxy.hostname,
    port: Number(proxy.port || 1080)
  });
  const abort = () => destroySocketQuietly(socket);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    await waitForSocket(socket, 'connect', signal);
    const username = decodeURIComponent(proxy.username || '');
    const password = decodeURIComponent(proxy.password || '');
    const methods = username || password ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));

    const greeting = await readExact(socket, 2, signal);
    if (greeting[0] !== 0x05 || greeting[1] === 0xff) throw new Error('SOCKS5 proxy rejected authentication methods.');
    if (greeting[1] === 0x02) await authenticateSocks5(socket, username, password, signal);
    if (greeting[1] !== 0x00 && greeting[1] !== 0x02) throw new Error(`SOCKS5 proxy selected unsupported auth method ${greeting[1]}.`);

    socket.write(buildSocks5ConnectRequest(targetHost, targetPort));
    const header = await readExact(socket, 4, signal);
    if (header[0] !== 0x05) throw new Error('Invalid SOCKS5 proxy response.');
    if (header[1] !== 0x00) throw new Error(`SOCKS5 proxy connect failed with code ${header[1]}.`);
    const addressLength = socks5AddressLength(header[3], socket, signal);
    await addressLength;
    signal?.removeEventListener('abort', abort);
    return socket;
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    destroySocketQuietly(socket);
    throw error;
  }
}

async function authenticateSocks5(socket, username, password, signal) {
  const user = Buffer.from(username, 'utf8');
  const pass = Buffer.from(password, 'utf8');
  if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 proxy username/password is too long.');
  socket.write(Buffer.concat([
    Buffer.from([0x01, user.length]),
    user,
    Buffer.from([pass.length]),
    pass
  ]));
  const response = await readExact(socket, 2, signal);
  if (response[1] !== 0x00) throw new Error('SOCKS5 proxy authentication failed.');
}

function buildSocks5ConnectRequest(host, port) {
  const hostBuffer = Buffer.from(host, 'utf8');
  if (hostBuffer.length > 255) throw new Error('Target host is too long for SOCKS5.');
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuffer.length]),
    hostBuffer,
    Buffer.from([(port >> 8) & 0xff, port & 0xff])
  ]);
}

async function socks5AddressLength(type, socket, signal) {
  if (type === 0x01) {
    await readExact(socket, 4 + 2, signal);
    return;
  }
  if (type === 0x03) {
    const length = await readExact(socket, 1, signal);
    await readExact(socket, length[0] + 2, signal);
    return;
  }
  if (type === 0x04) {
    await readExact(socket, 16 + 2, signal);
    return;
  }
  throw new Error(`Unsupported SOCKS5 address type ${type}.`);
}

async function connectTls(tunnel, host, signal) {
  const socket = tls.connect({
    socket: tunnel,
    servername: host,
    ALPNProtocols: ['http/1.1']
  });
  await waitForSocket(socket, 'secureConnect', signal);
  return socket;
}

function buildHttpRequest(target, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body === undefined || options.body === null ? Buffer.alloc(0) : Buffer.from(String(options.body));
  const headers = new Map();
  Object.entries(options.headers || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) headers.set(key.toLowerCase(), String(value));
  });
  headers.set('host', target.host);
  headers.set('connection', 'close');
  if (body.length && !headers.has('content-length')) headers.set('content-length', String(body.length));

  const path = `${target.pathname || '/'}${target.search || ''}`;
  const headerLines = [`${method} ${path} HTTP/1.1`];
  headers.forEach((value, key) => headerLines.push(`${key}: ${value}`));
  return Buffer.concat([
    Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n`, 'utf8'),
    body
  ]);
}

function writeAndReadHttpResponse(socket, request, signal) {
  return new Promise((resolve, reject) => {
    let headerBuffer = Buffer.alloc(0);
    let responseResolved = false;
    let bodyClosed = false;
    let bodyController = null;
    let chunkedDecoder = null;
    let contentLength = 0;
    let receivedBodyBytes = 0;
    const abort = () => rejectAndClose(abortError(signal?.reason));
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const body = new ReadableStream({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        cleanup();
        destroySocketQuietly(socket);
      }
    });
    const closeBody = () => {
      if (bodyClosed) return;
      bodyClosed = true;
      cleanup();
      try {
        bodyController?.close();
      } catch {}
      destroySocketQuietly(socket);
    };
    const errorBody = (error) => {
      if (bodyClosed) return;
      bodyClosed = true;
      cleanup();
      try {
        bodyController?.error(error);
      } catch {}
    };
    const enqueueBody = (chunk) => {
      if (!chunk?.length || bodyClosed) return;
      const copy = Buffer.from(chunk);
      bodyController?.enqueue(copy);
    };
    const rejectAndClose = (error) => {
      cleanup();
      destroySocketQuietly(socket);
      if (responseResolved) errorBody(error);
      else reject(error);
    };
    const onData = (chunk) => {
      try {
        if (!responseResolved) {
          headerBuffer = Buffer.concat([headerBuffer, chunk]);
          const headerEnd = headerBuffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          const response = openHttpResponseFromHeader(headerBuffer.slice(0, headerEnd), body);
          contentLength = Number(response.headers.get('content-length') || 0);
          if (/chunked/i.test(response.headers.get('transfer-encoding') || '')) {
            chunkedDecoder = createChunkedBodyDecoder(enqueueBody, closeBody);
          }
          responseResolved = true;
          resolve(response);
          const rest = headerBuffer.slice(headerEnd + 4);
          headerBuffer = Buffer.alloc(0);
          if (rest.length) handleBodyChunk(rest);
          return;
        }
        handleBodyChunk(chunk);
      } catch (error) {
        rejectAndClose(error);
      }
    };
    const onEnd = () => {
      if (!responseResolved) {
        cleanup();
        try {
          resolve(parseHttpResponse(headerBuffer));
        } catch (error) {
          reject(error);
        }
        return;
      }
      try {
        chunkedDecoder?.finish();
        closeBody();
      } catch (error) {
        errorBody(error);
      }
    };
    const onError = (error) => rejectAndClose(error);
    const handleBodyChunk = (chunk) => {
      if (chunkedDecoder) {
        chunkedDecoder.push(chunk);
        return;
      }
      if (contentLength > 0) {
        const remaining = contentLength - receivedBodyBytes;
        if (remaining <= 0) return;
        const next = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
        receivedBodyBytes += next.length;
        enqueueBody(next);
        if (receivedBodyBytes >= contentLength) closeBody();
        return;
      }
      enqueueBody(chunk);
    };

    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.write(request, (error) => {
      if (error) rejectAndClose(error);
    });
  });
}

function openHttpResponseFromHeader(headerBuffer, body) {
  const headerText = headerBuffer.toString('latin1');
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const status = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] || 0);
  if (!status) throw new Error('Invalid HTTP status from NovelAI.');
  const headers = new Map();
  headerLines.forEach((line) => {
    const index = line.indexOf(':');
    if (index <= 0) return;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
  });

  let bodyUsed = false;
  const consumeBody = async () => {
    if (bodyUsed || body.locked) throw new Error('NovelAI response body has already been consumed.');
    bodyUsed = true;
    return collectReadableStream(body);
  };

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers.get(String(name || '').toLowerCase()) || '';
      }
    },
    body,
    get bodyUsed() {
      return bodyUsed || body.locked;
    },
    async arrayBuffer() {
      return consumeBody();
    },
    async text() {
      return (await consumeBody()).toString('utf8');
    }
  };
}

function createChunkedBodyDecoder(enqueue, close) {
  let buffer = Buffer.alloc(0);
  let done = false;
  return {
    push(chunk) {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) return;
        const sizeText = buffer.slice(0, lineEnd).toString('latin1').split(';')[0].trim();
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size) || size < 0) throw new Error('Invalid chunked NovelAI response.');
        const dataStart = lineEnd + 2;
        const dataEnd = dataStart + size;
        if (buffer.length < dataEnd + 2) return;
        if (size === 0) {
          done = true;
          buffer = Buffer.alloc(0);
          close();
          return;
        }
        enqueue(buffer.slice(dataStart, dataEnd));
        buffer = buffer.slice(dataEnd + 2);
      }
    },
    finish() {
      if (!done && buffer.length) throw new Error('Truncated chunked NovelAI response.');
    }
  };
}

async function collectReadableStream(body) {
  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, totalBytes);
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    totalBytes += chunk.length;
  }
}

function parseHttpResponse(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    const preview = buffer.length ? buffer.slice(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.') : 'empty response';
    throw new Error(`Invalid HTTP response from NovelAI via SOCKS5 proxy: ${preview}`);
  }
  const headerText = buffer.slice(0, headerEnd).toString('latin1');
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const status = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] || 0);
  if (!status) throw new Error('Invalid HTTP status from NovelAI.');
  const headers = new Map();
  headerLines.forEach((line) => {
    const index = line.indexOf(':');
    if (index <= 0) return;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
  });

  let body = buffer.slice(headerEnd + 4);
  if (/chunked/i.test(headers.get('transfer-encoding') || '')) body = decodeChunkedBody(body);
  const contentLength = Number(headers.get('content-length') || 0);
  if (contentLength > 0 && body.length > contentLength) body = body.slice(0, contentLength);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers.get(String(name || '').toLowerCase()) || '';
      }
    },
    async arrayBuffer() {
      return body;
    },
    async text() {
      return body.toString('utf8');
    }
  };
}

export const __providerInternals = {
  openHttpResponseFromHeader
};

function decodeChunkedBody(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) throw new Error('Invalid chunked response from NovelAI.');
    const sizeText = buffer.slice(offset, lineEnd).toString('latin1').split(';')[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) throw new Error('Invalid chunk size from NovelAI.');
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function waitForSocket(socket, event, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      socket.off(event, onReady);
      socket.off('error', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      destroySocketQuietly(socket);
      reject(abortError(signal?.reason));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once(event, onReady);
    socket.once('error', onError);
  });
}

function readExact(socket, length, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      socket.off('readable', onReadable);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const finish = () => {
      cleanup();
      resolve(Buffer.concat(chunks, length));
    };
    const onReadable = () => {
      let chunk;
      while (total < length && (chunk = socket.read(length - total)) !== null) {
        chunks.push(chunk);
        total += chunk.length;
      }
      if (total >= length) finish();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('SOCKS5 proxy closed the connection early.'));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      destroySocketQuietly(socket);
      reject(abortError(signal?.reason));
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('readable', onReadable);
    socket.once('end', onEnd);
    socket.once('error', onError);
    onReadable();
  });
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function destroySocketQuietly(socket) {
  if (!socket || socket.destroyed) return;
  socket.once('error', noop);
  socket.destroy();
}

function noop() {}

function buildNovelAiParameters(request) {
  // 原生入口已验证单图参数，保留角色提示词等官方字段，不改写为聊天模板。
  if (request.nativeParameters) {
    const parameters = structuredClone(request.nativeParameters);
    delete parameters.stream;
    return { ...parameters, width: request.width, height: request.height, steps: request.steps,
      seed: request.seed, n_samples: 1 };
  }
  if (isModernImageModel(request.model)) {
    return buildV4Parameters(request);
  }

  return {
    width: request.width,
    height: request.height,
    scale: request.scale,
    cfg_rescale: request.cfg,
    sampler: request.sampler,
    steps: request.steps,
    seed: request.seed,
    n_samples: 1,
    ucPreset: 0,
    qualityToggle: true,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    noise_schedule: request.noiseSchedule,
    negative_prompt: request.negative
  };
}

function buildV4Parameters(request) {
  return {
    params_version: 3,
    width: request.width,
    height: request.height,
    scale: request.scale,
    steps: request.steps,
    uncond_scale: 0.00001,
    cfg_rescale: request.cfg,
    seed: request.seed,
    n_samples: 1,
    noise_schedule: request.noiseSchedule,
    legacy_v3_extend: false,
    reference_image_multiple: [],
    reference_information_extracted_multiple: [],
    reference_strength_multiple: [],
    v4_prompt: {
      caption: {
        base_caption: request.prompt,
        char_captions: []
      },
      use_coords: false,
      use_order: true,
      legacy_uc: false
    },
    v4_negative_prompt: {
      caption: {
        base_caption: request.negative,
        char_captions: []
      },
      use_coords: false,
      use_order: false,
      legacy_uc: false
    },
    negative_prompt: request.negative,
    uc: request.negative,
    sampler: normalizeV4Sampler(request.sampler),
    controlnet_strength: 1,
    controlnet_model: null,
    dynamic_thresholding: false,
    dynamic_thresholding_percentile: 0.999,
    dynamic_thresholding_mimic_scale: 10,
    sm: false,
    sm_dyn: false,
    skip_cfg_above_sigma: null,
    skip_cfg_below_sigma: 0,
    lora_unet_weights: null,
    lora_clip_weights: null,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
    cfg_sched_eligibility: 'enable_for_post_summer_samplers',
    explike_fine_detail: false,
    minimize_sigma_inf: false,
    uncond_per_vibe: true,
    wonky_vibe_correlation: true,
    image_format: 'png',
    version: 1
  };
}

function novelAiCorrelationId() {
  return Math.random().toString(36).slice(2, 8);
}

function shouldUseNovelAiStream(request, env = {}, options = {}) {
  if (options.forceStream === true) return isModernImageModel(request.model);
  if (options.forceStream === false) return false;
  if (String(env.NOVELAI_STREAM_IMAGE || '').toLowerCase() === 'false') return false;
  return isModernImageModel(request.model);
}

function isModernImageModel(model) {
  return /^nai-diffusion-(?:4|5)/.test(String(model || ''));
}

function normalizeV4Sampler(sampler) {
  const supported = new Set([
    'k_euler',
    'k_euler_ancestral',
    'k_dpm_2',
    'k_dpm_fast',
    'k_dpmpp_2m',
    'k_dpmpp_2m_sde',
    'k_dpmpp_3m_sde',
    'k_dpmpp_sde',
    'k_dpmpp_2s_ancestral'
  ]);
  return supported.has(sampler) ? sampler : 'k_euler_ancestral';
}

async function extractFinalImageFromNovelAiReadableStream(readable, context = {}) {
  const reader = readable.getReader();
  const state = createNovelAiStreamState(context);
  let pending = Buffer.alloc(0);

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    pending = Buffer.concat([pending, Buffer.from(value)]);
    let offset = 0;

    while (offset + 4 <= pending.length) {
      const length = pending.readUInt32BE(offset);
      if (length <= 0) throw invalidNovelAiStreamFrameError(pending, offset);
      if (offset + 4 + length > pending.length) break;
      offset += 4;
      handleNovelAiStreamEvent(decodeMsgpack(pending.slice(offset, offset + length)), state);
      offset += length;
    }

    if (offset > 0) pending = pending.slice(offset);
    if (pending.length > 64 * 1024 * 1024) throw invalidNovelAiStreamFrameError(pending, 0);
  }

  if (pending.length) throw invalidNovelAiStreamFrameError(pending, 0);
  return finalNovelAiStreamImage(state);
}

function extractFinalImageFromNovelAiStream(buffer, context = {}) {
  const state = createNovelAiStreamState(context);
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    if (length <= 0 || offset + length > buffer.length) {
      throw invalidNovelAiStreamFrameError(buffer, offset - 4);
    }

    const event = decodeMsgpack(buffer.slice(offset, offset + length));
    offset += length;
    handleNovelAiStreamEvent(event, state);
  }

  return finalNovelAiStreamImage(state);
}

function createNovelAiStreamState(context = {}) {
  return {
    finalImage: null,
    lastImage: null,
    errors: [],
    intermediateCount: 0,
    lastPercent: 0,
    request: context.request || {},
    onProgress: typeof context.onProgress === 'function' ? context.onProgress : null
  };
}

function handleNovelAiStreamEvent(event, state) {
  const eventType = event?.event_type;

  if (eventType === 'error') {
    state.errors.push(String(event.message || 'unknown stream error'));
    return;
  }

  if (eventType === 'intermediate') {
    state.intermediateCount += 1;
    if (event.image) state.lastImage = Buffer.from(event.image);
    emitNovelAiStreamProgress(event, state, false);
    return;
  }

  if (eventType === 'final') {
    if (event.image) state.finalImage = Buffer.from(event.image);
    emitNovelAiStreamProgress(event, state, true);
  }
}

function emitNovelAiStreamProgress(event, state, isFinal) {
  if (!state.onProgress) return;
  const progress = normalizeNovelAiStreamProgress(event, state, isFinal);
  if (!isFinal && progress.percent <= state.lastPercent) return;
  state.lastPercent = progress.percent;
  state.onProgress({
    ...progress,
    ...(!isFinal && state.lastImage ? {
      previewBuffer: state.lastImage,
      previewMimeType: imageMimeType(state.lastImage)
    } : {})
  });
}

function normalizeNovelAiStreamProgress(event, state, isFinal) {
  const total = positiveNumber(
    event?.total_steps,
    event?.totalSteps,
    event?.n_steps,
    event?.steps,
    state.request?.steps
  ) || 0;
  const explicitProgress = finiteNumber(
    event?.progress,
    event?.percentage,
    event?.percent
  );
  const step = positiveNumber(
    Number.isInteger(event?.step_ix) && event.step_ix >= 0 ? event.step_ix + 1 : null,
    event?.step,
    event?.step_index,
    event?.current_step,
    event?.currentStep,
    event?.sampling_step,
    event?.index,
    state.intermediateCount
  ) || 0;
  let percent = 0;

  if (isFinal) {
    percent = 100;
  } else if (explicitProgress !== null) {
    percent = explicitProgress <= 1 ? explicitProgress * 100 : explicitProgress;
  } else if (step && total) {
    percent = (step / total) * 100;
  }

  percent = Math.max(state.lastPercent, Math.min(isFinal ? 100 : 98, Math.max(0, percent)));
  return {
    percent: Math.round(percent),
    step: total ? Math.max(0, Math.min(total, Math.round(step))) : Math.round(step || 0),
    total,
    eventType: event?.event_type || '',
    updatedAt: new Date().toISOString()
  };
}

function finalNovelAiStreamImage(state) {
  const image = state.finalImage || state.lastImage;
  if (image) {
    return {
      mimeType: imageMimeType(image),
      buffer: image
    };
  }

  if (state.errors.length) throw new Error(`NovelAI stream error: ${state.errors.at(-1)}`);
  throw new Error('NovelAI stream ended without a final image.');
}

function invalidNovelAiStreamFrameError(buffer, offset) {
  const preview = buffer.slice(Math.max(0, offset), Math.min(buffer.length, offset + 80)).toString('latin1');
  return new Error(`Invalid NovelAI msgpack stream frame: ${preview.replace(/[^\x20-\x7e]/g, '.')}`);
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function positiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function decodeMsgpack(buffer) {
  const reader = {
    offset: 0,
    read(length) {
      if (this.offset + length > buffer.length) throw new Error('Invalid NovelAI msgpack payload.');
      const chunk = buffer.slice(this.offset, this.offset + length);
      this.offset += length;
      return chunk;
    },
    byte() {
      return this.read(1)[0];
    }
  };

  return readMsgpackValue(reader);
}

function readMsgpackValue(reader) {
  const marker = reader.byte();

  if (marker <= 0x7f) return marker;
  if (marker >= 0xe0) return marker - 0x100;
  if ((marker & 0xf0) === 0x80) return readMsgpackMap(reader, marker & 0x0f);
  if ((marker & 0xf0) === 0x90) return readMsgpackArray(reader, marker & 0x0f);
  if ((marker & 0xe0) === 0xa0) return reader.read(marker & 0x1f).toString('utf8');

  switch (marker) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return reader.read(reader.byte());
    case 0xc5: return reader.read(reader.read(2).readUInt16BE(0));
    case 0xc6: return reader.read(reader.read(4).readUInt32BE(0));
    case 0xca: return reader.read(4).readFloatBE(0);
    case 0xcb: return reader.read(8).readDoubleBE(0);
    case 0xcc: return reader.byte();
    case 0xcd: return reader.read(2).readUInt16BE(0);
    case 0xce: return reader.read(4).readUInt32BE(0);
    case 0xcf: return numberFromBigInt(reader.read(8).readBigUInt64BE(0));
    case 0xd0: return reader.read(1).readInt8(0);
    case 0xd1: return reader.read(2).readInt16BE(0);
    case 0xd2: return reader.read(4).readInt32BE(0);
    case 0xd3: return numberFromBigInt(reader.read(8).readBigInt64BE(0));
    case 0xd9: return reader.read(reader.byte()).toString('utf8');
    case 0xda: return reader.read(reader.read(2).readUInt16BE(0)).toString('utf8');
    case 0xdb: return reader.read(reader.read(4).readUInt32BE(0)).toString('utf8');
    case 0xdc: return readMsgpackArray(reader, reader.read(2).readUInt16BE(0));
    case 0xdd: return readMsgpackArray(reader, reader.read(4).readUInt32BE(0));
    case 0xde: return readMsgpackMap(reader, reader.read(2).readUInt16BE(0));
    case 0xdf: return readMsgpackMap(reader, reader.read(4).readUInt32BE(0));
    default:
      throw new Error(`Unsupported NovelAI msgpack marker 0x${marker.toString(16)}.`);
  }
}

function readMsgpackArray(reader, length) {
  const value = [];
  for (let index = 0; index < length; index += 1) {
    value.push(readMsgpackValue(reader));
  }
  return value;
}

function readMsgpackMap(reader, length) {
  const value = {};
  for (let index = 0; index < length; index += 1) {
    const key = readMsgpackValue(reader);
    value[String(key)] = readMsgpackValue(reader);
  }
  return value;
}

function numberFromBigInt(value) {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value);
  }
  return value;
}

function imageMimeType(buffer) {
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return 'image/png';
}

export function generateMockImage(request, message = 'Mock NovelAI preview') {
  const width = Number(request.width) || 832;
  const height = Number(request.height) || 1216;
  const prompt = String(request.tag || request.prompt || 'NovelAI image');
  const hue = hashString(`${prompt}:${request.seed}`) % 360;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 86%, 78%)"/>
      <stop offset="50%" stop-color="hsl(${(hue + 55) % 360}, 90%, 86%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 175) % 360}, 82%, 78%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect x="7%" y="68%" width="86%" height="20%" rx="24" fill="rgba(255,255,255,.78)"/>
  <text x="10%" y="75%" font-family="Arial, sans-serif" font-size="32" font-weight="700" fill="#19202a">${escapeXml(message)}</text>
  <text x="10%" y="81%" font-family="Arial, sans-serif" font-size="22" fill="#475467">${escapeXml(prompt.slice(0, 88))}</text>
  <text x="10%" y="86%" font-family="Arial, sans-serif" font-size="18" fill="#667085">${width}x${height} · seed ${escapeXml(request.seed ?? '')}</text>
</svg>`;
  return {
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(svg),
    mock: true
  };
}

export function buildErrorImage(message) {
  return generateMockImage({ tag: message, width: 900, height: 480, seed: 0 }, '生成失败');
}

function extractFirstImageFromZip(buffer) {
  const entries = readZipCentralDirectory(buffer);
  for (const entry of entries) {
    const lowerName = entry.fileName.toLowerCase();
    const isImage = lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || !entry.fileName.includes('.');
    if (!isImage) continue;

    if (buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) continue;
    const fileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    const compressed = buffer.slice(dataStart, dataEnd);
    const image = entry.method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    return {
      mimeType: lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
      buffer: image
    };
  }
  throw new Error('No image file found in NovelAI ZIP response.');
}

function readZipCentralDirectory(buffer) {
  const maxCommentLength = 0xffff;
  const searchStart = Math.max(0, buffer.length - maxCommentLength - 22);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('ZIP end of central directory not found.');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    entries.push({ method, compressedSize, fileName, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeDataUrl(value) {
  const text = String(value);
  const match = text.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64')
    };
  }
  return {
    mimeType: 'image/png',
    buffer: Buffer.from(text, 'base64')
  };
}

function looksLikeZip(buffer) {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}
