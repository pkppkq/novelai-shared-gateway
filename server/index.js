import { sharedSurface } from './shared-surface.js';
import { handleMemberRoutes } from './member-routes.js';
import { configureFairQuota, syncFairQuota, reserveFairQuota, settleFairQuota, fairQuotaSummary, quoteFairRequest } from './fair-quota.js';
import http from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { JobPreviews } from './job-previews.js';
import { isOfficialKey, officialKeyOwner, officialKeyError, OfficialKeyJobs } from './official-key-jobs.js';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, MAX_CACHE_IMAGES_LIMIT, createId, createPublicToken, defaultArtist2_5D, hashObject, legacyDefaultArtist, maskToken, normalizeDb } from './store.js';
import { MAX_STEPS, DIRECT_URL_MAX_STEPS, buildErrorImage, fetchNovelAiAccountQuota, generateNovelAiImage, normalizeNovelAiRequest } from './providers.js';
import { generationPrice, sizeMap } from '../public/generation-pricing.js';
import { adminPromptApiConfig, convertChinesePrompt, fetchPromptApiModels, isPromptApiConfigured, normalizePromptApiConfig, publicPromptApiConfig } from './prompt-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const imageDir = path.join(dataDir, 'images');
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
if (adminToken.length < 32 || /^(change|replace|example)/i.test(adminToken)) throw new Error('请设置至少 32 位随机 ADMIN_TOKEN');
// 公开发行版始终采用共享账户与鉴权模式，空库也不开放注册或自动模拟。
process.env.FAIR_SHARE_MODE = 'true';
process.env.PRIVATE_MODE = 'true';
process.env.PUBLIC_MODE = 'true';
process.env.NO_AUTO_DELETE = 'true';
process.env.MOCK_WHEN_NO_ACCOUNT = 'false';
const store = new JsonStore(dataDir);
const fairShareMode = process.env.FAIR_SHARE_MODE === 'true';
// 公平账本和任务状态必须同步落盘，不能使用延迟写入。
if (fairShareMode) {
  const update = store.update.bind(store);
  store.update = (mutator, options = {}) => update(mutator, { ...options, includeSettings: true, immediate: true });
}
let queueDrainTimer = null;
let queueDrainAt = 0;
let queueDraining = false;
let queueDrainRequested = false;
let accountQuotaRefreshTimer = null;
let accountQuotaRefreshPromise = null;
let accountQuotaAutoRefreshStarted = false;
const jobWaiters = new Map();
const runningJobControls = new Map();
const directGenerateTimeoutMs = Number(process.env.DIRECT_GENERATE_TIMEOUT_MS || 60_000);
const openAiChatTimeoutMs = Number(process.env.OPENAI_CHAT_TIMEOUT_MS || 10 * 60_000);
const openAiQueuePollMs = 650;
const openAiFixedSteps = 28;
const jobStreamProgress = new Map();
const jobPreviews = new JobPreviews();
const officialJobs = new OfficialKeyJobs({
  generate: (request, account, options) => generateNovelAiImage(request, account, process.env, options),
  saveImage: saveOfficialImage,
  findImage: cacheKey => store.findImageByCacheKey(cacheKey),
  previews: jobPreviews
});
const jobStreamProgressPersistState = new Map();
const beijingOffsetMs = 8 * 60 * 60 * 1000;
const usageChartDays = 7;
const errorLogRetentionMs = usageChartDays * 24 * 60 * 60 * 1000;
const accountQuotaRefreshIntervalMs = fairShareMode ? 60 * 1000 : 5 * 60 * 1000;
const accountQuotaRequestTimeoutMs = 15 * 1000;
const openAiSamplers = [
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde'
];
const openAiImageModels = [
  { id: 'nai-diffusion-4-5-full', cost: 1 },
  { id: 'nai-diffusion-5-full', cost: 8 }
];
const openAiSizeTiers = {
  '2K': {
    label: '[2K]',
    sizes: {
      '竖图': sizeMap['2K竖图'],
      '横图': sizeMap['2K横图'],
      '方图': sizeMap['2K方图']
    }
  },
  '4K': {
    label: '[4K]',
    sizes: {
      '竖图': sizeMap['4K竖图'],
      '横图': sizeMap['4K横图'],
      '方图': sizeMap['4K方图']
    }
  }
};
const insufficientBalanceMessage = '密钥额度不足，无法生成图片。';

installRuntimeSafetyHandlers();
await store.init();
await cleanupInterruptedStartupJobs();
await cleanupStaleActiveJobs('startup');
await mkdir(imageDir, { recursive: true });
await migrateInlineImages();
await ensureAccountRouteIds();
await applyRuntimeSettings();
await cleanupImageStorage().catch((error) => console.error('Failed to cleanup image storage:', error));

const server = http.createServer(async (req, res) => {
  // PRIVATE_ACCESS_GUARD
  // 私有服务只接受本机隧道入口，阻断跨站请求与域名重绑定。
  if (process.env.PRIVATE_MODE === 'true') {
    const requestHost = String(req.headers.host || '').toLowerCase();
    const origin = req.headers.origin;
    const hostAllowed = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(requestHost) || (process.env.PUBLIC_MODE === 'true' && requestHost === process.env.PUBLIC_HOST);
    // 公网插件允许跨域；实际业务仍由网关 Key 鉴权，管理接口保留隔离。
    const publicClient = process.env.PUBLIC_MODE === 'true' && requestHost === process.env.PUBLIC_HOST
      && !/^\/(?:api\/admin|admin|memory)(?:[/?]|$)/.test(req.url || '/');
    const originAllowed = publicClient || !origin || origin === `http://${requestHost}` || origin === `https://${requestHost}`;
    if (!hostAllowed || !originAllowed || (!publicClient && req.headers['sec-fetch-site'] === 'cross-site')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Private access only');
      return;
    }
  }
  try {
    await route(req, res);
  } catch (error) {
    if (req.url?.startsWith('/generate') && !(process.env.PUBLIC_MODE === 'true' && [401, 403].includes(error.statusCode))) {
      const image = buildErrorImage(publicErrorMessage(error.message || 'Generation failed'));
      sendImage(res, 200, image.mimeType, image.buffer, { 'x-error': '1' });
      return;
    }
    if (['/ai/generate-image', '/v1/ai/generate-image'].includes(String(req.url || '').split('?')[0])) {
      const message = publicErrorMessage(error.message || 'Internal server error');
      sendJson(res, error.statusCode || 500, { message, error: message });
      return;
    }
    if (req.url?.startsWith('/v1/')) {
      sendOpenAiError(res, error.statusCode || 500, publicErrorMessage(error.message || 'Internal server error'), openAiErrorType(error));
      return;
    }
    sendJson(res, error.statusCode || 500, { error: publicErrorMessage(error.message || 'Internal server error') });
  }
});

server.listen(port, host, () => {
  console.log(`Nai2API listening on http://${host}:${port}`);
  startAccountQuotaAutoRefresh();
  logStartupQueueState().catch((error) => console.error('[runtime] failed to inspect startup queue:', error)).finally(() => {
    scheduleQueueDrain();
  });
});
installShutdownHandlers(server);

async function applyRuntimeSettings() {
  const publicBaseUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || '');
  await store.update((db) => {
    if (publicBaseUrl && !db.settings.publicBaseUrl) db.settings.publicBaseUrl = publicBaseUrl;
    if (!db.settings.defaultArtist || db.settings.defaultArtist === legacyDefaultArtist) {
      db.settings.defaultArtist = defaultArtist2_5D;
    }
  }, { collections: ['settings'] });
}

async function migrateInlineImages() {
  if (store.hasPartialCollection('images')) {
    console.log('[runtime] skipped inline image migration because image cache is partially loaded');
    return;
  }
  const startedAt = Date.now();
  let migrated = 0;
  migrated = await store.update(async (db) => {
    for (const image of db.images) {
      if (!image.base64 || image.file) continue;
      const imageFile = imageStorageName(image.id, image.mimeType);
      try {
        await writeFile(path.join(dataDir, imageFile), Buffer.from(image.base64, 'base64'));
        image.file = imageFile;
        delete image.base64;
        migrated += 1;
      } catch (error) {
        console.error(`Failed to migrate cached image ${image.id}:`, error);
      }
    }
    return migrated;
  }, { collections: ['images'], shouldPersist: (count) => Number(count || 0) > 0 });
  if (migrated) console.log(`[runtime] migrated ${migrated} inline image(s) in ${Date.now() - startedAt}ms`);
}


// PUBLIC_SELF_USE_GUARD
// 图片签名使用进程随机密钥；重启失效，不暴露账户或网关密钥。
const publicImageSecret = randomBytes(32);
function publicImageMac(pathname, expires) {
  return createHmac('sha256', publicImageSecret).update(`${pathname}\n${expires}`).digest('hex');
}
function publicImageUrl(id) {
  const pathname = `/api/images/${encodeURIComponent(id)}/content`;
  if (process.env.PUBLIC_MODE !== 'true') return pathname;
  const expires = String(Math.floor(Date.now() / 1000) + 900);
  return `${pathname}?expires=${expires}&signature=${publicImageMac(pathname, expires)}`;
}
function validPublicImageSignature(url) {
  if (!/^\/api\/images\/[^/]+\/content$/.test(url.pathname)) return false;
  const expires = url.searchParams.get('expires') || '';
  const signature = url.searchParams.get('signature') || '';
  if (!/^\d{10}$/.test(expires) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Number(expires) < now || Number(expires) > now + 900) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(publicImageMac(url.pathname, expires), 'hex'));
}
async function publicSelfUseGuard(req, res, url, method) {
  if (process.env.PUBLIC_MODE !== 'true' || method === 'OPTIONS') return false;
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 禁止卡密开户、余额合并、旧兼容接口，管理员仍可经私有隧道管理。
  if (['/api/redeem', '/api/me/merge', '/api/api/getUser'].includes(url.pathname)) {
    throw httpError(403, 'Self-service registration and merging are disabled.');
  }
  // 健康检查仅返回布尔状态，不公开账户数量或管理员配置。
  if (url.pathname === '/api/health' && ['GET', 'HEAD'].includes(method)) {
    // 本机隧道和容器健康检查保持原有返回，公网代理禁止该路径。
    if (/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(String(req.headers.host || ''))) return false;
    if (method === 'HEAD') sendHead(res, 200, { 'content-type': 'application/json; charset=utf-8' });
    else sendJson(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/settings' && method === 'GET') {
    const settings = await store.readSettings();
    sendJson(res, 200, { defaultModel: settings.defaultModel, defaultNegative: settings.defaultNegative, defaults: settings.defaults });
    return true;
  }
  const protectedPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/ai/') || ['/generate', '/memory'].includes(url.pathname);
  if (!protectedPath) return false;
  // 公网管理员仅接受请求头；反向代理另外隔离所有管理路由。
  if (adminToken && req.headers['x-admin-token'] === adminToken) return false;
  if (method === 'GET' && validPublicImageSignature(url)) return false;
  let bodyToken = '';
  if (method === 'POST' && ['/api/jobs', '/api/web/jobs', '/api/prompt/convert'].includes(url.pathname)) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) throw httpError(413, 'Request body too large.');
      chunks.push(chunk);
    }
    try { req.publicParsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw httpError(400, 'invalid JSON body.'); }
    if (!req.publicParsedBody || typeof req.publicParsedBody !== 'object') throw httpError(400, 'invalid JSON body.');
    bodyToken = String(req.publicParsedBody.token || '').trim();
  }
  const token = bodyToken || tokenFrom(req, url);
  // 官方 pst 密钥不得作为本网站登录凭据，只能由管理员加入上游池。
  if (!token.startsWith('STA1N-')) throw httpError(401, 'Existing gateway key required.');
  const user = await store.readUserByToken(token);
  if (!user || user.enabled === false) throw httpError(401, 'invalid token.');
  return false;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || 'GET';
  if (fairShareMode) {
    const surface = sharedSurface(url.pathname, method);
    if (!surface.allowed) throw httpError(404, 'not found.');
    url.pathname = surface.pathname;
    // 所有管理员别名都只从本机隧道进入，不能绕过代理的路径规则。
    if (/^\/(?:admin|api\/admin)(?:\/|$)/.test(url.pathname) && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || ''))) throw httpError(404, 'not found.');
  }
  if (await handleMemberRoutes(req, res, url, { store, assertAdmin, createId, createPublicToken })) return;
  if (await publicSelfUseGuard(req, res, url, method)) return;

  if (method === 'OPTIONS') {
    sendCorsPreflight(res);
    return;
  }

  if (method === 'HEAD') {
    if (url.pathname === '/api/health') {
      sendHead(res, 200, { 'content-type': 'application/json; charset=utf-8' });
      return;
    }
    await serveStatic(url.pathname, res, { head: true });
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, openAiModelsResponse());
    return;
  }

  if (method === 'POST' && ['/ai/generate-image', '/v1/ai/generate-image'].includes(url.pathname)) {
    await handleNativeImageGeneration(req, res);
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleOpenAiChatCompletion(req, res);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/health') {
    const counts = await store.readCounts();
    sendJson(res, 200, {
      ok: true,
      service: 'Nai2API',
      users: counts.users,
      enabledAccounts: counts.enabledAccounts,
      cards: counts.cards,
      adminConfigured: adminToken !== '123456'
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/me/quota') {
    const quota = await store.update(db => {
      const user = getUserOrThrow(db, tokenFrom(req, url));
      return fairQuotaSummary(db, user);
    }, { collections: ['settings'] });
    sendJson(res, 200, { fairQuota: quota });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/fair-quota') {
    assertAdmin(req, url);
    if (!fairShareMode) throw httpError(409, 'FAIR_SHARE_MODE is disabled.');
    const body = await readJson(req);
    const result = await store.update(db => {
      if (!Array.isArray(body.memberIds) || body.memberIds.some(id => !db.users.some(u => u.id === id && u.enabled !== false))) throw httpError(400, '成员必须是已启用的用户');
      configureFairQuota(db, body.memberIds);
      syncFairQuota(db);
      return { status: db.settings.fairQuota.status, members: body.memberIds, globalConcurrency: 4 };
    }, { collections: ['settings'] });
    sendJson(res, 200, result);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/admin/summary') {
    const startedAt = Date.now();
    assertAdmin(req, url);
    const readStartedAt = Date.now();
    const db = await store.readAdminSummary({ fresh: url.searchParams.get('fresh') === '1' });
    const readMs = Date.now() - readStartedAt;
    resetStaleAccountLoads(db.accounts);
    const revealTokens = url.searchParams.get('revealTokens') === '1';
    const statsJobs = db.statsJobs || db.jobs || [];
    const errorLogJobs = db.errorJobs || statsJobs;
    const computeStartedAt = Date.now();
    const accountStats1h = db.accountStats1h || Object.fromEntries(accountStatsMapSince(statsJobs, 60 * 60 * 1000));
    const payload = {
      settings: adminRuntimeSettings(db.settings),
      userCount: Number(db.userCount || 0),
      accounts: db.accounts.map((account) => publicAccount(account, {
        revealToken: revealTokens,
        stats1h: accountStats1h[account.id] || finalizeStats({})
      })),
      imageCount: db.imageCount ?? 0,
      imageTotal: db.imageCount ?? 0,
      cacheImageCount: db.imageCount ?? 0,
      requestStats1m: db.requestStats1m || requestStatsSince(statsJobs, 60 * 1000),
      generationStats1m: db.generationStats1m || { total: 0 },
      jobStats1h: db.jobStats1h || jobStatsSince(statsJobs, 60 * 60 * 1000),
      generationSpeed1h: db.generationSpeed1h || {
        v45: { seconds: null, count: 0 },
        v5: { seconds: null, count: 0 }
      },
      usageHourlyDays: db.usageHourlyDays || hourlyUsageStatsByDay(statsJobs),
      errorLogs: errorLogs(errorLogJobs, db, 100),
      jobs: db.jobs.slice(0, 50).map((job) => publicJob(job, db))
    };
    const computeMs = Date.now() - computeStartedAt;
    const sendStartedAt = Date.now();
    sendJson(res, 200, payload);
    const sendMs = Date.now() - sendStartedAt;
    runtimeRequestLog('admin summary', startedAt, {
      readMs,
      computeMs,
      sendMs,
      users: db.userCount,
      accounts: db.accounts.length,
      statsRows: db.statsRowsRead ?? statsJobs.length,
      recentJobs: db.jobs.length,
      images: db.imageCount ?? 0
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/admin/ping') {
    assertAdmin(req, url);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/accounts') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const account = await addAccount(body);
    scheduleQueueDrain();
    sendJson(res, 201, publicAccount(account));
    return;
  }

  if (method === 'PATCH' && url.pathname === '/api/admin/accounts') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const accounts = await updateAccounts(body);
    scheduleQueueDrain();
    sendJson(res, 200, { accounts: accounts.map(publicAccount) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/accounts/quota') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const result = await refreshAccountQuotas(body);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'PATCH' && url.pathname.startsWith('/api/admin/accounts/')) {
    assertAdmin(req, url);
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const body = await readJson(req);
    const account = await updateAccount(id, body);
    scheduleQueueDrain();
    sendJson(res, 200, publicAccount(account));
    return;
  }

  if (method === 'POST' && ['/api/jobs', '/api/web/jobs'].includes(url.pathname)) {
    const body = await readJson(req);
    if (body.edit) throw httpError(400, '图片编辑功能已移除，请刷新页面后重试。');
    const token = String(body.token || tokenFrom(req, url) || '');
    if (isOfficialKey(token)) {
      sendJson(res, 202, await createOfficialJob(token, body, url.pathname === '/api/web/jobs'));
      return;
    }
    const job = await createJob(token, body, { frontend: url.pathname === '/api/web/jobs' });
    scheduleQueueDrain();
    const snapshot = await store.findJobContext(job.id);
    sendJson(res, 202, publicJob(snapshot?.job || job, snapshot));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/jobs/events') {
    const token = tokenFrom(req, url);
    if (isOfficialKey(token)) {
      await officialKeyInfo(token);
      jobPreviews.subscribe(officialKeyOwner(token), res);
      return;
    }
    const user = await store.readUserByToken(token);
    if (!user || user.enabled === false) throw httpError(401, 'invalid token.');
    jobPreviews.subscribe(token, res);
    return;
  }

  if (method === 'GET' && /^\/api\/jobs\/[^/]+\/content$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
    const token = tokenFrom(req, url);
    if (id.startsWith('job_pst_')) {
      const job = officialJobs.get(id, token);
      if (job.status !== 'done') throw httpError(409, job.error || 'job is not finished.');
      await sendStoredImage(res, 200, job.image);
      return;
    }
    const snapshot = await store.findJobContext(id);
    const job = snapshot?.job;
    if (!job) throw httpError(404, 'job not found.');
    if (job.userToken !== token && !isAdmin(req, url)) throw httpError(403, 'forbidden.');
    if (job.status === 'done' && job.imageId) {
      const image = await store.findImage(job.imageId);
      if (image) {
        await sendStoredImage(res, 200, image);
        return;
      }
    }
    if (job.status !== 'failed') throw httpError(409, 'job is not finished.');
    const image = buildErrorImage(job.error || 'Generation failed');
    sendImage(res, 200, image.mimeType, image.buffer, { 'x-error': '1' });
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const token = tokenFrom(req, url);
    if (id.startsWith('job_pst_')) {
      sendJson(res, 200, officialJobs.snapshot(officialJobs.get(id, token)));
      return;
    }
    const snapshot = await store.findJobContext(id);
    const job = snapshot?.job;
    if (!job) throw httpError(404, 'job not found.');
    if (job.userToken !== token && !isAdmin(req, url)) throw httpError(403, 'forbidden.');
    sendJson(res, 200, publicJob(job, snapshot));
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/images/')) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
    const image = await store.findImage(id);
    if (!image) throw httpError(404, 'image not found.');
    await sendStoredImage(res, 200, image);
    return;
  }

  if (method === 'GET' && url.pathname === '/generate') {
    await handleDirectGenerate(url, res);
    return;
  }

  if (method === 'GET') {
    await serveStatic(url.pathname, res);
    return;
  }

  throw httpError(404, 'not found.');
}

async function handleDirectGenerate(url, res) {
  const token = String(url.searchParams.get('token') || '').trim();
  const rawParams = Object.fromEntries(url.searchParams.entries());
  if (isOfficialKey(token)) {
    const snapshot = await createOfficialJob(token, rawParams, false, directGenerateTimeoutMs);
    const job = await officialJobs.get(snapshot.id, token).done;
    if (job.status !== 'done') throw httpError(502, job.error);
    await sendStoredImage(res, 200, job.image, {
      'cache-control': 'private, max-age=0', 'x-cache': job.cacheHit ? 'hit' : 'miss', 'x-auth-mode': 'official'
    });
    return;
  }
  const db = await store.readCollections(['settings', 'users']);
  const request = normalizeNovelAiRequest(rawParams, db.settings, { maxSteps: DIRECT_URL_MAX_STEPS });
  const cacheKey = requestCacheKey(token, request, rawParams.seed);
  const nocache = rawParams.nocache === '1' || rawParams.nocache === 'true';

  if (!nocache) {
    const cached = await store.findImageByCacheKey(cacheKey);
    if (cached) {
      try {
        await createDirectJob(token, request, cacheKey, {
          status: 'done',
          accountId: cached.accountId || '',
          imageId: cached.id,
          cost: 0
        });
        await sendStoredImage(res, 200, cached, {
          'x-cache': 'hit',
          'x-balance': String(getUserOrThrow(db, token).balance)
        });
        return;
      } catch (error) {
        console.error(`Cached image ${cached.id} is missing, regenerating:`, error);
      }
    }
  }

  const deadline = Date.now() + directGenerateTimeoutMs;
  let directJob = null;
  try {
    directJob = await createDirectJob(token, request, cacheKey, { deadlineAt: new Date(deadline).toISOString() });
    scheduleQueueDrain();
    const result = await waitForJobResult(directJob.id, deadline);
    if (!result) {
      await timeoutJob(directJob.id);
      sendTimeoutImage(res);
      return;
    }
    if (result.error) throw new Error(result.error);
    await sendStoredImage(res, 200, result.saved, {
      'x-cache': 'miss',
      'x-balance': String(result.balance ?? '')
    });
  } catch (error) {
    if (directJob) {
      if (isInsufficientBalanceError(error)) {
        await removeJob(directJob.id);
      } else {
        await markDirectJobFailed(directJob.id, error.message || 'direct generate failed.');
      }
    }
    if (error.message === 'direct generate timeout') {
      sendTimeoutImage(res);
      return;
    }
    if (isNovelAiCapacityError(error)) {
      sendBusyImage(res);
      return;
    }
    throw error;
  }
}

async function officialKeyInfo(token) {
  officialKeyOwner(token);
  try {
    const quota = await fetchNovelAiAccountQuota(token, process.env, { signal: AbortSignal.timeout(accountQuotaRequestTimeoutMs) });
    return {
      authMode: 'official', balance: null, anlas: quota.points,
      v5RemainingPercent: quota.v5UsageIsNegative ? 0 : quota.v5UsagePercent,
      membership: accountTierText(quota.tier, '会员未知')
    };
  } catch (error) {
    throw officialKeyError(error);
  }
}

async function createOfficialJob(token, body, frontend = false, timeoutMs = novelAiGenerateTimeoutMs()) {
  const owner = officialKeyOwner(token);
  const settings = await store.readSettings();
  const request = normalizeNovelAiRequest({ ...body, cost: undefined }, settings, { maxSteps: frontend ? MAX_STEPS : DIRECT_URL_MAX_STEPS });
  request.steps = Math.floor(request.steps);
  request.cost = 0;
  // Existing site caching is shared; official-key caching must include its owner.
  const cacheKey = hashObject({ owner, request: requestCacheKey('', request, body.seed) });
  return officialJobs.create(token, request, { cacheKey, noCache: isNoCache(body.nocache), timeoutMs });
}

async function saveOfficialImage(job, image) {
  const request = job.request;
  const id = createId('img');
  const file = await writeStoredImage(id, image);
  const saved = {
    id, token: job.owner, accountId: '', authMode: 'official', cacheKey: job.cacheKey,
    prompt: request.tag, fullPrompt: request.prompt, model: request.model,
    width: request.width, height: request.height, requestedSteps: request.requestedSteps ?? request.steps,
    routedSteps: request.steps, cost: 0, accountCost: 0,
    mimeType: image.mimeType, file, createdAt: new Date().toISOString()
  };
  try {
    await store.update(db => { db.images.unshift(saved); }, { collections: ['images'], dirtyRows: () => ({ images: [id] }) });
  } catch (error) {
    await removeStoredImages([saved]);
    throw error;
  }
  const trimmed = await store.trimImageCache(null, { batchSize: imageCacheTrimBuffer() });
  await removeStoredImages(trimmed);
  return saved;
}

// 原生插件不经过聊天模板；在进入扣费队列前验证实际生成参数。
function parseNativeImageRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Expected a JSON object.');
  if ((body.action ?? 'generate') !== 'generate') throw httpError(422, 'Only action=generate is supported; img2img and infill are not supported.');
  if (!['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-5-full'].includes(body.model)) throw httpError(422, 'Unsupported NovelAI model.');
  if (typeof body.input !== 'string' || !body.input.trim()) throw httpError(400, 'input must be a non-empty prompt string.');
  if (!body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters)) throw httpError(400, 'parameters must be an object.');
  const parameters = structuredClone(body.parameters);
  const integer = (name, min, max, fallback) => {
    const value = parameters[name] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw httpError(422, `${name} must be an integer between ${min} and ${max}.`);
    parameters[name] = value;
    return value;
  };
  const width = integer('width', 128, 2048);
  const height = integer('height', 128, 2048);
  const steps = integer('steps', 1, 50);
  integer('n_samples', 1, 1, 1);
  const hasValue = (value) => value !== null && value !== undefined && value !== '' && value !== false && (!Array.isArray(value) || value.length > 0);
  for (const [name, value] of Object.entries(parameters)) {
    if ((/reference.*image|^image$|^mask$|^controlnet_(condition|model)$|^characterRef$/i.test(name)) && hasValue(value)) throw httpError(422, `Parameter ${name} is not supported by this text-to-image gateway.`);
  }
  for (const name of ['scale', 'cfg_rescale']) {
    if (parameters[name] !== undefined && (typeof parameters[name] !== 'number' || !Number.isFinite(parameters[name]))) throw httpError(422, `${name} must be a finite number.`);
  }
  if (parameters.seed !== undefined && (!Number.isSafeInteger(parameters.seed) || parameters.seed < -1)) throw httpError(422, 'seed must be a safe non-negative integer or -1 for random.');
  // 插图8随机种子可超过32位，按模归一化；合法32位种子保持不变。
  if (parameters.seed === undefined || parameters.seed === -1) parameters.seed = randomBytes(4).readUInt32LE(0);
  else parameters.seed %= 4294967296;
  // 插件有时附带 msgpack 标记，但此接口始终返回单张图片 ZIP。
  delete parameters.stream;
  return {
    prompt: body.input, tag: body.input, artist: '', model: body.model,
    negative: parameters.negative_prompt ?? '', width, height, steps, requestedSteps: steps,
    scale: parameters.scale ?? 5, cfg: parameters.cfg_rescale ?? 0,
    sampler: parameters.sampler ?? 'k_dpmpp_2m_sde', noiseSchedule: parameters.noise_schedule ?? 'karras',
    seed: parameters.seed, nativeParameters: parameters, nocache: true
  };
}

// 无压缩 ZIP 保留上游图片原始字节，兼容酒馆插件的 JSZip 读取流程。
function nativeImageZip(buffer, filename = 'image_0.png') {
  const name = Buffer.from(filename, 'utf8');
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(buffer.length, 18); local.writeUInt32LE(buffer.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(buffer.length, 20); central.writeUInt32LE(buffer.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + buffer.length, 16);
  return Buffer.concat([local, name, buffer, central, name, end]);
}

// 仅记录请求结构和生成数值，不记录凭据、提示词、负面词或图片原文。
function nativeRequestDiagnostic(body) {
  const describe = (value) => {
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) return { type: 'array', length: value.length,
      nonEmpty: value.filter(v => v !== null && v !== '' && v !== undefined).length };
    if (typeof value === 'string') return { type: 'string', length: value.length };
    if (typeof value === 'number') return { type: 'number', value: Number.isFinite(value) ? value : 'non-finite' };
    if (typeof value === 'boolean') return { type: 'boolean', value };
    return { type: typeof value };
  };
  const identifier = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
    && !/pst-|sta1n|token|secret|key/i.test(value) ? value : describe(value);
  const parameters = body?.parameters;
  const numeric = {};
  for (const field of ['width','height','steps','n_samples','seed','scale','cfg_rescale']) {
    numeric[field] = describe(parameters?.[field]);
    // 数字字符串保留数值以识别客户端类型问题，其余字符串仅记录长度。
    if (typeof parameters?.[field] === 'string' && /^-?\d+(?:\.\d+)?$/.test(parameters[field]) && parameters[field].length <= 24) numeric[field].numericValue = Number(parameters[field]);
  }
  const structure = {};
  for (const field of ['image','mask','reference_image','reference_image_multiple','director_reference_images','controlnet_condition','controlnet_model','v4_prompt','v4_negative_prompt','characterPrompts','stream']) {
    if (parameters && Object.hasOwn(parameters, field)) structure[field] = describe(parameters[field]);
  }
  return { model: identifier(body?.model), action: identifier(body?.action), prompt: describe(body?.input), numeric, structure };
}

function logNativeDiagnostic(id, event, details) {
  console.warn('[native-diagnostic] ' + JSON.stringify({ time: new Date().toISOString(), id, event, ...details }));
}

async function handleNativeImageGeneration(req, res) {
  const token = bearerToken(req);
  if (!token.startsWith('STA1N-')) throw httpError(401, 'Existing gateway key required.');
  const user = await store.readUserByToken(token);
  if (!user || user.enabled === false) throw httpError(401, 'invalid token.');
  const diagnosticId = randomBytes(8).toString('hex');
  res.setHeader('X-Nai-Diagnostic-Id', diagnosticId);
  res.once?.('finish', () => logNativeDiagnostic(diagnosticId, 'finished', { status: res.statusCode }));
  let body;
  try { body = await readJson(req); }
  catch (error) {
    logNativeDiagnostic(diagnosticId, 'rejected', { status: error.statusCode || 400, reason: 'Invalid JSON request body.' });
    throw error;
  }
  logNativeDiagnostic(diagnosticId, 'received', nativeRequestDiagnostic(body));
  let request;
  try {
    request = parseNativeImageRequest(body);
  } catch (error) {
    // 参数名由请求提供，拒绝日志只保留预定义字段名或固定错误文本。
    const reason = /^Parameter /.test(error.message || '') ? 'Unsupported image/reference parameter.' : String(error.message || 'validation failed').slice(0, 180);
    logNativeDiagnostic(diagnosticId, 'rejected', { status: error.statusCode || 400, reason });
    throw error;
  }
  request.allowPurchasedAnlas = body.allowPurchasedAnlas === true;
  logNativeDiagnostic(diagnosticId, 'validated', { seed: request.seed, width: request.width, height: request.height, steps: request.steps });
  const deadline = Date.now() + openAiChatTimeoutMs;
  const job = await createJob(token, request, { native: true, source: 'novelai-native', deadlineAt: new Date(deadline).toISOString() });
  logNativeDiagnostic(diagnosticId, 'queued', { jobId: job.id });
  const pending = waitForJobResult(job.id, deadline);
  scheduleQueueDrain();
  const result = await pending;
  if (!result) {
    await timeoutJob(job.id);
    throw httpError(504, 'direct generate timeout');
  }
  if (result.error) throw httpError(result.statusCode || (isTimeoutResultMessage(result.error) ? 504 : 500), result.error);
  const image = result.saved;
  const buffer = await readStoredImage(image);
  const archive = nativeImageZip(buffer, `image_0.${imageExtension(image.mimeType || '')}`);
  sendImage(res, 200, 'application/zip', archive, { 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="images.zip"' });
}

async function handleOpenAiChatCompletion(req, res) {
  const token = bearerToken(req);
  if (!token) throw httpError(401, 'missing API key.');
  const body = await readJson(req);
  const settings = await store.readSettings();
  const parsed = parseOpenAiImageRequest(body, settings);
  const deadline = Date.now() + openAiChatTimeoutMs;
  const job = await createJob(token, parsed.request, {
    deadlineAt: new Date(deadline).toISOString(),
    source: 'openai'
  });
  scheduleQueueDrain();

  if (body.stream === true) {
    await streamOpenAiImageJob(req, res, job, parsed.model, deadline);
    return;
  }

  const result = await waitForJobResult(job.id, deadline);
  if (!result) {
    await timeoutJob(job.id);
    throw httpError(504, 'direct generate timeout');
  }
  if (result.error) throw httpError(isTimeoutResultMessage(result.error) ? 504 : 500, result.error);

  sendJson(res, 200, openAiChatCompletionResponse({
    model: parsed.model,
    content: openAiImageMarkdown(req, result.saved),
    id: `chatcmpl-${job.id}`
  }));
}

function openAiModelsResponse() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: [
      ...openAiImageModels.flatMap((model) => openAiSamplers.map((sampler) => ({
        id: `${model.id}:${sampler}`,
        object: 'model',
        created,
        owned_by: 'nai2api',
        cost: model.cost,
        resolution_tier: 'standard'
      }))),
      ...Object.entries(openAiSizeTiers).flatMap(([tierName, tier]) => openAiImageModels.flatMap((model) => openAiSamplers.map((sampler) => ({
        id: `${tier.label}${model.id}:${sampler}`,
        object: 'model',
        created,
        owned_by: 'nai2api',
        cost: generationCost({ model: model.id, ...tier.sizes['竖图'], steps: openAiFixedSteps }),
        cost_by_size: Object.fromEntries(Object.entries(tier.sizes).map(([size, dimensions]) => [
          size, generationCost({ model: model.id, ...dimensions, steps: openAiFixedSteps })
        ])),
        resolution_tier: tierName
      }))))
    ]
  };
}

function parseOpenAiImageRequest(body = {}, settings = {}) {
  const modelParts = parseOpenAiModel(body.model || settings.defaultModel || 'nai-diffusion-4-5-full');
  const messageText = lastUserMessageText(body.messages || []);
  const fields = parseChinesePromptFields(messageText);
  validateOpenAiPromptFormat(fields, messageText);
  const nai = body.nai && typeof body.nai === 'object' ? body.nai : {};
  const prompt = String(nai.tag || nai.prompt || fields.tag || '').trim();
  const negative = String(nai.negative ?? fields.negative ?? '').trim() || settings.defaultNegative || '';
  const sizeName = String(nai.size ?? fields.size ?? settings.defaults?.size ?? '竖图').trim();
  const tierSize = modelParts.tier?.sizes?.[sizeName];

  const request = {
    tag: prompt,
    model: modelParts.model,
    artist: nai.artist ?? fields.artist ?? settings.defaultArtist ?? '',
    size: sizeName,
    width: tierSize?.width ?? nai.width,
    height: tierSize?.height ?? nai.height,
    steps: openAiFixedSteps,
    scale: nai.scale ?? fields.scale ?? settings.defaults?.scale,
    cfg: nai.cfg ?? fields.cfg ?? settings.defaults?.cfg,
    sampler: nai.sampler ?? fields.sampler ?? modelParts.sampler ?? settings.defaults?.sampler,
    negative,
    nocache: nai.nocache ?? body.nocache ?? '1',
    noise_schedule: nai.noise_schedule ?? nai.noiseSchedule ?? settings.defaults?.noiseSchedule ?? 'karras'
  };

  return {
    model: modelParts.original,
    request
  };
}

function validateOpenAiPromptFormat(fields, messageText) {
  const requiredFields = ['tag', 'size', 'scale', 'cfg'];
  const missing = requiredFields.some((key) => !String(fields[key] ?? '').trim());
  const optionalFieldsPresent = Object.hasOwn(fields, 'artist') && Object.hasOwn(fields, 'negative');
  if (missing || !optionalFieldsPresent) throw httpError(400, openAiPromptFormatError());
}

function openAiPromptFormatError() {
  return '请求格式错误，请参考群内使用指南';
}

function parseOpenAiModel(modelValue) {
  const original = String(modelValue || 'nai-diffusion-4-5-full');
  const tierMatch = original.match(/^\[(2K|4K)\]\s*(.+)$/i);
  const tierName = tierMatch ? tierMatch[1].toUpperCase() : '';
  const modelWithSampler = tierMatch ? tierMatch[2] : original;
  const [model, sampler] = modelWithSampler.split(':');
  return {
    original,
    tierName,
    tier: openAiSizeTiers[tierName] || null,
    model: model || 'nai-diffusion-4-5-full',
    sampler: sampler || ''
  };
}

function lastUserMessageText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const message = [...list].reverse().find((item) => item?.role === 'user') || list.at(-1);
  return messageContentText(message?.content || '');
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    return part?.text || '';
  }).filter(Boolean).join('\n');
}

function parseChinesePromptFields(text) {
  const fieldNames = {
    '提示词': 'tag',
    '畫師串': 'artist',
    '画师串': 'artist',
    '尺寸': 'size',
    '提示词引导值': 'scale',
    '提示詞引導值': 'scale',
    '缩放引导值': 'cfg',
    '縮放引導值': 'cfg',
    '负面提示词': 'negative',
    '負面提示詞': 'negative',
    '采样器': 'sampler',
    '採樣器': 'sampler'
  };
  const fields = {};
  let currentKey = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const match = line.match(/^([^:：]{1,16})\s*[:：]\s*(.*)$/);
    const key = match ? fieldNames[match[1].trim()] : '';
    if (key) {
      currentKey = key;
      fields[currentKey] = appendFieldValue(fields[currentKey], match[2]);
      continue;
    }
    if (currentKey && line.trim()) {
      fields[currentKey] = appendFieldValue(fields[currentKey], line);
    }
  }
  return fields;
}

function appendFieldValue(current, value) {
  const text = String(value || '').trim();
  if (!current) return text;
  if (!text) return current;
  return `${current}\n${text}`;
}

async function streamOpenAiImageJob(req, res, job, model, deadline = Date.now() + openAiChatTimeoutMs) {
  sendOpenAiStreamHeaders(res);
  const streamId = `chatcmpl-${job.id}`;
  writeOpenAiChunk(res, { id: streamId, model, content: '<think>\n任务已提交，正在进入队列\n' });
  let lastLine = '';
  let reachedRunning = false;
  while (Date.now() < deadline) {
    const snapshot = await publicJobSnapshot(job.id);
    if (!snapshot) {
      writeOpenAiChunk(res, { id: streamId, model, content: '任务不存在\n</think>\n任务不存在\n' });
      finishOpenAiStream(res, streamId, model);
      return;
    }

    const line = openAiProgressLine(snapshot);
    const isQueuedAfterRunning = reachedRunning && snapshot.status === 'queued';
    if (snapshot.status === 'running') reachedRunning = true;
    if (line && !isQueuedAfterRunning && line !== lastLine) {
      writeOpenAiChunk(res, { id: streamId, model, content: `${line}\n` });
      lastLine = line;
    }

    if (snapshot.status === 'done') {
      writeOpenAiChunk(res, { id: streamId, model, content: `生成完成\n</think>\n${openAiImageMarkdown(req, snapshot)}\n` });
      finishOpenAiStream(res, streamId, model);
      return;
    }

    if (snapshot.status === 'failed') {
      const message = snapshot.error || '生成失败';
      writeOpenAiChunk(res, { id: streamId, model, content: `${message}\n</think>\n${message}\n` });
      finishOpenAiStream(res, streamId, model);
      return;
    }

    await sleep(openAiQueuePollMs);
  }

  writeOpenAiChunk(res, { id: streamId, model, content: '连接超时\n</think>\n连接超时\n' });
  await timeoutJob(job.id);
  finishOpenAiStream(res, streamId, model);
}

async function publicJobSnapshot(jobId) {
  const snapshot = await store.findJobContext(jobId);
  return snapshot ? publicJob(snapshot.job, snapshot) : null;
}

function openAiProgressLine(job) {
  if (job.status === 'queued') {
    if (job.queuePosition && job.queuedCount) return `排队中：第 ${job.queuePosition} / ${job.queuedCount} 个`;
    return '排队中，正在等待可用账号';
  }
  if (job.status === 'running') {
    return '已路由账号，正在生成';
  }
  return '';
}

function openAiImageMarkdown(req, imageOrJob) {
  const imageId = imageOrJob.imageId || imageOrJob.id;
  return `![image](${absoluteUrl(req, publicImageUrl(imageId))})`;
}

function openAiChatCompletionResponse({ model, content, id }) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2
    }
  };
}

function writeOpenAiChunk(res, { id, model, content }) {
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { content },
      finish_reason: null
    }]
  })}\n\n`);
}

function finishOpenAiStream(res, id, model) {
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendOpenAiStreamHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    ...corsHeaders()
  });
}

function absoluteUrl(req, urlPath) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${port}`;
  return `${proto}://${hostHeader}${urlPath}`;
}

async function redeemCard(cardCode) {
  if (!cardCode) throw httpError(400, 'card is required.');
  return store.update((db) => {
    const card = db.cards.find((item) => item.code === cardCode);
    if (!card) throw httpError(404, 'card not found.');
    if (card.usedBy) throw httpError(409, 'card already redeemed.');
    if (card.expiresAt && Date.parse(card.expiresAt) < Date.now()) throw httpError(410, 'card expired.');

    const user = {
      id: createId('usr'),
      token: createPublicToken('STA1N'),
      balance: Number(card.credits || 0),
      enabled: true,
      sourceCard: card.code,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    card.usedBy = user.token;
    card.usedAt = new Date().toISOString();
    db.users.unshift(user);
    db.ledger.unshift({
      id: createId('log'),
      type: 'redeem',
      token: user.token,
      amount: user.balance,
      at: new Date().toISOString(),
      note: `Redeemed card ${card.code}`
    });
    return publicUser(user);
  }, { collections: ['cards', 'users', 'ledger'] });
}

async function mergeUserBalance(sourceToken, targetToken) {
  if (!sourceToken) throw httpError(400, '请先输入被融合密钥。');
  if (!targetToken) throw httpError(400, '请输入需要保留额度的密钥。');
  if (sourceToken === targetToken) throw httpError(409, '两个密钥不能相同。');

  return store.update((db) => {
    const source = getUserOrThrow(db, sourceToken);
    const target = db.users.find((item) => item.token === targetToken);
    if (!target || target.enabled === false) throw httpError(404, '保留额度的密钥不存在或已被禁用。');
    if (source.id === target.id) throw httpError(409, '两个密钥不能相同。');

    const activeJob = (db.jobs || []).find((job) => (
      job.userToken === source.token && ['queued', 'running'].includes(job.status)
    ));
    if (activeJob) throw httpError(409, '当前密钥还有任务正在生成，完成后再融合。');

    const amount = Number(source.balance || 0);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(409, '被融合密钥没有可融合额度。');

    const now = new Date().toISOString();
    target.balance = Math.max(0, Number(target.balance || 0)) + amount;
    target.updatedAt = now;
    source.balance = 0;
    source.enabled = false;
    source.mergedInto = target.token;
    source.mergedAt = now;
    source.mergedAmount = amount;
    source.updatedAt = now;
    target.mergedFrom = mergedFromEntries(target.mergedFrom);
    target.mergedFrom = [
      { token: source.token, amount, at: now },
      ...target.mergedFrom.filter((entry) => entry.token !== source.token)
    ].slice(0, 200);

    const mergeInLog = {
      id: createId('log'),
      type: 'merge-in',
      token: target.token,
      amount,
      at: now,
      note: `Merged balance from ${maskToken(source.token)}`
    };
    const mergeOutLog = {
      id: createId('log'),
      type: 'merge-out',
      token: source.token,
      amount: -amount,
      at: now,
      note: `Merged balance into ${maskToken(target.token)}`
    };
    db.ledger.unshift(mergeInLog, mergeOutLog);

    return {
      amount,
      source: publicUser(source),
      target: publicUser(target),
      ledgerIds: [mergeInLog.id, mergeOutLog.id]
    };
  }, {
    collections: ['users', 'ledger'],
    dirtyRows: (result) => ({
      users: [result?.source?.id, result?.target?.id],
      ledger: result?.ledgerIds || []
    }),
    immediate: true
  });
}

async function createCards(body) {
  const count = clamp(Number(body.count || 1), 1, 200);
  const credits = clamp(Number(body.credits || 10), 1, 100000);
  const prefix = String(body.prefix || 'CARD').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'CARD';
  const cards = Array.from({ length: count }, () => ({
    id: createId('card'),
    code: createPublicToken(prefix),
    credits,
    note: String(body.note || ''),
    createdAt: new Date().toISOString(),
    expiresAt: body.expiresAt || ''
  }));

  await store.update((db) => {
    db.cards.unshift(...cards);
  }, { collections: ['cards'] });
  return cards;
}

async function createUsers(body) {
  const count = clamp(Number(body.count || 1), 1, 200);
  const credits = clamp(Number(body.credits || 10), 1, 100000);
  const note = String(body.note || 'admin issued').slice(0, 120);
  const users = Array.from({ length: count }, () => ({
    id: createId('usr'),
    token: createPublicToken('STA1N'),
    balance: credits,
    enabled: true,
    sourceCard: '',
    note,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));

  await store.update((db) => {
    db.users.unshift(...users);
    users.forEach((user) => {
      db.ledger.unshift({
        id: createId('log'),
        type: 'issue',
        token: user.token,
        amount: credits,
        at: new Date().toISOString(),
        note
      });
    });
  }, { collections: ['users', 'ledger'] });
  return users;
}

async function adjustUsers(body) {
  const setBalance = body.setBalance === undefined ? null : clamp(Number(body.setBalance), 0, 100000000);
  const delta = body.delta === undefined && body.balanceDelta === undefined ? null : Number(body.delta ?? body.balanceDelta);
  if (setBalance === null && !Number.isFinite(delta)) throw httpError(400, 'setBalance or delta is required.');

  return store.update((db) => {
    const users = selectUsers(db, body);
    const now = new Date().toISOString();
    users.forEach((user) => {
      const before = Number(user.balance || 0);
      user.balance = setBalance === null ? Math.max(0, before + delta) : setBalance;
      user.updatedAt = now;
      db.ledger.unshift({
        id: createId('log'),
        type: 'adjust',
        token: user.token,
        amount: user.balance - before,
        at: now,
        note: String(body.note || 'admin balance adjustment').slice(0, 160)
      });
    });
    return users;
  }, { collections: ['users', 'ledger'] });
}

async function deleteUsers(body) {
  return store.update((db) => {
    const users = selectUsers(db, body);
    const ids = new Set(users.map((user) => user.id));
    const tokens = new Set(users.map((user) => user.token));
    db.users = db.users.filter((user) => !ids.has(user.id));
    db.cards.forEach((card) => {
      if (tokens.has(card.usedBy)) {
        card.usedBy = '';
        card.usedAt = '';
      }
    });
    db.ledger.unshift({
      id: createId('log'),
      type: 'delete-users',
      amount: 0,
      at: new Date().toISOString(),
      note: `Deleted ${users.length} user token(s)`
    });
    return { deleted: users.length };
  }, { collections: ['users', 'cards', 'ledger'] });
}

async function addAccount(body) {
  const token = String(body.token || '').trim();
  if (!token) throw httpError(400, 'NovelAI account token is required.');
  return store.update((db) => {
    const account = {
      id: createId('acct'),
      routeId: nextAccountRouteId(db.accounts),
      name: String(body.name || `NovelAI ${db.accounts.length + 1}`).slice(0, 80),
      token,
      proxyUrl: normalizeAccountProxyUrl(body.proxyUrl || body.socksProxy || body.proxy || ''),
      enabled: body.enabled !== false,
      weight: clamp(Number(body.weight || 1), 1, 100),
      inFlight: 0,
      total: 0,
      failures: 0,
      quotaPoints: null,
      quotaFixed: null,
      quotaPurchased: null,
      quotaTier: null,
      v5UsagePercent: null,
      v5UsageIsNegative: false,
      v5UsageTimeUntilNextPercent: null,
      quotaCheckedAt: '',
      quotaError: '',
      cooldownUntil: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: ''
    };
    db.accounts.unshift(account);
    return account;
  }, { collections: ['accounts'] });
}

async function importAccounts(body) {
  const mode = body.mode === 'replace' ? 'replace' : 'append';
  const accounts = parseImportedAccounts(body);
  if (!accounts.length) throw httpError(400, 'no account tokens found.');

  return store.update((db) => {
    const now = new Date().toISOString();
    const imported = accounts.map((account, index) => ({
      id: account.id || createId('acct'),
      routeId: Number(account.routeId || 0),
      name: String(account.name || `NovelAI imported ${index + 1}`).slice(0, 80),
      token: String(account.token || '').trim(),
      proxyUrl: normalizeAccountProxyUrl(account.proxyUrl || account.socksProxy || account.proxy || ''),
      enabled: account.enabled !== false,
      weight: clamp(Number(account.weight || 1), 1, 100),
      inFlight: 0,
      total: Number(account.total || 0),
      failures: Number(account.failures || 0),
      quotaPoints: numberOrNull(account.quotaPoints),
      quotaFixed: numberOrNull(account.quotaFixed),
      quotaPurchased: numberOrNull(account.quotaPurchased),
      quotaTier: account.quotaTier ?? null,
      v5UsagePercent: numberOrNull(account.v5UsagePercent),
      v5UsageIsNegative: Boolean(account.v5UsageIsNegative),
      v5UsageTimeUntilNextPercent: numberOrNull(account.v5UsageTimeUntilNextPercent),
      quotaCheckedAt: account.quotaCheckedAt || '',
      quotaError: account.quotaError || '',
      cooldownUntil: '',
      createdAt: account.createdAt || now,
      updatedAt: now,
      lastUsedAt: account.lastUsedAt || ''
    }));

    if (mode === 'replace') {
      db.accounts = imported;
    } else {
      const existingTokens = new Set(db.accounts.map((account) => account.token));
      imported.forEach((account) => {
        if (!existingTokens.has(account.token)) {
          db.accounts.unshift(account);
          existingTokens.add(account.token);
        }
      });
    }
    assignAccountRouteIds(db.accounts);

    db.ledger.unshift({
      id: createId('log'),
      type: 'import-accounts',
      amount: imported.length,
      at: now,
      note: `${mode} account import`
    });
    return db.accounts;
  }, { collections: ['accounts', 'ledger'] });
}

async function applyAccountProxies(body) {
  const proxies = parseProxyLines(body.proxies || body.proxyText || body.text || body.proxy || '');
  if (!proxies.length) throw httpError(400, 'no SOCKS5 proxies found.');
  return store.update((db) => {
    const ids = new Set(collectValues(body.ids || body.accounts));
    const accounts = ids.size ? db.accounts.filter((account) => ids.has(account.id)) : db.accounts;
    if (!accounts.length) throw httpError(ids.size ? 404 : 400, ids.size ? 'no matching accounts found.' : 'no accounts found.');
    const now = new Date().toISOString();
    const applied = Math.min(accounts.length, proxies.length);
    for (let index = 0; index < applied; index += 1) {
      accounts[index].proxyUrl = proxies[index];
      accounts[index].updatedAt = now;
    }
    db.ledger.unshift({
      id: createId('log'),
      type: 'apply-account-proxies',
      amount: applied,
      at: now,
      note: `Applied ${applied} SOCKS5 proxy setting(s)`
    });
    return {
      applied,
      proxies: proxies.length,
      accounts: accounts.slice(0, applied)
    };
  }, { collections: ['accounts', 'ledger'] });
}

async function deleteAccounts(body) {
  return store.update((db) => {
    const ids = new Set(collectValues(body.ids || body.accounts));
    if (!ids.size) throw httpError(400, 'account ids are required.');
    const before = db.accounts.length;
    db.accounts = db.accounts.filter((account) => !ids.has(account.id));
    const deleted = before - db.accounts.length;
    db.ledger.unshift({
      id: createId('log'),
      type: 'delete-accounts',
      amount: deleted,
      at: new Date().toISOString(),
      note: `Deleted ${deleted} NovelAI account(s)`
    });
    return { deleted };
  }, { collections: ['accounts', 'ledger'] });
}

async function updateAccounts(body) {
  return store.update((db) => {
    const ids = new Set(collectValues(body.ids || body.accounts));
    if (!ids.size) throw httpError(400, 'account ids are required.');
    const accounts = db.accounts.filter((account) => ids.has(account.id));
    if (!accounts.length) throw httpError(404, 'no matching accounts found.');
    const now = new Date().toISOString();
    accounts.forEach((account) => {
      if (body.enabled !== undefined) account.enabled = Boolean(body.enabled);
      if (body.weight !== undefined) account.weight = clamp(Number(body.weight), 1, 100);
      account.updatedAt = now;
    });
    db.ledger.unshift({
      id: createId('log'),
      type: 'update-accounts',
      amount: accounts.length,
      at: now,
      note: body.enabled === undefined ? `Updated ${accounts.length} account(s)` : `${body.enabled ? 'Enabled' : 'Disabled'} ${accounts.length} account(s)`
    });
    return accounts;
  }, { collections: ['accounts', 'ledger'] });
}

async function resetAccountStats(body) {
  return store.update((db) => {
    const ids = new Set(collectValues(body.ids || body.accounts));
    if (!ids.size) throw httpError(400, 'account ids are required.');
    const accounts = db.accounts.filter((account) => ids.has(account.id));
    if (!accounts.length) throw httpError(404, 'no matching accounts found.');
    const now = new Date().toISOString();
    accounts.forEach((account) => {
      account.inFlight = 0;
      account.total = 0;
      account.failures = 0;
      account.cooldownUntil = '';
      account.lastUsedAt = '';
      account.updatedAt = now;
    });
    db.ledger.unshift({
      id: createId('log'),
      type: 'reset-account-stats',
      amount: accounts.length,
      at: now,
      note: `Reset monitoring stats for ${accounts.length} NovelAI account(s)`
    });
    return { reset: accounts.length };
  }, { collections: ['accounts', 'ledger'] });
}

async function refreshAccountQuotas(body) {
  const ids = new Set(collectValues(body.ids || body.accounts));
  const targets = await store.readCollections(['accounts']).then((db) => {
    const accounts = ids.size ? db.accounts.filter((account) => ids.has(account.id)) : db.accounts;
    return accounts.map((account) => ({
      id: account.id,
      token: account.token,
      proxyUrl: account.proxyUrl || ''
    }));
  });
  if (!targets.length) throw httpError(ids.size ? 404 : 400, ids.size ? 'no matching accounts found.' : 'no accounts found.');

  const now = new Date().toISOString();
  const results = await mapLimit(targets, 5, async (target) => {
    try {
      const quota = await fetchNovelAiAccountQuotaWithTimeout(target.token, target.proxyUrl);
      return accountQuotaResult(target.id, quota, now);
    } catch (error) {
      return accountQuotaErrorResult(target.id, error, now);
    }
  });

  const resultMap = new Map(results.map((result) => [result.id, result]));
  const accounts = await store.update((db) => {
    db.accounts.forEach((account) => {
      const result = resultMap.get(account.id);
      if (!result) return;
      applyAccountQuotaResult(account, result, now);
    });
    if (fairShareMode) syncFairQuota(db);
    return db.accounts.filter((account) => resultMap.has(account.id));
  }, { collections: ['accounts'] });

  return {
    checked: results.length,
    ok: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    accounts: accounts.map((account) => publicAccount(account, { revealToken: true }))
  };
}

function startAccountQuotaAutoRefresh() {
  if (accountQuotaAutoRefreshStarted) return;
  accountQuotaAutoRefreshStarted = true;
  const run = async () => {
    try {
      const result = await refreshEnabledAccountQuotas();
      if (result.checked) console.log(`[runtime] account quota refresh: checked=${result.checked} ok=${result.ok} failed=${result.failed}`);
    } catch (error) {
      console.error('[runtime] account quota refresh failed:', error);
    } finally {
      accountQuotaRefreshTimer = setTimeout(run, accountQuotaRefreshIntervalMs);
      accountQuotaRefreshTimer.unref?.();
    }
  };
  run();
}

async function refreshEnabledAccountQuotas() {
  if (accountQuotaRefreshPromise) return accountQuotaRefreshPromise;
  accountQuotaRefreshPromise = (async () => {
    const db = await store.readCollections(['accounts']);
    const ids = db.accounts.filter((account) => account.enabled !== false).map((account) => account.id);
    if (!ids.length) return { checked: 0, ok: 0, failed: 0, accounts: [] };
    return refreshAccountQuotas({ ids });
  })();
  try {
    return await accountQuotaRefreshPromise;
  } finally {
    accountQuotaRefreshPromise = null;
  }
}

async function testAccount(id) {
  const db = await store.readCollections(['settings', 'accounts']);
  const target = db.accounts.find((account) => account.id === id);
  if (!target) throw httpError(404, 'account not found.');

  const now = new Date().toISOString();
  let result;
  try {
    const quota = await fetchNovelAiAccountQuotaWithTimeout(target.token, target.proxyUrl);
    result = accountQuotaResult(target.id, quota, now);
  } catch (error) {
    result = accountQuotaErrorResult(target.id, error, now);
  }

  const account = await store.update((writeDb) => {
    const item = writeDb.accounts.find((entry) => entry.id === id);
    if (!item) throw httpError(404, 'account not found.');
    applyAccountQuotaResult(item, result, now);
    return item;
  }, { collections: ['accounts'] });
  const availability = accountAvailability(account, db.settings);
  const ok = Boolean(result.ok);
  const available = ok && availability.available;

  return {
    ok,
    available,
    message: accountTestMessage(result, availability),
    checkedAt: now,
    availability,
    account: publicAccount(account, { revealToken: true })
  };
}

function accountQuotaResult(id, quota, now) {
  const noSubscription = isUnsubscribedAccountTier(quota.tier);
  const validTrial = quota.trialStatusKnown === true && quota.trialEligible === true && Number(quota.trialRemainingImages) > 0;
  return {
    id,
    ok: true,
    quotaPoints: quota.points,
    quotaFixed: quota.fixed,
    quotaPurchased: quota.purchased,
    quotaTier: quota.tier,
    subscriptionActive: quota.subscriptionActive,
    subscriptionExpiresAt: quota.subscriptionExpiresAt,
    v5UsagePercent: quota.v5UsagePercent,
    v5UsageIsNegative: quota.v5UsageIsNegative,
    v5UsageTimeUntilNextPercent: quota.v5UsageTimeUntilNextPercent,
    quotaCheckedAt: now,
    quotaError: '',
    trialRemainingImages: quota.trialRemainingImages ?? null,
    trialUsedImages: quota.trialUsedImages ?? null,
    trialEligible: quota.trialEligible === true,
    trialStatusKnown: quota.trialStatusKnown === true,
    disableAccount: noSubscription && !validTrial,
    disableReason: noSubscription && !validTrial ? '无可用试用额度' : ''
  };
}

function accountQuotaErrorResult(id, error, now) {
  const message = error.message || 'quota query failed.';
  const banned = isNovelAiAccountBannedError(message);
  const outOfTrial = isNovelAiOutOfTrialImageGenerationError(message);
  return {
    id,
    ok: false,
    quotaPoints: null,
    quotaFixed: null,
    quotaPurchased: null,
    quotaTier: null,
    v5UsagePercent: null,
    v5UsageIsNegative: false,
    v5UsageTimeUntilNextPercent: null,
    quotaCheckedAt: now,
    quotaError: publicErrorMessage(message),
    disableAccount: banned || outOfTrial,
    disableReason: banned ? '账号已封禁' : outOfTrial ? '试用次数已用完' : ''
  };
}

function applyAccountQuotaResult(account, result, now) {
  account.trialRemainingImages = result.trialRemainingImages ?? null;
  account.trialUsedImages = result.trialUsedImages ?? null;
  account.trialEligible = result.trialEligible === true;
  account.trialStatusKnown = result.trialStatusKnown === true;
  account.subscriptionActive = result.ok && result.subscriptionActive === true;
  account.subscriptionExpiresAt = result.subscriptionExpiresAt ?? null;
  account.quotaPoints = result.quotaPoints;
  account.quotaFixed = result.quotaFixed;
  account.quotaPurchased = result.quotaPurchased;
  if (result.ok) account.quotaTier = result.quotaTier;
  account.v5UsagePercent = result.v5UsagePercent;
  account.v5UsageIsNegative = result.v5UsageIsNegative;
  account.v5UsageTimeUntilNextPercent = result.v5UsageTimeUntilNextPercent;
  account.quotaCheckedAt = result.quotaCheckedAt;
  account.quotaError = result.quotaError;
  if (result.ok && !fairShareMode) account.cooldownUntil = '';
  if (result.disableAccount) disableNovelAiAccount(account);
  account.updatedAt = now;
}

function accountAvailability(account, settings = {}) {
  const now = Date.now();
  const maxConcurrency = maxAccountConcurrency(settings);
  const inFlight = Number(account.inFlight || 0);
  const cooldownUntilMs = Date.parse(account.cooldownUntil || '');
  const coolingDown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now;
  const quotaPoints = accountQuotaPoints(account);
  const enabled = account.enabled !== false;
  const hasSlot = inFlight < maxConcurrency;
  const standardAvailable = enabled && !coolingDown && hasSlot
    && (!isUnsubscribedAccountTier(account.quotaTier) || hasUsableImageTrial(account));
  const highResolutionAvailable = standardAvailable && hasPaidQuota(account);

  return {
    enabled,
    coolingDown,
    cooldownUntil: coolingDown ? account.cooldownUntil : '',
    inFlight,
    maxConcurrency,
    hasSlot,
    quotaPoints,
    available: standardAvailable,
    standardAvailable,
    highResolutionAvailable
  };
}

function accountTestMessage(result, availability) {
  if (result.disableAccount && !result.ok) return `测试失败：${result.disableReason || '账号不可用'}，已自动禁用`;
  if (!result.ok) return `测试失败：${result.quotaError || '账号不可用'}`;
  const quotaText = availability.quotaPoints === null ? '点数未知' : `剩余 ${availability.quotaPoints} 点`;
  const v5UsageText = result.v5UsagePercent === null
    ? 'V5额度未知'
    : result.v5UsageIsNegative
      ? 'V5额度已耗尽'
      : `V5剩余 ${result.v5UsagePercent}%`;
  const accountText = `${quotaText}，${accountTierText(result.quotaTier, '会员未知')}，${v5UsageText}`;
  if (result.disableAccount) return `测试通过：${result.disableReason || '账号不可用'}，已自动禁用（${accountText}）`;
  if (!availability.enabled) return `测试通过：Token 有效，但这个账号已禁用（${accountText}）`;
  if (availability.coolingDown) return `测试通过：Token 有效，但账号正在冷却中（${accountText}）`;
  if (!availability.hasSlot) return `测试通过：Token 有效，但账号当前并发已满（${accountText}）`;
  if (!availability.highResolutionAvailable) return `测试通过：普通生成可用，2K/4K 点数不足（${accountText}）`;
  return `测试通过：账号当前可用（${accountText}）`;
}

function accountTierText(tier, fallback = '会员未查询') {
  if (tier === null || tier === undefined || tier === '') return fallback;
  const value = Number(tier);
  const tierNames = {
    0: '无订阅',
    1: 'Tablet 会员',
    2: 'Scroll 会员',
    3: 'Opus 会员'
  };
  if (Number.isFinite(value)) return tierNames[value] || `Tier ${value}`;
  const key = String(tier).trim().toLowerCase();
  return {
    none: '无订阅',
    paper: '无订阅',
    tablet: 'Tablet 会员',
    scroll: 'Scroll 会员',
    opus: 'Opus 会员'
  }[key] || String(tier);
}

function isUnsubscribedAccountTier(tier) {
  if (tier === null || tier === undefined || tier === '') return false;
  const value = Number(tier);
  if (Number.isFinite(value)) return value === 0;
  return ['none', 'paper', 'free', 'unsubscribed'].includes(String(tier).trim().toLowerCase());
}

function isNovelAiAccountBannedError(error) {
  const text = String(error?.message || error || '');
  return /ban(?:ned)?|封禁/i.test(text);
}

function disableNovelAiAccount(account) {
  account.enabled = false;
  account.inFlight = 0;
  account.cooldownUntil = '';
}

async function fetchNovelAiAccountQuotaWithTimeout(token, proxyUrl = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), accountQuotaRequestTimeoutMs);
  try {
    return await fetchNovelAiAccountQuota(token, process.env, {
      signal: controller.signal,
      proxyUrl
    });
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function clearImageCache(body) {
  const ids = collectValues(body.ids || body.images);
  const query = String(body.q || body.query || '').trim().toLowerCase();
  const clearAll = body.all === true || body.mode === 'all';
  if (!clearAll && !ids.length && !query) throw httpError(400, 'cache clear target is required.');

  const result = await store.clearCachedImages({ ...body, ids, q: query, all: clearAll });
  await removeStoredImages(result.images || []);
  delete result.images;
  return result;
}

async function clearRequestLogs() {
  return store.clearRequestLogs();
}

async function cleanupStaleActiveJobs(reason = 'stale active job cleanup') {
  const result = await store.update((db) => {
    const now = Date.now();
    const failedJobIds = [];
    const message = publicErrorMessage('direct generate timeout');
    const jobs = Array.isArray(db.jobs) ? db.jobs : [];
    jobs.forEach((job) => {
      if (!isStaleActiveJob(job, now)) return;
      const detail = staleActiveJobDetail(job, now);
      const account = job.accountId ? db.accounts.find((item) => item.id === job.accountId) : null;
      if (account) {
        account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
        account.updatedAt = new Date().toISOString();
      }
      refundJob(db, job, message);
      job.status = 'failed';
      job.error = message;
      job.errorDetail = `${reason}: ${detail}`;
      job.updatedAt = new Date().toISOString();
      job.completedAt = job.updatedAt;
      failedJobIds.push(job.id);
    });
    return {
      changed: failedJobIds.length,
      jobIds: failedJobIds
    };
  }, {
    dirtyRows: dirtyJobListRows,
    shouldPersist: (result) => Number(result?.changed || 0) > 0
  });

  if (!result?.changed) return result;
  result.jobIds.forEach((jobId) => notifyJobWaiters(jobId, { error: 'direct generate timeout' }));
  return result;
}

async function cleanupInterruptedStartupJobs() {
  const startedAt = Date.now();
  const result = await store.update((db) => {
    const now = Date.now();
    const updatedAt = new Date(now).toISOString();
    const message = publicErrorMessage('direct generate timeout');
    const jobs = Array.isArray(db.jobs) ? db.jobs : [];
    const failedJobIds = [];
    let running = 0;
    let direct = 0;
    let openai = 0;
    let expired = 0;

    jobs.forEach((job) => {
      if (!['queued', 'running'].includes(job.status)) return;
      const isRunning = job.status === 'running';
      const isDirect = job.source === 'direct';
      const isOpenAi = job.source === 'openai';
      const isExpired = isExpiredJobAt(job, now);
      if (!isRunning && !isDirect && !isOpenAi && !isExpired) return;

      if (isRunning) running += 1;
      if (isDirect) direct += 1;
      if (isOpenAi) openai += 1;
      if (isExpired) expired += 1;

      const account = job.accountId ? db.accounts.find((item) => item.id === job.accountId) : null;
      if (account) {
        account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
        account.updatedAt = updatedAt;
      }
      refundJob(db, job, message);
      job.status = 'failed';
      job.error = message;
      job.errorDetail = isDirect || isOpenAi
        ? 'startup: request-bound job was interrupted by server restart'
        : isRunning
          ? 'startup: running job was interrupted by server restart'
          : 'startup: job deadline expired before restart completed';
      job.updatedAt = updatedAt;
      job.completedAt = updatedAt;
      failedJobIds.push(job.id);
    });

    return {
      changed: failedJobIds.length,
      running,
      direct,
      openai,
      expired,
      queuedRemaining: jobs.filter((job) => job.status === 'queued').length,
      runningRemaining: jobs.filter((job) => job.status === 'running').length,
      jobIds: failedJobIds
    };
  }, {
    dirtyRows: dirtyJobListRows,
    shouldPersist: (result) => Number(result?.changed || 0) > 0
  });

  console.log(`[runtime] startup interrupted job cleanup completed in ${Date.now() - startedAt}ms: changed=${result.changed} running=${result.running} direct=${result.direct} openai=${result.openai} expired=${result.expired} queuedRemaining=${result.queuedRemaining} runningRemaining=${result.runningRemaining}`);
  if (result.changed) result.jobIds.forEach((jobId) => notifyJobWaiters(jobId, { error: 'direct generate timeout' }));
  return result;
}

async function logStartupQueueState() {
  const counts = await store.readQueueStateCounts();
  console.log(`[runtime] startup queue resume state: queued=${counts.queued} running=${counts.running} directQueued=${counts.directQueued} openaiQueued=${counts.openAiQueued}`);
}

async function cleanupImageStorage() {
  // 私有部署保护：禁止自动清理孤儿图片。
  if (process.env.NO_AUTO_DELETE === 'true') return;
  const startedAt = Date.now();
  const settings = await store.readSettings();
  const trimmedImages = await store.trimImageCache(normalizeCacheImageLimit(settings.maxCacheImages), { force: true }) || [];
  await removeStoredImages(trimmedImages);

  const imageFiles = await store.readImageFiles();
  if (!imageFiles) {
    if (trimmedImages.length) {
      console.log(`[runtime] image cache cleanup removed ${trimmedImages.length} expired records and skipped orphan scan because image cache is partially loaded in ${Date.now() - startedAt}ms`);
    } else {
      console.log(`[runtime] image cache cleanup skipped orphan scan because image cache is partially loaded in ${Date.now() - startedAt}ms`);
    }
    return;
  }
  const referencedFiles = new Set(imageFiles
    .map((file) => path.resolve(dataDir, file)));

  let entries = [];
  try {
    entries = await readdir(imageDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const orphanFiles = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('img_'))
    .map((entry) => path.join(imageDir, entry.name))
    .filter((file) => !referencedFiles.has(path.resolve(file)));

  await Promise.all(orphanFiles.map(async (file) => {
    try {
      await rm(file, { force: true });
    } catch (error) {
      console.error(`Failed to delete orphan cached image ${path.basename(file)}:`, error);
    }
  }));

  if (trimmedImages.length || orphanFiles.length) {
    console.log(`[runtime] image cache cleanup removed ${trimmedImages.length} expired records and ${orphanFiles.length} orphan files in ${Date.now() - startedAt}ms`);
  } else {
    runtimeSlowLog('image cache cleanup', startedAt, 'removed=0');
  }
}

function trimImageCacheRecords(db, options = {}) {
  db.settings = db.settings || {};
  db.images = Array.isArray(db.images) ? db.images : [];
  const maxCacheImages = normalizeCacheImageLimit(db.settings.maxCacheImages);
  db.settings.maxCacheImages = maxCacheImages;

  const force = options.force === true || maxCacheImages <= 0;
  const trimBuffer = force ? 0 : imageCacheTrimBuffer(maxCacheImages);
  const trimAt = maxCacheImages + trimBuffer;
  if (db.images.length < trimAt) return [];

  const removedImages = db.images.slice(maxCacheImages);
  db.images = db.images.slice(0, maxCacheImages);

  const removedIds = new Set(removedImages.map((image) => image.id).filter(Boolean));
  const affectedJobIds = [];
  if (removedIds.size && Array.isArray(db.jobs)) {
    db.jobs.forEach((job) => {
      if (!removedIds.has(job.imageId)) return;
      job.imageId = '';
      if (job.id) affectedJobIds.push(job.id);
    });
  }

  removedImages.affectedJobIds = affectedJobIds;
  return removedImages;
}

function imageCacheTrimDirtyRows(trimmedImages = []) {
  const images = uniqueIds((Array.isArray(trimmedImages) ? trimmedImages : []).map((image) => image?.id));
  const jobs = uniqueIds(trimmedImages?.affectedJobIds || []);
  return {
    ...(images.length ? { images } : {}),
    ...(jobs.length ? { jobs } : {})
  };
}

function uniqueIds(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function imageCacheTrimBuffer(maxCacheImages = 1) {
  return maxCacheImages > 0 ? 300 : 0;
}

function normalizeCacheImageLimit(value) {
  const number = Number(value ?? 500);
  if (!Number.isFinite(number)) return 500;
  return Math.max(0, Math.min(MAX_CACHE_IMAGES_LIMIT, Math.floor(number)));
}

async function importPackage(body) {
  const mode = body.mode === 'merge' ? 'merge' : 'replace';
  const payload = body.data || body.package || body;
  if (!payload || typeof payload !== 'object') throw httpError(400, 'import package is required.');
  const incoming = normalizeDb(sanitizeMigrationData(payload));

  if (mode === 'replace') {
    const safeDb = normalizeDb({
      ...incoming,
      jobs: [],
      images: [],
      ledger: []
    });
    safeDb.accounts = safeDb.accounts.map((account) => ({ ...account, inFlight: 0 }));
    assignAccountRouteIds(safeDb.accounts);
    await store.write(safeDb);
    await cleanupImageStorage();
    return {
      mode,
      users: safeDb.users.length,
      accounts: safeDb.accounts.length,
      images: safeDb.images.length
    };
  }

  let trimmedImages = [];
  const result = await store.update((db) => {
    db.settings = {
      ...db.settings,
      ...incoming.settings,
      defaults: {
        ...(db.settings.defaults || {}),
        ...(incoming.settings.defaults || {})
      }
    };
    db.cards = mergeById(db.cards, incoming.cards);
    db.users = mergeById(db.users, incoming.users);
    db.accounts = mergeById(db.accounts, incoming.accounts).map((account) => ({ ...account, inFlight: 0 }));
    return {
      mode,
      users: db.users.length,
      accounts: db.accounts.length,
      images: db.images.length
    };
  }, {
    collections: ['settings', 'cards', 'users', 'accounts']
  });
  trimmedImages = await store.trimImageCache(null, { force: true });
  await removeStoredImages(trimmedImages);
  return result;
}

async function updateAccount(id, body) {
  return store.update((db) => {
    const account = db.accounts.find((item) => item.id === id);
    if (!account) throw httpError(404, 'account not found.');
    // 更换密钥前先检查在途预扣，避免请求结算到另一账户。
    const changingToken = body.token !== undefined && String(body.token).trim() !== account.token;
    if (changingToken && (Number(account.inFlight || 0) > 0 || Object.values(db.settings.fairQuota?.reservations || {}).some(r => r.accountId === id && r.status === 'reserved'))) throw httpError(409, '有在途生成任务，请等待完成后更新密钥');
    if (changingToken && !String(body.token).trim().startsWith('pst-')) throw httpError(400, '需要有效的 PST 格式密钥');
    if (changingToken) {
      account.enabled = false;
      account.quotaCheckedAt = '';
      account.quotaError = '密钥已更新，请刷新额度后再启用';
    }
    if (body.name !== undefined) account.name = String(body.name).slice(0, 80);
    if (body.token !== undefined && body.token) account.token = String(body.token).trim();
    if (body.proxyUrl !== undefined || body.socksProxy !== undefined || body.proxy !== undefined) {
      account.proxyUrl = normalizeAccountProxyUrl(body.proxyUrl || body.socksProxy || body.proxy || '');
    }
    if (body.enabled !== undefined && !changingToken) account.enabled = Boolean(body.enabled);
    if (body.weight !== undefined) account.weight = clamp(Number(body.weight), 1, 100);
    account.updatedAt = new Date().toISOString();
    return account;
  }, { collections: ['accounts'] });
}

function dirtyJobRows(jobId) {
  return jobId ? { jobs: [jobId] } : {};
}

function dirtyResultJobRows(result, db) {
  return dirtyJobMutationRows(result, db);
}

function dirtyReservationJobRows(reservation) {
  return (result, db) => dirtyJobMutationRows({
    job: result?.job || reservation?.job,
    jobId: result?.job?.id || result?.jobId || reservation?.job?.id,
    token: result?.token || reservation?.token || reservation?.job?.userToken,
    accountIds: [reservation?.account?.id, result?.account?.id, result?.job?.accountId]
  }, db);
}

function dirtyJobMutationRows(source = {}, db = {}) {
  const jobId = source?.job?.id || source?.jobId || source?.id || '';
  const job = source?.job || (jobId ? db.jobs?.find((item) => item.id === jobId) : null);
  const token = source?.token || source?.userToken || job?.userToken || '';
  const accountIds = uniqueIds([
    ...(Array.isArray(source?.accountIds) ? source.accountIds : []),
    source?.account?.id,
    source?.accountId,
    job?.accountId
  ]);
  const ledgerIds = uniqueIds([
    source?.ledgerId,
    ...(jobId ? (db.ledger || []).filter((entry) => entry.jobId === jobId).map((entry) => entry.id) : [])
  ]);
  const user = token && ledgerIds.length ? db.users?.find((item) => item.token === token) : null;
  return {
    ...(jobId ? { jobs: [jobId] } : {}),
    ...(user?.id ? { users: [user.id] } : {}),
    ...(accountIds.length ? { accounts: accountIds } : {}),
    ...(ledgerIds.length ? { ledger: ledgerIds } : {})
  };
}

function dirtyJobListRows(result = {}, db = {}) {
  const rows = {};
  for (const jobId of result?.jobIds || []) {
    mergeDirtyRows(rows, dirtyJobMutationRows({ jobId }, db));
  }
  return rows;
}

function dirtyCreditReservationRows(result) {
  const reservation = result?.reservation || result || {};
  return {
    ...(reservation.userId ? { users: [reservation.userId] } : {}),
    ...(reservation.account?.id ? { accounts: [reservation.account.id] } : {}),
    ...(reservation.ledgerId ? { ledger: [reservation.ledgerId] } : {})
  };
}

function mergeDirtyRows(target, source = {}) {
  Object.entries(source).forEach(([collection, ids]) => {
    target[collection] = uniqueIds([...(target[collection] || []), ...(Array.isArray(ids) ? ids : [ids])]);
  });
  return target;
}

async function assertFairMemberReady(token) {
  if (!fairShareMode) return;
  const result = await store.update(db => {
    const user = getUserOrThrow(db, token);
    const state = syncFairQuota(db);
    if (!state?.enabled) return { status: 503, message: '四人共享账本尚未配置' };
    if (!state.members.includes(user.id)) return { status: 403, message: '该 Key 未加入四人共享账本' };
    if (state.status !== 'active') return { status: 503, message: `共享 Opus 暂不可用：${state.status}` };
    return null;
  }, { collections: ['settings'] });
  if (result) throw httpError(result.status, result.message);
}

async function createJob(token, body, options = {}) {
  await assertFairMemberReady(token);
  await cleanupStaleActiveJobs('create job');
  const normalizeRequest = (settings) => {
    if (options.native) return structuredClone(body);
    const input = options.frontend ? { ...body, width: undefined, height: undefined, cost: undefined } : body;
    const request = normalizeNovelAiRequest(input, settings, { maxSteps: options.frontend ? MAX_STEPS : DIRECT_URL_MAX_STEPS });
    if (options.frontend) {
      request.steps = Math.floor(request.steps);
      request.cost = generationCost(request);
    }
    if (fairShareMode) request.allowPurchasedAnlas = body.allowPurchasedAnlas === true;
    return request;
  };
  if (!isNoCache(body.nocache)) {
    const settings = await store.readSettings();
    const request = normalizeRequest(settings);
    const cacheKey = requestCacheKey(token, request, body.seed);
    const cached = await store.findImageByCacheKey(cacheKey);
    if (cached) {
      return createDirectJob(token, request, cacheKey, {
        status: 'done',
        accountId: cached.accountId || '',
        imageId: cached.id,
        cost: 0
      });
    }
  }
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const request = normalizeRequest(db.settings);
    const cacheKey = requestCacheKey(token, request, body.seed);
    if (!isNoCache(body.nocache)) {
      const activeMatch = db.jobs.find((job) => (
        job.userToken === token
        && job.cacheKey === cacheKey
        && ['queued', 'running'].includes(job.status)
      ));
      if (activeMatch) return activeMatch;
    }
    const cost = generationCost(request);
    if (user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const queueTotal = activeJobCount(db.jobs) + 1;
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    const job = {
      id: createId('job'),
      source: options.source || 'web',
      userToken: token,
      status: 'queued',
      request,
      cacheKey,
      queueTotal,
      cost,
      accountCost: 0,
      deadlineAt: options.deadlineAt || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imageId: '',
      error: '',
      errorDetail: ''
    };
    db.jobs.unshift(job);
    db.ledger.unshift({
      id: createId('log'),
      type: 'reserve',
      token,
      jobId: job.id,
      amount: -cost,
      at: new Date().toISOString()
    });
    return job;
  }, {
    dirtyRows: dirtyResultJobRows
  });
}

async function ensureAccountRouteIds() {
  await store.update((db) => {
    assignAccountRouteIds(db.accounts);
  }, { collections: ['accounts'] });
}

async function createDirectJob(token, request, cacheKey, options = {}) {
  await assertFairMemberReady(token);
  if (options.status !== 'done') await cleanupStaleActiveJobs('create direct job');
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const cost = Number(options.cost ?? generationCost(request));
    const shouldCharge = !options.status && cost > 0;
    if (shouldCharge && user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const now = new Date().toISOString();
    if (shouldCharge) {
      user.balance -= cost;
      user.updatedAt = now;
    }
    const job = {
      id: createId('job'),
      source: 'direct',
      userToken: token,
      status: options.status || 'queued',
      request,
      cacheKey,
      queueTotal: options.status === 'done' ? 1 : activeJobCount(db.jobs) + 1,
      cost: shouldCharge ? cost : Number(options.cost || 0),
      accountCost: 0,
      accountId: options.accountId || '',
      deadlineAt: options.deadlineAt || '',
      createdAt: now,
      updatedAt: now,
      completedAt: options.status === 'done' ? now : '',
      imageId: options.imageId || '',
      error: '',
      errorDetail: ''
    };
    db.jobs.unshift(job);
    if (shouldCharge) {
      db.ledger.unshift({
        id: createId('log'),
        type: 'reserve',
        token,
        jobId: job.id,
        amount: -cost,
        at: now
      });
    }
    return job;
  }, {
    dirtyRows: dirtyResultJobRows
  });
}

async function markDirectJobRunning(jobId, reservation) {
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.status = 'running';
    job.accountId = reservation.account?.id || '';
    job.cost = Number(reservation.cost || 0);
    job.accountCost = Number(reservation.accountCost || 0);
    job.completedAt = '';
    job.error = '';
    job.errorDetail = '';
    job.updatedAt = new Date().toISOString();
  }, { collections: ['jobs'], dirtyRows: dirtyJobRows(jobId) });
}

async function markDirectJobFailed(jobId, message) {
  const detail = errorDetailMessage(message);
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.status = 'failed';
    job.error = publicErrorMessage(detail);
    job.errorDetail = detail;
    job.updatedAt = new Date().toISOString();
    job.completedAt = job.updatedAt;
  }, { collections: ['jobs'], dirtyRows: dirtyJobRows(jobId) });
  clearJobStreamProgress(jobId);
  notifyJobWaiters(jobId, { error: publicErrorMessage(detail) });
}

async function removeJob(jobId) {
  await store.update((db) => {
    db.jobs = db.jobs.filter((job) => job.id !== jobId);
  }, { collections: ['jobs'], dirtyRows: dirtyJobRows(jobId) });
}

async function timeoutJob(jobId) {
  const control = runningJobControls.get(jobId);
  if (control) {
    abortRunningJob(jobId, 'direct generate timeout');
    await control.done;
    return;
  }
  await cancelQueuedOrRunningJob(jobId, 'direct generate timeout', 'job timed out before completion');
}

async function cancelQueuedOrRunningJob(jobId, message, detail = message) {
  let changed = false;
  const publicMessage = publicErrorMessage(message);
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job || ['done', 'failed'].includes(job.status)) return;
    const account = job.accountId ? db.accounts.find((item) => item.id === job.accountId) : null;
    if (account) {
      account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
      account.updatedAt = new Date().toISOString();
    }
    refundJob(db, job, publicMessage);
    job.status = 'failed';
    job.error = publicMessage;
    job.errorDetail = detail;
    job.updatedAt = new Date().toISOString();
    job.completedAt = job.updatedAt;
    changed = true;
  }, {
    dirtyRows: (_result, db) => dirtyJobMutationRows({ jobId }, db),
    shouldPersist: () => changed
  });
  if (!changed) return;
  scheduleQueueDrain();
  clearJobStreamProgress(jobId);
  notifyJobWaiters(jobId, { error: message });
}

function waitForJobResult(jobId, deadline) {
  const remainingMs = Math.max(1, deadline - Date.now());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      removeJobWaiter(jobId, waiter);
      resolve(null);
    }, remainingMs);
    const waiter = { resolve, timer };
    if (!jobWaiters.has(jobId)) jobWaiters.set(jobId, new Set());
    jobWaiters.get(jobId).add(waiter);
  });
}

function notifyJobWaiters(jobId, payload) {
  const waiters = jobWaiters.get(jobId);
  if (!waiters) return;
  jobWaiters.delete(jobId);
  waiters.forEach((waiter) => {
    clearTimeout(waiter.timer);
    waiter.resolve(payload);
  });
}

function resetJobStreamProgress(jobId, request = {}) {
  if (!jobId) return;
  jobPreviews.clear(jobId);
  const progress = {
    percent: 0,
    step: 0,
    total: Number(request?.steps || 0),
    updatedAt: new Date().toISOString()
  };
  jobStreamProgress.set(jobId, progress);
  patchCachedJobStreamProgress(jobId, progress);
  jobStreamProgressPersistState.set(jobId, { percent: 0, at: 0 });
}

function updateJobStreamProgress(jobId, progress = {}) {
  if (!jobId) return;
  const previous = jobStreamProgress.get(jobId) || {};
  const percent = clamp(Number(progress.percent ?? previous.percent ?? 0), 0, 100);
  const next = {
    percent: Math.max(Number(previous.percent || 0), percent),
    step: Number(progress.step ?? previous.step ?? 0) || 0,
    total: Number(progress.total ?? previous.total ?? 0) || 0,
    accountId: progress.accountId || previous.accountId || '',
    accountRouteId: Number(progress.accountRouteId || previous.accountRouteId || 0),
    eventType: progress.eventType || previous.eventType || '',
    updatedAt: progress.updatedAt || new Date().toISOString()
  };
  jobStreamProgress.set(jobId, next);
  const job = patchCachedJobStreamProgress(jobId, next);
  if (percent === 0) jobPreviews.clear(jobId);
  jobPreviews.update(job, progress);
  if (shouldPersistJobStreamProgress(jobId, next)) {
    persistJobStreamProgress(jobId, next).catch((error) => {
      console.error('[runtime] failed to persist job stream progress:', error);
    });
  }
}

function clearJobStreamProgress(jobId) {
  if (!jobId) return;
  jobPreviews.clear(jobId);
  jobStreamProgress.delete(jobId);
  jobStreamProgressPersistState.delete(jobId);
}

function patchCachedJobStreamProgress(jobId, progress = {}) {
  const job = store.db?.jobs?.find((item) => item.id === jobId);
  if (!job) return;
  job.generationProgress = publicProgressSnapshot(progress, job);
  return job;
}

function shouldPersistJobStreamProgress(jobId, progress = {}) {
  const now = Date.now();
  const previous = jobStreamProgressPersistState.get(jobId) || { percent: 0, at: 0 };
  const percent = Number(progress.percent || 0);
  if (percent >= 100) return true;
  if (percent - Number(previous.percent || 0) >= 8) return true;
  return now - Number(previous.at || 0) >= 1500;
}

async function persistJobStreamProgress(jobId, progress = {}) {
  const now = Date.now();
  jobStreamProgressPersistState.set(jobId, { percent: Number(progress.percent || 0), at: now });
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job || job.status !== 'running') return null;
    job.generationProgress = publicProgressSnapshot(progress, job);
    return job;
  }, {
    collections: ['jobs'],
    dirtyRows: dirtyJobRows(jobId),
    shouldPersist: (job) => Boolean(job)
  });
}

function publicProgressSnapshot(progress = {}, job = {}) {
  return {
    percent: clamp(Number(progress.percent || 0), 0, 100),
    step: Number(progress.step || 0),
    total: Number(progress.total || job.request?.steps || 0),
    updatedAt: progress.updatedAt || new Date().toISOString()
  };
}

function isTimeoutResultMessage(message) {
  return /direct generate timeout|job timed out|aborted|abort|timeout/i.test(String(message || ''));
}

function removeJobWaiter(jobId, waiter) {
  const waiters = jobWaiters.get(jobId);
  if (!waiters) return;
  waiters.delete(waiter);
  if (!waiters.size) jobWaiters.delete(jobId);
}

async function runJob(jobId) {
  try {
    const reservation = await reserveQueuedJob(jobId);
    await runReservedJob(reservation);
  } catch (error) {
    console.error(error);
  }
}

async function reserveQueuedJob(jobId) {
  return store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error('job not found.');
    if (job.status !== 'queued') return { skip: true, changed: false };
    const accountCost = jobAccountCost(job);
    job.accountCost = accountCost;
    if (isStaleActiveJob(job)) {
      const detail = staleActiveJobDetail(job);
      refundJob(db, job, '连接超时');
      job.status = 'failed';
      job.error = '连接超时';
      job.errorDetail = detail;
      job.updatedAt = new Date().toISOString();
      job.completedAt = job.updatedAt;
      return { skip: true, jobId: job.id };
    }
    let account;
    if (fairShareMode) {
      const state = syncFairQuota(db);
      try {
        if (!state?.enabled || state.status !== 'active') throw httpError(503, `共享 Opus 暂不可用：${state?.status || '未配置四人成员'}`);
        account = db.accounts.find(a => a.id === state.boundAccountId);
        if (!account || account.enabled === false) throw httpError(503, '绑定的 Opus 账号未启用');
        const running = db.jobs.filter(j => j.status === 'running').length;
        if (running >= 4 || isAccountCoolingDown(account, Date.now())) return { queued: true, jobId: job.id };
        reserveFairQuota(db, getUserOrThrow(db, job.userToken), job, account);
      } catch (error) {
        refundJob(db, job, error.message);
        job.status = 'failed';
        job.error = error.message;
        job.errorStatus = error.statusCode || 503;
        job.updatedAt = job.completedAt = new Date().toISOString();
        return { skip: true, jobId: job.id, failure: job.error, statusCode: job.errorStatus };
      }
    } else {
      account = selectAccount(db.accounts, db.settings, { request: job.request });
    }
    if (!account && hasEnabledAccounts(db.accounts)) {
      if (!hasAccountWithEnoughQuota(db.accounts, job.request)) {
        refundJob(db, job, '无符合本次参数的可用额度；试用限总像素1048576、28步以内');
        job.status = 'failed';
        job.error = '无符合本次参数的可用额度；试用限总像素1048576、28步以内';
        job.errorDetail = 'No NovelAI account has available free allowance or paid balance for this request';
        job.updatedAt = new Date().toISOString();
        job.completedAt = job.updatedAt;
        return { skip: true, jobId: job.id };
      }
      job.updatedAt = new Date().toISOString();
      return { queued: true, jobId: job.id };
    }
    if (account) {
      account.inFlight = Number(account.inFlight || 0) + 1;
      account.lastUsedAt = new Date().toISOString();
    }
    job.status = 'running';
    job.accountId = account?.id || '';
    job.completedAt = '';
    job.updatedAt = new Date().toISOString();
    return { job, account: account ? { ...account } : null, token: job.userToken, cost: job.cost, accountCost, cacheKey: job.cacheKey || '' };
  }, {
    dirtyRows: dirtyResultJobRows,
    shouldPersist: (result) => result?.changed !== false
  });
}

async function runReservedJob(reservation) {
  if (!reservation || reservation.skip || reservation.queued) return;
  const control = createRunningJobControl(reservation.job);
  const useStreamProgress = shouldUseJobStreamProgress(reservation.job);
  if (useStreamProgress) resetJobStreamProgress(reservation.job?.id, reservation.job?.request);
  try {
    const image = await generateWithAccountRetry(reservation, reservation.job.request, {
      signal: control.controller.signal,
      deadline: jobDeadlineTimestamp(reservation.job),
      forceStream: useStreamProgress,
      onProgress: useStreamProgress ? (progress) => updateJobStreamProgress(reservation.job?.id, progress) : null
    });
    if (control.controller.signal.aborted) throw control.controller.signal.reason || new Error(control.reason || 'direct generate timeout');
    if (useStreamProgress) {
      updateJobStreamProgress(reservation.job?.id, { percent: 100, step: reservation.job?.request?.steps, total: reservation.job?.request?.steps });
    }
    await completeGeneration(reservation, reservation.job.request, image, { jobId: reservation.job.id });
  } catch (error) {
    if (control.controller.signal.aborted || isAbortError(error)) {
      await cancelReservedJob(reservation, error);
      return;
    }
    if (!fairShareMode && isNovelAiCapacityError(error) && !isNovelAiVerificationError(error)) {
      await requeueReservedJob(reservation, error);
      return;
    }
    await failGeneration(reservation, error);
  } finally {
    finishRunningJobControl(reservation.job?.id, control);
    if (fairShareMode) void refreshEnabledAccountQuotas().catch(() => console.error('[fair-quota] 余额刷新失败，将在定时刷新时重试'));
  }
}

function shouldUseJobStreamProgress(job = {}) {
  return ['web', 'direct', 'openai'].includes(job.source || 'web');
}

function createRunningJobControl(job = {}) {
  const controller = new AbortController();
  let resolveDone = () => {};
  const control = {
    controller,
    done: new Promise((resolve) => {
      resolveDone = resolve;
    }),
    resolveDone,
    reason: '',
    timer: null
  };
  const jobId = job?.id || '';
  if (!jobId) return control;
  const delay = runningJobTimeoutDelay(job);
  control.timer = setTimeout(() => abortRunningJob(jobId, 'direct generate timeout'), delay);
  runningJobControls.set(jobId, control);
  return control;
}

function finishRunningJobControl(jobId, control) {
  if (!control) return;
  if (control.timer) clearTimeout(control.timer);
  if (jobId && runningJobControls.get(jobId) === control) runningJobControls.delete(jobId);
  control.resolveDone();
}

function abortRunningJob(jobId, reason = 'direct generate timeout') {
  const control = runningJobControls.get(jobId);
  if (!control) return false;
  control.reason = reason;
  if (!control.controller.signal.aborted) control.controller.abort(new Error(reason));
  return true;
}

function runningJobTimeoutDelay(job = {}) {
  const deadline = jobDeadlineTimestamp(job);
  const delays = [novelAiGenerateTimeoutMs()];
  if (deadline) delays.push(Math.max(1, deadline - Date.now()));
  return Math.max(1, Math.min(...delays));
}

function jobDeadlineTimestamp(job = {}) {
  const deadline = Date.parse(job.deadlineAt || '');
  return Number.isFinite(deadline) && deadline > 0 ? deadline : 0;
}

function novelAiGenerateTimeoutMs() {
  const configured = Number(process.env.NOVELAI_GENERATE_TIMEOUT_MS || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.max(1000, Math.floor(configured));
  return Math.max(1, accountInflightTimeoutMs() - 1000);
}

function accountInflightTimeoutMs() {
  const configured = Number(process.env.ACCOUNT_INFLIGHT_TIMEOUT_MS || 10 * 60 * 1000);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1000, Math.floor(configured)) : 10 * 60 * 1000;
}

async function generateWithAccountRetry(reservation, request, options = {}) {
  const tried = new Set();
  let firstError = null;
  let current = reservation;

  while (true) {
    if (options.signal?.aborted) throw options.signal.reason || new Error('direct generate timeout');
    if (current.account?.id) tried.add(current.account.id);
    try {
      options.onProgress?.({
        percent: 0,
        step: 0,
        total: Number(request?.steps || 0),
        accountId: current.account?.id || '',
        accountRouteId: current.account?.routeId || 0
      });
      const image = await generateNovelAiImage(request, current.account, process.env, {
        signal: options.signal,
        forceStream: options.forceStream,
        onProgress: (progress) => options.onProgress?.({
          ...progress,
          accountId: current.account?.id || '',
          accountRouteId: current.account?.routeId || 0
        })
      });
      await recordSuccessfulImageTrial(current.account, request);
      reservation.account = current.account;
      return image;
    } catch (error) {
      logNovelAiGenerateError(error, request, current.account, current.job);
      if (fairShareMode) throw error;
      if (options.signal?.aborted || isAbortError(error) || isNovelAiVerificationError(error)) throw error;
      if (!firstError) firstError = error;
      const next = await retryReservationWithNextAccount(current, error, tried, { ...options, request });
      if (!next) {
        current.account = null;
        reservation.account = null;
        throw firstError || error;
      }
      current = next;
      reservation.account = current.account;
    }
  }
}

async function retryReservationWithNextAccount(reservation, error, tried, options = {}) {
  if (!reservation.account?.id) return null;
  return store.update((db) => {
    const failedAccount = db.accounts.find((item) => item.id === reservation.account.id);
    if (failedAccount) {
      const now = new Date().toISOString();
      failedAccount.inFlight = Math.max(0, Number(failedAccount.inFlight || 0) - 1);
      failedAccount.failures = Number(failedAccount.failures || 0) + 1;
      if (isNovelAiCapacityError(error)) failedAccount.cooldownUntil = new Date(Date.now() + accountBusyCooldownMs()).toISOString();
      if (isNovelAiAccountBannedError(error)) {
        disableNovelAiAccount(failedAccount);
        failedAccount.quotaError = '账号已封禁，已自动禁用';
        failedAccount.quotaCheckedAt = now;
      }
      if (isNovelAiAccountQuotaError(error)) {
        const outOfTrial = isNovelAiOutOfTrialImageGenerationError(error);
        if (outOfTrial) disableNovelAiAccount(failedAccount);
        failedAccount.quotaError = outOfTrial ? '试用次数已用完，已自动禁用' : '点数不足';
        failedAccount.quotaCheckedAt = now;
      }
      failedAccount.updatedAt = now;
    }

    if (options.deadline && Date.now() >= options.deadline) return null;
    const accountCost = reservationAccountCost(reservation);
    const account = selectAccount(db.accounts, db.settings, { excludeIds: tried, request: options.request });
    if (!account) return null;
    account.inFlight = Number(account.inFlight || 0) + 1;
    account.lastUsedAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();

    if (reservation.job?.id) {
      const job = db.jobs.find((item) => item.id === reservation.job.id);
      if (job) {
        job.status = 'running';
        job.accountId = account.id;
        job.completedAt = '';
        job.error = '';
        job.errorDetail = '';
        job.updatedAt = new Date().toISOString();
      }
    }

    return {
      ...reservation,
      accountCost,
      account: { ...account },
      job: reservation.job ? { ...reservation.job, accountId: account.id } : reservation.job
    };
  }, { dirtyRows: dirtyReservationJobRows(reservation) });
}

async function requeueReservedJob(reservation, error) {
  let delay = accountBusyCooldownMs();
  await store.update((db) => {
    if (reservation.account?.id) {
      const account = db.accounts.find((item) => item.id === reservation.account.id);
      if (account) {
        account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
        account.cooldownUntil = new Date(Date.now() + delay).toISOString();
        account.updatedAt = new Date().toISOString();
      }
    }
    const job = reservation.job?.id ? db.jobs.find((item) => item.id === reservation.job.id) : null;
    if (job) {
      job.status = 'queued';
      job.accountId = '';
      job.completedAt = '';
      job.error = '';
      job.errorDetail = '';
      job.retryCount = Number(job.retryCount || 0) + 1;
      job.updatedAt = new Date().toISOString();
    }
    delay = Math.max(250, nextAccountReadyDelay(db.accounts, db.settings) || delay);
  }, { dirtyRows: dirtyReservationJobRows(reservation) });
  scheduleQueueDrain(delay);
  clearJobStreamProgress(reservation.job?.id);
}

async function reserveCreditAndAccount(token, request, cacheKey) {
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const cost = generationCost(request);
    if (user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const account = selectAccount(db.accounts, db.settings, { request });
    if (!account && hasEnabledAccounts(db.accounts)) {
      if (!hasAccountWithEnoughQuota(db.accounts, request)) throw httpError(503, '无符合本次参数的可用额度；试用限总像素1048576、28步以内');
      throw httpError(429, 'all NovelAI accounts are busy, retry shortly.');
    }
    if (account) {
      account.inFlight = Number(account.inFlight || 0) + 1;
      account.lastUsedAt = new Date().toISOString();
    }
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    const ledger = {
      id: createId('log'),
      type: 'charge',
      token,
      accountId: account?.id || '',
      amount: -cost,
      at: new Date().toISOString()
    };
    db.ledger.unshift(ledger);
    return { token, userId: user.id, account: account ? { ...account } : null, ledgerId: ledger.id, cost, accountCost: 0, cacheKey };
  }, {
    dirtyRows: dirtyCreditReservationRows
  });
}

async function reserveCreditAndAccountWhenAvailable(token, request, cacheKey, deadline) {
  while (Date.now() < deadline) {
    const result = await tryReserveCreditAndAccount(token, request, cacheKey);
    if (!result.busy) return result.reservation;
    await sleep(Math.min(750, Math.max(50, deadline - Date.now())));
  }
  return null;
}

async function tryReserveCreditAndAccount(token, request, cacheKey) {
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const cost = generationCost(request);
    if (user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const account = selectAccount(db.accounts, db.settings, { request });
    if (!account && hasEnabledAccounts(db.accounts)) {
      if (!hasAccountWithEnoughQuota(db.accounts, request)) throw httpError(503, '无符合本次参数的可用额度；试用限总像素1048576、28步以内');
      return { busy: true };
    }
    if (account) {
      account.inFlight = Number(account.inFlight || 0) + 1;
      account.lastUsedAt = new Date().toISOString();
    }
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    const ledger = {
      id: createId('log'),
      type: 'charge',
      token,
      accountId: account?.id || '',
      amount: -cost,
      at: new Date().toISOString()
    };
    db.ledger.unshift(ledger);
    return { busy: false, reservation: { token, userId: user.id, account: account ? { ...account } : null, ledgerId: ledger.id, cost, accountCost: 0, cacheKey } };
  }, {
    dirtyRows: dirtyCreditReservationRows,
    shouldPersist: (result) => !result?.busy
  });
}

async function completeGeneration(reservation, request, image, meta = {}) {
  const imageId = createId('img');
  const imageFile = await writeStoredImage(imageId, image);
  const accountCost = reservationAccountCost(reservation);
  let trimmedImages = [];
  let savedImage;
  try {
    savedImage = await store.update((db) => {
      // 已取消或已退款的任务不能被迟到的上游响应重新写成成功。
      if (fairShareMode && meta.jobId) {
        const currentJob = db.jobs.find(j => j.id === meta.jobId);
        if (currentJob?.status !== 'running' || currentJob.fairCharge?.status !== 'reserved') throw httpError(409, '任务已结清，忽略迟到的生成结果');
      }
      const user = getUserOrThrow(db, reservation.token);
      const account = reservation.account ? db.accounts.find((item) => item.id === reservation.account.id) : null;
      if (account) {
        account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
        account.total = Number(account.total || 0) + 1;
        account.updatedAt = new Date().toISOString();
      }

      const saved = {
        id: imageId,
        token: reservation.token,
        accountId: reservation.account?.id || '',
        cacheKey: image.mock ? '' : reservation.cacheKey || '',
        mock: Boolean(image.mock),
        prompt: request.tag,
        fullPrompt: request.prompt,
        model: request.model,
        width: request.width,
        height: request.height,
        requestedSteps: request.requestedSteps ?? request.steps,
        routedSteps: request.steps,
        cost: reservation.cost,
        accountCost,
        mimeType: image.mimeType,
        file: imageFile,
        createdAt: new Date().toISOString()
      };
      db.images.unshift(saved);

      if (meta.jobId) {
        const job = db.jobs.find((item) => item.id === meta.jobId);
        if (job) {
          if (fairShareMode) settleFairQuota(db, job, true);
          job.status = 'done';
          job.imageId = saved.id;
          job.accountId = reservation.account?.id || job.accountId || '';
          job.error = '';
          job.errorDetail = '';
          job.updatedAt = new Date().toISOString();
          job.completedAt = job.updatedAt;
        }
      }

      return { ...saved, balance: user.balance };
    }, {
      dirtyRows: (saved) => ({
        accounts: uniqueIds([reservation.account?.id]),
        images: uniqueIds([saved?.id]),
        jobs: uniqueIds([meta.jobId])
      })
    });
  } catch (error) {
    await removeStoredImages([{ id: imageId, file: imageFile }]);
    throw error;
  }
  if (meta.jobId) clearJobStreamProgress(meta.jobId);
  trimmedImages = await store.trimImageCache(null, { batchSize: imageCacheTrimBuffer() });
  await removeStoredImages(trimmedImages);
  scheduleQueueDrain();
  if (meta.jobId) {
    notifyJobWaiters(meta.jobId, { saved: savedImage, image, balance: savedImage.balance });
  }
  return savedImage;
}

async function cancelReservedJob(reservation, error) {
  const detail = errorDetailMessage(error);
  const waiterMessage = error?.message || detail || 'direct generate timeout';
  const message = publicErrorMessage(waiterMessage);
  let changed = false;
  await store.update((db) => {
    const job = reservation.job?.id ? db.jobs.find((item) => item.id === reservation.job.id) : null;
    if (!job || ['done', 'failed'].includes(job.status)) return;
    const account = reservation.account ? db.accounts.find((item) => item.id === reservation.account.id) : null;
    if (account) {
      account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
      account.updatedAt = new Date().toISOString();
    }
    refundJob(db, job, message);
    job.status = 'failed';
    job.error = message;
    job.errorDetail = detail || 'job aborted';
    job.updatedAt = new Date().toISOString();
    job.completedAt = job.updatedAt;
    changed = true;
  }, {
    dirtyRows: dirtyReservationJobRows(reservation),
    shouldPersist: () => changed
  });
  if (!changed) return;
  scheduleQueueDrain();
  if (reservation.job?.id) {
    clearJobStreamProgress(reservation.job.id);
    notifyJobWaiters(reservation.job.id, { error: waiterMessage });
  }
}

async function failGeneration(reservation, error) {
  const detail = errorDetailMessage(error);
  const message = publicErrorMessage(error?.message || detail);
  await store.update((db) => {
    if (fairShareMode && reservation.job?.id) {
      const currentJob = db.jobs.find(j => j.id === reservation.job.id);
      if (!currentJob || ['done', 'failed'].includes(currentJob.status)) return;
    }
    const user = db.users.find((item) => item.token === reservation.token);
    if (user) {
      user.balance += Number(reservation.cost || 0);
      user.updatedAt = new Date().toISOString();
    }
    const account = reservation.account ? db.accounts.find((item) => item.id === reservation.account.id) : null;
    if (account) {
      account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
      if (fairShareMode && isNovelAiCapacityError(error)) account.cooldownUntil = new Date(Date.now() + 30_000).toISOString();
      account.failures = Number(account.failures || 0) + 1;
      account.updatedAt = new Date().toISOString();
    }
    if (reservation.job?.id) {
      const job = db.jobs.find((item) => item.id === reservation.job.id);
      if (job) {
        if (fairShareMode) settleFairQuota(db, job, false);
        job.status = 'failed';
        job.error = message;
        job.errorDetail = detail;
        job.updatedAt = new Date().toISOString();
        job.completedAt = job.updatedAt;
      }
    }
    db.ledger.unshift({
      id: createId('log'),
      type: 'refund',
      token: reservation.token,
      jobId: reservation.job?.id || '',
      amount: Number(reservation.cost || 0),
      at: new Date().toISOString(),
      note: message
    });
  }, {
    dirtyRows: dirtyReservationJobRows(reservation)
  });
  scheduleQueueDrain();
  if (reservation.job?.id) {
    clearJobStreamProgress(reservation.job.id);
    notifyJobWaiters(reservation.job.id, { error: message });
  }
}

function hasUsableImageTrial(account) {
  return isUnsubscribedAccountTier(account?.quotaTier)
    && account?.trialStatusKnown === true && account?.trialEligible === true
    && Number(account?.trialRemainingImages) > 0;
}

function isImageTrialRequest(request = {}) {
  const width = Number(request?.width);
  const height = Number(request?.height);
  const steps = Number(request?.steps);
  return ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-5-full', 'nai-diffusion-5-curated'].includes(request?.model)
    && Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    && width * height <= 1048576 && Number.isInteger(steps) && steps > 0 && steps <= 28
    && !request?.characterRef;
}

function isNovelAiVerificationError(error) {
  return /recaptcha|captcha|verification required|verification failed|human verification/i.test(String(error?.message || error || ''));
}

async function recordSuccessfulImageTrial(account, request) {
  if (!hasUsableImageTrial(account) || !isImageTrialRequest(request)) return;
  // 先扣减本地余量，官方查询失败也不能重复发送已成功的生图请求。
  const remaining = Math.max(0, Number(account.trialRemainingImages) - 1);
  account.trialRemainingImages = remaining;
  account.trialUsedImages = Number(account.trialUsedImages || 0) + 1;
  try {
    await store.update((db) => {
      const item = db.accounts.find((entry) => entry.id === account.id);
      if (!item) return;
      item.trialRemainingImages = remaining;
      item.trialUsedImages = account.trialUsedImages;
    }, { collections: ['accounts'] });
    const quota = await fetchNovelAiAccountQuotaWithTimeout(account.token, account.proxyUrl);
    if (quota.trialStatusKnown !== true) return;
    // 官方状态可能短暂滞后，刷新不能恢复刚刚消耗的次数。
    quota.trialRemainingImages = Math.min(remaining, Math.max(0, Number(quota.trialRemainingImages) || 0));
    const now = new Date().toISOString();
    await store.update((db) => {
      const item = db.accounts.find((entry) => entry.id === account.id);
      if (item) applyAccountQuotaResult(item, accountQuotaResult(item.id, quota, now), now);
    }, { collections: ['accounts'] });
  } catch {
    // 成功图像仍应返回；保留已扣减的本地余量，避免查询故障触发重试。
    console.warn('[trial] 生成成功后的额度同步失败，已保留保守余量');
  }
}

function selectAccount(accounts, settings = {}, options = {}) {
  resetStaleAccountLoads(accounts);
  const excludeIds = options.excludeIds || new Set();
  const paid = requiresPaidAccount(options.request);
  const now = Date.now();
  const enabled = accounts.filter((account) => account.enabled !== false && !isAccountCoolingDown(account, now));
  if (!enabled.length) return null;
  const maxConcurrency = maxAccountConcurrency(settings);
  const available = enabled.filter((account) => {
    if (excludeIds.has(account.id)) return false;
    if (Number(account.inFlight || 0) >= maxConcurrency) return false;
    if (account.quotaTier === null || account.quotaTier === undefined || account.quotaTier === '') return false;
    if (isUnsubscribedAccountTier(account.quotaTier)) {
      return hasUsableImageTrial(account) && isImageTrialRequest(options.request);
    }
    return !paid || hasPaidQuota(account);
  });
  if (!available.length) return null;
  let candidates = available;
  let preferQuota = paid;
  if (isV5StandardAccountRequest(options.request)) {
    const freeAccounts = available.filter((account) => hasV5FreeQuota(account)
      || (hasUsableImageTrial(account) && isImageTrialRequest(options.request)));
    if (freeAccounts.length) {
      candidates = freeAccounts;
    } else {
      candidates = available.filter(hasPaidQuota);
      preferQuota = true;
    }
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => {
    const quotaA = accountQuotaPoints(a);
    const quotaB = accountQuotaPoints(b);
    if (preferQuota && (quotaA !== null || quotaB !== null)) {
      if (quotaA === null) return 1;
      if (quotaB === null) return -1;
      if (quotaA !== quotaB) return quotaB - quotaA;
    }
    const loadA = Number(a.inFlight || 0) / maxConcurrency;
    const loadB = Number(b.inFlight || 0) / maxConcurrency;
    if (loadA !== loadB) return loadA - loadB;
    return Date.parse(a.lastUsedAt || 0) - Date.parse(b.lastUsedAt || 0);
  })[0];
}

function accountQuotaPoints(account) {
  if (account?.quotaPoints === null || account?.quotaPoints === undefined || account?.quotaPoints === '') return null;
  const value = Number(account?.quotaPoints);
  return Number.isFinite(value) ? value : null;
}

function isV5StandardAccountRequest(request = {}) {
  return !requiresPaidAccount(request) && String(request?.model || '').startsWith('nai-diffusion-5');
}

function hasV5FreeQuota(account) {
  const percent = numberOrNull(account?.v5UsagePercent);
  return percent !== null && percent > 0 && !account?.v5UsageIsNegative;
}

function hasPaidQuota(account) {
  const quota = accountQuotaPoints(account);
  return account.quotaError !== '点数不足' && (quota === null || quota > 0);
}

function maxAccountConcurrency(settings = {}) {
  return fairShareMode ? 4 : 1;
}

function availableAccountSlots(accounts, settings = {}) {
  if (fairShareMode) return Math.max(0, 4 - accounts.reduce((n, a) => n + Number(a.inFlight || 0), 0));
  resetStaleAccountLoads(accounts);
  const now = Date.now();
  const allEnabled = accounts.filter((account) => account.enabled !== false);
  if (!allEnabled.length) return 1;
  const enabled = allEnabled.filter((account) => !isAccountCoolingDown(account, now));
  if (!enabled.length) return 0;
  const maxConcurrency = maxAccountConcurrency(settings);
  return enabled.reduce((sum, account) => sum + Math.max(0, maxConcurrency - Number(account.inFlight || 0)), 0);
}

function nextAccountReadyDelay(accounts, settings = {}) {
  resetStaleAccountLoads(accounts);
  const now = Date.now();
  const maxConcurrency = maxAccountConcurrency(settings);
  const enabled = accounts.filter((account) => account.enabled !== false);
  if (!enabled.length) return 0;
  if (enabled.some((account) => !isAccountCoolingDown(account, now) && Number(account.inFlight || 0) < maxConcurrency)) return 0;
  const waits = enabled
    .map((account) => Date.parse(account.cooldownUntil || '') - now)
    .filter((wait) => Number.isFinite(wait) && wait > 0);
  return waits.length ? Math.min(...waits) + 50 : 1000;
}

function scheduleQueueDrain(delay = 0) {
  if (queueDraining) {
    queueDrainRequested = true;
    return;
  }
  const runAt = Date.now() + delay;
  if (queueDrainTimer) {
    // A freed account can advance dispatch, but later retries must never postpone it.
    if (runAt >= queueDrainAt) return;
    clearTimeout(queueDrainTimer);
  }
  queueDrainAt = runAt;
  queueDrainTimer = setTimeout(() => {
    queueDrainTimer = null;
    queueDrainAt = 0;
    drainQueuedJobs();
  }, delay);
}

async function drainQueuedJobs() {
  if (queueDraining) {
    queueDrainRequested = true;
    return;
  }
  queueDraining = true;
  queueDrainRequested = false;
  try {
    const drainPlan = await store.update((db) => {
      const slots = availableAccountSlots(db.accounts, db.settings);
      if (slots <= 0) return { jobIds: [], delay: nextAccountReadyDelay(db.accounts, db.settings) };
      return {
        jobIds: db.jobs
          .filter((job) => job.status === 'queued' && isQueueActiveJob(job))
          .reverse()
          .slice(0, slots)
          .map((job) => job.id),
        delay: 0
      };
    }, { collections: ['accounts'], persist: false });
    const jobIds = drainPlan.jobIds || [];
    if (!jobIds.length && drainPlan.delay > 0) queueDrainRequested = true;
    const reservations = await Promise.all(jobIds.map((id) => reserveQueuedJob(id).catch((error) => ({ error }))));
    reservations.forEach((reservation) => {
      if (reservation?.error) {
        console.error(reservation.error);
        return;
      }
      if (reservation?.failure) notifyJobWaiters(reservation.jobId, { error: reservation.failure, statusCode: reservation.statusCode });
      if (reservation?.skip || reservation?.queued) {
        queueDrainRequested = true;
        return;
      }
      runReservedJob(reservation);
    });
  } finally {
    queueDraining = false;
    if (queueDrainRequested) {
      const delay = await queueRetryDelay();
      scheduleQueueDrain(delay);
    }
  }
}

async function queueRetryDelay() {
  const db = await store.readCollections(['settings', 'accounts']);
  return Math.max(fairShareMode ? 1000 : 25, nextAccountReadyDelay(db.accounts, db.settings) || 25);
}

function hasEnabledAccounts(accounts) {
  return accounts.some((account) => account.enabled !== false);
}

function hasAccountWithEnoughQuota(accounts, request = {}) {
  return accounts.some((account) => {
    if (account.enabled === false) return false;
    if (account.quotaTier === null || account.quotaTier === undefined || account.quotaTier === '') return false;
    if (isUnsubscribedAccountTier(account.quotaTier)) return hasUsableImageTrial(account) && isImageTrialRequest(request);
    if (isV5StandardAccountRequest(request)) return hasV5FreeQuota(account) || hasPaidQuota(account);
    return !requiresPaidAccount(request) || hasPaidQuota(account);
  });
}

function resetStaleAccountLoads(accounts) {
  const staleAfterMs = accountInflightTimeoutMs();
  const now = Date.now();
  accounts.forEach((account) => {
    if (account.cooldownUntil && Date.parse(account.cooldownUntil) <= now) account.cooldownUntil = '';
    if (Number(account.inFlight || 0) <= 0) return;
    const lastUsed = Date.parse(account.lastUsedAt || 0);
    if (!lastUsed || now - lastUsed > staleAfterMs) account.inFlight = 0;
  });
}

function isAccountCoolingDown(account, now = Date.now()) {
  const until = Date.parse(account.cooldownUntil || '');
  return Number.isFinite(until) && until > now;
}

function accountBusyCooldownMs() {
  return clamp(Number(process.env.ACCOUNT_429_COOLDOWN_MS || 800), 200, 120_000);
}

function assignAccountRouteIds(accounts) {
  const used = new Set();
  let next = 1;
  accounts.forEach((account) => {
    const current = Number(account.routeId || 0);
    if (Number.isInteger(current) && current > 0 && !used.has(current)) {
      account.routeId = current;
      used.add(current);
      next = Math.max(next, current + 1);
      return;
    }
    while (used.has(next)) next += 1;
    account.routeId = next;
    used.add(next);
    next += 1;
  });
}

function nextAccountRouteId(accounts) {
  return accounts.reduce((max, account) => Math.max(max, Number(account.routeId || 0)), 0) + 1;
}

function normalizePublicBaseUrl(value = '') {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return '';
  }
}

function getUserOrThrow(db, token) {
  const user = db.users.find((item) => item.token === token);
  if (!user || user.enabled === false) throw httpError(401, 'invalid token.');
  return user;
}

function publicUser(user, options = {}) {
  const payload = {
    id: user.id,
    token: user.token,
    balance: user.balance,
    enabled: user.enabled !== false,
    sourceCard: user.sourceCard,
    note: user.note || '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
  if (options.includeMergeTrace) {
    payload.mergedInto = user.mergedInto || '';
    payload.mergedAt = user.mergedAt || '';
    payload.mergedAmount = Number(user.mergedAmount || 0);
    payload.mergedFrom = mergedFromEntries(user.mergedFrom);
  }
  return payload;
}

function publicAdminUsers(users = []) {
  const mergedFromByTarget = new Map();
  for (const user of users) {
    if (!user?.mergedInto) continue;
    const token = String(user.mergedInto || '').trim();
    if (!token) continue;
    const entries = mergedFromByTarget.get(token) || [];
    entries.push({
      token: user.token || '',
      amount: Number(user.mergedAmount || 0),
      at: user.mergedAt || ''
    });
    mergedFromByTarget.set(token, entries);
  }

  return users.map((user) => {
    const payload = publicUser(user, { includeMergeTrace: true });
    payload.mergedFrom = uniqueMergedFromEntries([
      ...payload.mergedFrom,
      ...(mergedFromByTarget.get(user.token) || [])
    ]);
    return payload;
  });
}

function mergedFromEntries(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      token: String(entry?.token || '').trim(),
      amount: Number(entry?.amount || 0),
      at: entry?.at || ''
    }))
    .filter((entry) => entry.token);
}

function uniqueMergedFromEntries(entries = []) {
  const seen = new Set();
  const selected = [];
  for (const entry of mergedFromEntries(entries)) {
    if (seen.has(entry.token)) continue;
    seen.add(entry.token);
    selected.push(entry);
  }
  return selected;
}

function publicCard(card) {
  return {
    id: card.id,
    code: card.code,
    credits: card.credits,
    used: Boolean(card.usedBy),
    usedBy: card.usedBy ? maskToken(card.usedBy) : '',
    usedAt: card.usedAt || '',
    createdAt: card.createdAt,
    expiresAt: card.expiresAt || '',
    note: card.note || ''
  };
}

function publicAccount(account, options = {}) {
  return {
    id: account.id,
    routeId: account.routeId || 0,
    name: account.name,
    token: options.revealToken ? account.token : maskToken(account.token),
    proxyUrl: options.revealToken ? account.proxyUrl || '' : maskProxyUrl(account.proxyUrl || ''),
    hasProxy: Boolean(account.proxyUrl),
    enabled: account.enabled !== false,
    weight: account.weight || 1,
    inFlight: account.inFlight || 0,
    total: account.total || 0,
    failures: account.failures || 0,
    quotaPoints: account.quotaPoints ?? null,
    quotaFixed: account.quotaFixed ?? null,
    quotaPurchased: account.quotaPurchased ?? null,
    quotaTier: account.quotaTier ?? null,
    quotaTierText: accountTierText(account.quotaTier),
    trialRemainingImages: account.trialRemainingImages ?? null,
    trialUsedImages: account.trialUsedImages ?? null,
    trialEligible: account.trialEligible === true,
    trialStatusKnown: account.trialStatusKnown === true,
    v5UsagePercent: account.v5UsagePercent ?? null,
    v5UsageIsNegative: Boolean(account.v5UsageIsNegative),
    v5UsageTimeUntilNextPercent: account.v5UsageTimeUntilNextPercent ?? null,
    quotaCheckedAt: account.quotaCheckedAt || '',
    quotaError: account.quotaError || '',
    cooldownUntil: account.cooldownUntil || '',
    stats1h: options.stats1h || { done: 0, failed: 0, total: 0, successRate: 0 },
    lastUsedAt: account.lastUsedAt || ''
  };
}

function exportAccount(account) {
  return {
    trialRemainingImages: account.trialRemainingImages ?? null,
    trialUsedImages: account.trialUsedImages ?? null,
    trialEligible: account.trialEligible === true,
    trialStatusKnown: account.trialStatusKnown === true,
    id: account.id,
    routeId: account.routeId || 0,
    name: account.name,
    token: account.token,
    proxyUrl: account.proxyUrl || '',
    enabled: account.enabled !== false,
    weight: account.weight || 1,
    total: account.total || 0,
    failures: account.failures || 0,
    quotaPoints: account.quotaPoints ?? null,
    quotaFixed: account.quotaFixed ?? null,
    quotaPurchased: account.quotaPurchased ?? null,
    quotaTier: account.quotaTier ?? null,
    v5UsagePercent: account.v5UsagePercent ?? null,
    v5UsageIsNegative: Boolean(account.v5UsageIsNegative),
    v5UsageTimeUntilNextPercent: account.v5UsageTimeUntilNextPercent ?? null,
    quotaCheckedAt: account.quotaCheckedAt || '',
    quotaError: account.quotaError || '',
    createdAt: account.createdAt || '',
    updatedAt: account.updatedAt || '',
    lastUsedAt: account.lastUsedAt || ''
  };
}

function exportMigrationData(db) {
  const users = db.users.filter((user) => Number(user.balance || 0) > 0);
  return {
    settings: db.settings,
    cards: db.cards,
    users,
    accounts: db.accounts.map((account) => ({ ...account, inFlight: 0 })),
    jobs: [],
    images: [],
    ledger: []
  };
}

async function writeStoredImage(id, image) {
  const imageFile = imageStorageName(id, image.mimeType);
  await writeFile(path.join(dataDir, imageFile), image.buffer);
  return imageFile;
}

async function readStoredImage(image) {
  if (image.file) {
    return readFile(imageFilePath(image.file));
  }
  if (image.base64) {
    return Buffer.from(image.base64, 'base64');
  }
  throw httpError(404, 'image content not found.');
}

async function removeStoredImages(images) {
  // 私有部署保护：保留图片文件，删除前须获得用户同意。
  if (process.env.NO_AUTO_DELETE === 'true') return;
  for (let index = 0; index < images.length; index += 50) {
    const batch = images.slice(index, index + 50);
    await Promise.all(batch.map(async (image) => {
      if (!image.file) return;
      try {
        await rm(imageFilePath(image.file), { force: true });
      } catch (error) {
        console.error(`Failed to delete cached image ${image.id}:`, error);
      }
    }));
  }
}

function imageStorageName(id, mimeType = '') {
  return path.join('images', `${id}.${imageExtension(mimeType)}`);
}

function imageFilePath(file) {
  const resolved = path.resolve(dataDir, file);
  const root = path.resolve(imageDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw httpError(403, 'invalid image path.');
  return resolved;
}

function imageExtension(mimeType = '') {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('svg')) return 'svg';
  return 'png';
}

function sanitizeMigrationData(payload) {
  return {
    settings: payload.settings || {},
    cards: Array.isArray(payload.cards) ? payload.cards : [],
    users: Array.isArray(payload.users) ? payload.users : [],
    accounts: Array.isArray(payload.accounts) ? payload.accounts : [],
    jobs: [],
    images: [],
    ledger: []
  };
}

function publicJob(job, db = null) {
  const queue = db?.queue || store.jobQueueProgress(job);
  const request = job.request || {};
  const account = db?.account || (db && job.accountId ? db.accounts.find((item) => item.id === job.accountId) : null);
  return {
    id: job.id,
    source: job.source || 'web',
    status: job.status,
    prompt: request.tag || '',
    model: request.model || '',
    requestedSteps: request.requestedSteps ?? request.steps ?? 0,
    routedSteps: request.steps ?? 0,
    accountId: job.accountId || '',
    accountRouteId: account?.routeId || 0,
    cost: job.cost,
    accountCost: jobAccountCost(job),
    generationProgress: publicGenerationProgress(job),
    imageId: job.imageId || '',
    imageUrl: job.imageId ? publicImageUrl(job.imageId) : '',
    error: publicErrorMessage(job.error || ''),
    queuePosition: queue.progress,
    queuedCount: queue.total,
    durationMs: jobDurationMs(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || (['done', 'failed'].includes(job.status) ? job.updatedAt : '')
  };
}

function publicGenerationProgress(job = {}) {
  if (job.status === 'done') {
    return {
      percent: 100,
      step: Number(job.request?.steps || 0),
      total: Number(job.request?.steps || 0),
      active: false
    };
  }
  if (job.status !== 'running') {
    return {
      percent: 0,
      step: 0,
      total: Number(job.request?.steps || 0),
      active: false
    };
  }
  const progress = jobStreamProgress.get(job.id) || job.generationProgress || {};
  return {
    percent: clamp(Number(progress.percent || 0), 0, 100),
    step: Number(progress.step || 0),
    total: Number(progress.total || job.request?.steps || 0),
    active: true,
    updatedAt: progress.updatedAt || ''
  };
}

function jobDurationMs(job) {
  const started = Date.parse(job.createdAt || '');
  if (!started) return 0;
  const terminal = ['done', 'failed'].includes(job.status);
  const ended = terminal ? Date.parse(job.completedAt || job.updatedAt || '') : Date.now();
  if (!ended || ended < started) return 0;
  return ended - started;
}

function activeJobCount(jobs) {
  const now = Date.now();
  return jobs.filter((job) => isQueueActiveJob(job, now)).length;
}

function isQueueActiveJob(job, now = Date.now()) {
  if (!job || !['queued', 'running'].includes(job.status)) return false;
  return !isStaleActiveJob(job, now);
}

function isStaleActiveJob(job, now = Date.now()) {
  if (!job || !['queued', 'running'].includes(job.status)) return false;
  if (isExpiredJobAt(job, now)) return true;
  const updatedAt = Date.parse(job.updatedAt || job.createdAt || '');
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  if (job.status === 'running') return now - updatedAt > staleRunningJobMs();
  if (job.status === 'queued' && !jobDeadlineTimestamp(job)) return now - updatedAt > staleQueuedJobMs();
  return false;
}

function staleActiveJobDetail(job, now = Date.now()) {
  if (isExpiredJobAt(job, now)) return 'job deadline expired';
  return `${job.status || 'active'} job exceeded stale timeout`;
}

function isExpiredJob(job) {
  return isExpiredJobAt(job);
}

function isExpiredJobAt(job, now = Date.now()) {
  const deadline = Date.parse(job.deadlineAt || '');
  return Number.isFinite(deadline) && deadline > 0 && now >= deadline;
}

function staleQueuedJobMs() {
  return configuredTimeoutMs('STALE_QUEUED_JOB_MS', configuredTimeoutMs('STALE_ACTIVE_JOB_MS', 30 * 60 * 1000));
}

function staleRunningJobMs() {
  return configuredTimeoutMs('STALE_RUNNING_JOB_MS', accountInflightTimeoutMs() + 60 * 1000);
}

function configuredTimeoutMs(name, fallback) {
  const configured = Number(process.env[name] || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.max(60_000, Math.floor(configured));
  return Math.max(60_000, Math.floor(Number(fallback) || 60_000));
}

function refundJob(db, job, note) {
  if (fairShareMode) settleFairQuota(db, job, false);
  if (job.refundedAt) return;
  const cost = Number(job.cost || 0);
  if (cost <= 0) return;
  const user = db.users.find((item) => item.token === job.userToken);
  if (!user) return;
  user.balance += cost;
  user.updatedAt = new Date().toISOString();
  job.refundedAt = new Date().toISOString();
  db.ledger.unshift({
    id: createId('log'),
    type: 'refund',
    token: job.userToken,
    jobId: job.id || '',
    amount: cost,
    at: job.refundedAt,
    note
  });
}

function hourlyUsageStatsByDay(jobs, days = usageChartDays) {
  const keys = recentBeijingDateKeys(days);
  const buckets = new Map(keys.map((key) => [key, {
    date: key,
    label: key.slice(5),
    done: 0,
    failed: 0,
    total: 0,
    credits: 0,
    successRate: 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      done: 0,
      failed: 0,
      total: 0,
      credits: 0,
      successRate: 0
    }))
  }]));

  jobs.forEach((job) => {
    if (!['done', 'failed'].includes(job.status)) return;
    const timestamp = Date.parse(job.updatedAt || job.createdAt || '');
    if (!timestamp) return;
    const key = beijingDateKey(timestamp);
    const bucket = buckets.get(key);
    if (!bucket) return;
    const hourBucket = bucket.hours[beijingHour(timestamp)];
    if (!hourBucket) return;
    if (job.status === 'done') {
      const credits = Math.max(0, Number(job.cost || 0));
      const generated = credits >= 1 ? 1 : 0;
      bucket.done += generated;
      hourBucket.done += generated;
      bucket.credits += credits;
      hourBucket.credits += credits;
    }
    if (job.status === 'failed') bucket.failed += 1;
    if (job.status === 'failed') hourBucket.failed += 1;
  });

  return keys.map((key) => {
    const bucket = buckets.get(key);
    bucket.total = bucket.done + bucket.failed;
    bucket.successRate = bucket.total ? bucket.done / bucket.total : 0;
    bucket.hours.forEach((hour) => {
      hour.total = hour.done + hour.failed;
      hour.successRate = hour.total ? hour.done / hour.total : 0;
    });
    return bucket;
  });
}

function errorLogs(jobs, db = {}, limit = 100) {
  const cutoff = Date.now() - errorLogRetentionMs;
  return jobs
    .filter((job) => job.status === 'failed')
    .filter(isAccountErrorLogJob)
    .filter((job) => {
      const timestamp = Date.parse(job.updatedAt || job.createdAt || '');
      return timestamp && timestamp >= cutoff;
    })
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''))
    .slice(0, limit)
    .map((job) => publicErrorLog(job, db));
}

function isAccountErrorLogJob(job) {
  if (!job?.accountId) return false;
  const text = `${job.error || ''}\n${job.errorDetail || ''}`;
  if (isNovelAiCapacityError({ message: text })) return false;
  if (/all NovelAI accounts are busy|server busy|direct generate timeout|AbortError|operation was aborted/i.test(text)) return false;
  if (/job deadline expired|stale timeout|queued job exceeded|running job exceeded/i.test(text)) return false;
  if (/invalid user token|invalid STA1N|密钥额度不足|用户额度不足/i.test(text)) return false;
  return true;
}

function publicErrorLog(job, db = {}) {
  const request = job.request || {};
  const account = job.accountId && Array.isArray(db.accounts)
    ? db.accounts.find((item) => item.id === job.accountId)
    : null;
  return {
    id: job.id,
    source: job.source || 'web',
    userToken: maskToken(job.userToken || ''),
    accountId: job.accountId || '',
    accountRouteId: account?.routeId || 0,
    status: job.status,
    error: publicErrorMessage(job.error || ''),
    errorDetail: errorDetailMessage(job.errorDetail || job.error || ''),
    retryCount: Number(job.retryCount || 0),
    cost: Number(job.cost || 0),
    accountCost: jobAccountCost(job),
    queueTotal: Number(job.queueTotal || 0),
    durationMs: jobDurationMs(job),
    request: errorLogRequest(request),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || (['done', 'failed'].includes(job.status) ? job.updatedAt : ''),
    beijingDate: beijingDateKey(Date.parse(job.updatedAt || job.createdAt || ''))
  };
}

function errorLogRequest(request = {}) {
  return {
    tag: request.tag || '',
    prompt: request.prompt || '',
    artist: request.artist || '',
    negative: request.negative || '',
    model: request.model || '',
    size: request.size || '',
    width: request.width || 0,
    height: request.height || 0,
    requestedSteps: request.requestedSteps ?? request.steps ?? 0,
    routedSteps: request.steps ?? 0,
    scale: request.scale ?? '',
    cfg: request.cfg ?? '',
    sampler: request.sampler || '',
    noiseSchedule: request.noiseSchedule || '',
    seed: request.seed ?? ''
  };
}

function recentBeijingDateKeys(days) {
  const now = new Date(Date.now() + beijingOffsetMs);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - days + 1;
    return new Date(midnight + dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  });
}

function beijingDateKey(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return '';
  return new Date(value + beijingOffsetMs).toISOString().slice(0, 10);
}

function beijingHour(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return 0;
  return new Date(value + beijingOffsetMs).getUTCHours();
}

function jobStatsSince(jobs, rangeMs) {
  const since = Date.now() - rangeMs;
  return finalizeStats(jobs.reduce((stats, job) => {
    if (isQuotaFailureJob(job)) return stats;
    const createdAt = Date.parse(job.createdAt || '');
    if (!createdAt || createdAt < since) return stats;
    if (job.status === 'done') stats.done += 1;
    if (job.status === 'failed') stats.failed += 1;
    return stats;
  }, { done: 0, failed: 0 }));
}

function requestStatsSince(jobs, rangeMs) {
  const since = Date.now() - rangeMs;
  const total = jobs.reduce((sum, job) => {
    const createdAt = Date.parse(job.createdAt || '');
    return createdAt && createdAt >= since ? sum + 1 : sum;
  }, 0);
  return { total };
}

function accountStatsSince(accountId, jobs, rangeMs) {
  const since = Date.now() - rangeMs;
  return finalizeStats(jobs.reduce((stats, job) => {
    if (isQuotaFailureJob(job)) return stats;
    if (job.accountId !== accountId) return stats;
    const createdAt = Date.parse(job.createdAt || '');
    if (!createdAt || createdAt < since) return stats;
    if (job.status === 'done') stats.done += 1;
    if (job.status === 'failed') stats.failed += 1;
    return stats;
  }, { done: 0, failed: 0 }));
}

function accountStatsMapSince(jobs, rangeMs) {
  const since = Date.now() - rangeMs;
  const map = new Map();
  jobs.forEach((job) => {
    if (isQuotaFailureJob(job) || !job.accountId) return;
    const createdAt = Date.parse(job.createdAt || '');
    if (!createdAt || createdAt < since) return;
    let stats = map.get(job.accountId);
    if (!stats) {
      stats = { done: 0, failed: 0 };
      map.set(job.accountId, stats);
    }
    if (job.status === 'done') stats.done += 1;
    if (job.status === 'failed') stats.failed += 1;
  });
  map.forEach((stats, accountId) => {
    map.set(accountId, finalizeStats(stats));
  });
  return map;
}

function finalizeStats(stats) {
  const done = Number(stats.done || 0);
  const failed = Number(stats.failed || 0);
  const total = done + failed;
  return {
    done,
    failed,
    total,
    successRate: total ? done / total : 0
  };
}

function publicImage(image) {
  return {
    id: image.id,
    imageUrl: publicImageUrl(image.id),
    token: maskToken(image.token || ''),
    accountId: image.accountId || '',
    prompt: image.prompt || '',
    fullPrompt: image.fullPrompt || '',
    model: image.model || '',
    width: image.width || 0,
    height: image.height || 0,
    requestedSteps: image.requestedSteps ?? image.routedSteps ?? 0,
    routedSteps: image.routedSteps ?? image.requestedSteps ?? 0,
    cost: image.cost || 1,
    accountCost: image.accountCost || 0,
    mock: Boolean(image.mock),
    mimeType: image.mimeType || '',
    createdAt: image.createdAt || ''
  };
}

function generationCost(request = null) {
  return fairShareMode ? 0 : generationPrice(request || {});
}

function requiresPaidAccount(request = {}) {
  const dimensions = sizeMap[normalizeSizeName(request.size)];
  return Number(request?.steps) > 28
    || dimensions?.width * dimensions?.height > 1024 * 1024
    || Number(request?.width) * Number(request?.height) > 1024 * 1024;
}

// Retain historical metadata only. New jobs do not estimate or debit upstream points.
function jobAccountCost(job = {}) {
  return normalizeAccountCost(job.accountCost);
}

function reservationAccountCost(reservation = {}) {
  return normalizeAccountCost(reservation.accountCost);
}

function normalizeAccountCost(value) {
  const cost = Number(value);
  return Number.isFinite(cost) && cost > 0 ? Math.ceil(cost) : 0;
}

function normalizeSizeName(value) {
  return String(value || '').replace(/\s*\(-\d+\)\s*$/, '').trim();
}

function requestCacheKey(_token, request, explicitSeed = '') {
  return hashObject({
    request: cacheableRequest({
      ...request,
      seed: explicitSeed === undefined || explicitSeed === '' ? '' : Number(explicitSeed)
    })
  });
}

function cacheableRequest(request) {
  const { requestedSteps, ...cacheRequest } = request;
  return cacheRequest;
}

function isNoCache(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function isInsufficientBalanceError(error) {
  return Number(error?.statusCode || error?.status) === 402 || /insufficient balance|额度不足|余额不足/i.test(String(error?.message || error || ''));
}

function isNovelAiAccountQuotaError(error) {
  const text = String(error?.message || error || '');
  return /NovelAI returned (402|400|403).*?(insufficient|balance|quota|anlas|training|point|额度|余额|点数)|insufficient.*?(quota|anlas|training|point|balance)/i.test(text);
}

function isNovelAiOutOfTrialImageGenerationError(error) {
  return /out of trial image generations/i.test(String(error?.message || error || ''));
}

function isNovelAiCapacityError(error) {
  const text = String(error?.message || error || '');
  return /NovelAI returned 429|statusCode["']?\s*:\s*429|Concurrent generation is locked|并发生成被锁定|concurrent generation/i.test(text);
}

function isQuotaFailureJob(job) {
  return job?.status === 'failed' && isInsufficientBalanceError({ message: job.error });
}

function publicErrorMessage(message) {
  const text = String(message || '');
  if (isNovelAiAccountBannedError(text)) return '账号已封禁，已自动禁用';
  if (isInsufficientBalanceError({ message: text })) return insufficientBalanceMessage;
  if (/This operation was aborted|operation was aborted|direct generate timeout|AbortError/i.test(text)) return '连接超时';
  if (/invalid token/i.test(text)) return '密钥无效或已被禁用。';
  if (/all NovelAI accounts are busy|server busy/i.test(text)) return '服务器繁忙，请稍后再试。';
  return text;
}

function errorDetailMessage(error) {
  const detail = String(error?.stack || error?.message || error || '').trim();
  return detail.slice(0, 4000);
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || ''));
}

function selectUsers(db, body) {
  if (body.zeroBalance === true) {
    const users = db.users.filter((user) => Number(user.balance || 0) <= 0 && !user.mergedInto && !user.mergedAt && !user.mergedFrom?.length);
    if (!users.length) throw httpError(404, '没有可清理的 0 额度密钥。');
    return users;
  }
  const ids = new Set(collectValues(body.ids || body.users));
  const tokens = new Set(collectValues(body.tokens || body.token));
  if (!ids.size && !tokens.size) throw httpError(400, 'user ids or tokens are required.');
  const users = db.users.filter((user) => ids.has(user.id) || tokens.has(user.token));
  if (!users.length) throw httpError(404, 'no matching user tokens found.');
  return users;
}

function parseImportedAccounts(body) {
  if (Array.isArray(body.accounts)) {
    return body.accounts
      .map((account) => (typeof account === 'string' ? { token: account } : account))
      .filter((account) => String(account?.token || '').trim());
  }

  const text = String(body.tokens || body.tokenText || body.text || '').trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line, index) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.includes(',') ? line.split(',').map((part) => part.trim()) : ['', line, '', ''];
      const [name, token, third, fourth] = parts;
      const proxyUrl = looksLikeProxyUrl(third) ? third : '';
      const weight = proxyUrl ? fourth : third;
      return {
        name: name || `NovelAI imported ${index + 1}`,
        token: token || line,
        proxyUrl,
        weight: weight ? Number(weight) : 1
      };
    });
}

function normalizeAccountProxyUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const rawProxy = parseHostPortUserPassProxy(text);
  if (rawProxy) return rawProxy;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `socks5://${text}`;
  let url;
  try {
    url = new URL(withScheme.replace(/^sock5:\/\//i, 'socks5://'));
  } catch {
    throw httpError(400, 'invalid SOCKS5 proxy URL.');
  }
  if (!['socks5:', 'socks5h:'].includes(url.protocol)) {
    throw httpError(400, 'only socks5:// and socks5h:// proxies are supported.');
  }
  if (!url.hostname) throw httpError(400, 'SOCKS5 proxy host is required.');
  if (!url.port) url.port = '1080';
  return url.toString();
}

function parseProxyLines(value = '') {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeAccountProxyUrl(line));
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

function looksLikeProxyUrl(value = '') {
  const text = String(value || '').trim();
  return Boolean(text && (/^(sock5|socks5h?):\/\//i.test(text) || /^[^:@\s]+:\d{2,5}$/i.test(text) || /^[^:\s]+:\d{2,5}:[^:\s]+:.+/.test(text)));
}

function maskProxyUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.password) url.password = '******';
    if (url.username) url.username = `${url.username.slice(0, 2)}***`;
    return url.toString();
  } catch {
    return text.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:******@');
  }
}

function mergeById(current, incoming) {
  const map = new Map();
  current.forEach((item) => map.set(item.id || createId('item'), item));
  incoming.forEach((item) => {
    const key = item.id || createId('item');
    map.set(key, { ...map.get(key), ...item, id: key });
  });
  return Array.from(map.values());
}

function publicRuntimeSettings(settings = {}) {
  return {
    ...settings,
    promptApi: publicPromptApiConfig(settings.promptApi)
  };
}

function adminRuntimeSettings(settings = {}) {
  return {
    ...settings,
    promptApi: adminPromptApiConfig(settings.promptApi)
  };
}

function collectValues(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

async function serveStatic(urlPath, res, options = {}) {
  const pathname = urlPath === '/'
    ? '/index.html'
    : urlPath === '/admin' || urlPath === '/admin/'
      ? '/admin.html'
      : decodeURIComponent(urlPath);
  const filePath = path.resolve(publicDir, `.${pathname}`);
  if (!filePath.startsWith(publicDir)) throw httpError(403, 'forbidden.');

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': 'no-store',
      'content-length': content.length
    });
    res.end(options.head ? undefined : content);
  } catch {
    const content = await readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': content.length
    });
    res.end(options.head ? undefined : content);
  }
}

async function readJson(req) {
  // 公网守卫读取过的正文直接复用，避免重复消费请求流。
  if (req.publicParsedBody !== undefined) return req.publicParsedBody;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON body.');
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders()
  });
  res.end(body);
}

function sendOpenAiError(res, statusCode, message, type = 'invalid_request_error') {
  sendJson(res, statusCode, {
    error: {
      message: publicErrorMessage(message),
      type,
      param: null,
      code: type
    }
  });
}

function sendImage(res, statusCode, mimeType, buffer, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': mimeType,
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': buffer.length,
    ...corsHeaders(),
    ...extraHeaders
  });
  res.end(buffer);
}

async function sendStoredImage(res, statusCode, image, extraHeaders = {}) {
  if (!image?.file) {
    sendImage(res, statusCode, image?.mimeType || 'image/png', await readStoredImage(image), extraHeaders);
    return;
  }

  const filePath = imageFilePath(image.file);
  const fileStat = await stat(filePath);
  res.writeHead(statusCode, {
    'content-type': image.mimeType || 'image/png',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': fileStat.size,
    ...corsHeaders(),
    ...extraHeaders
  });

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const cleanup = () => {
      stream.off('error', onStreamError);
      res.off('error', onResponseError);
      res.off('finish', onFinish);
      res.off('close', onClose);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onStreamError = (error) => {
      cleanup();
      if (!res.destroyed) res.destroy(error);
      resolve();
    };
    const onResponseError = (error) => {
      cleanup();
      stream.destroy();
      reject(error);
    };
    const onFinish = () => finish();
    const onClose = () => {
      cleanup();
      stream.destroy();
      resolve();
    };
    stream.once('error', onStreamError);
    res.once('error', onResponseError);
    res.once('finish', onFinish);
    res.once('close', onClose);
    stream.pipe(res);
  });
}

function sendBusyImage(res) {
  const image = buildErrorImage('服务器繁忙，请稍后再试');
  sendImage(res, 200, image.mimeType, image.buffer, {
    'cache-control': 'no-store',
    'x-error': '1',
    'x-busy': '1',
    'retry-after': '15'
  });
}

function sendTimeoutImage(res) {
  const image = buildErrorImage('连接超时');
  sendImage(res, 200, image.mimeType, image.buffer, {
    'cache-control': 'no-store',
    'x-error': '1',
    'x-timeout': '1'
  });
}

function sendCorsPreflight(res) {
  res.writeHead(204, {
    ...corsHeaders(),
    'access-control-max-age': '86400'
  });
  res.end();
}

function sendHead(res, statusCode, headers = {}) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    ...corsHeaders(),
    ...headers
  });
  res.end();
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-admin-token,x-user-token,x-requested-with,x-request-id,user-agent,accept'
  };
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function tokenFrom(req, url) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return String(url.searchParams.get('token') || req.headers['x-user-token'] || '').trim();
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function openAiErrorType(error) {
  const statusCode = Number(error?.statusCode || 500);
  if (statusCode === 401 || statusCode === 403) return 'authentication_error';
  if (statusCode === 429) return 'rate_limit_error';
  if (statusCode >= 500) return 'server_error';
  return 'invalid_request_error';
}

function isAdmin(req, url) {
  const header = String(req.headers['x-admin-token'] || '');
  const query = process.env.PUBLIC_MODE === 'true' ? '' : String(url.searchParams.get('adminToken') || '');
  return Boolean(adminToken) && (header === adminToken || query === adminToken);
}

function assertAdmin(req, url) {
  if (isAdmin(req, url)) return;
  const suppliedToken = String(req.headers['x-admin-token'] || url.searchParams.get('adminToken') || '').trim();
  throw httpError(suppliedToken ? 401 : 403, suppliedToken ? 'invalid token.' : 'admin token required.');
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function memoryDiagnostics() {
  return {
    process: process.memoryUsage(),
    cgroup: await readCgroupMemory(),
    runtime: {
      jobWaiters: countJobWaiters(),
      jobWaiterJobs: jobWaiters.size,
      runningJobControls: runningJobControls.size,
      jobStreamProgress: jobStreamProgress.size,
      jobStreamProgressPersistState: jobStreamProgressPersistState.size,
      jobPreviewFrames: jobPreviews.frames.size,
      jobPreviewConnections: [...jobPreviews.listeners.values()].reduce((sum, clients) => sum + clients.size, 0),
      queueDrainTimer: Boolean(queueDrainTimer),
      queueDraining,
      queueDrainRequested
    },
    store: {
      runtimeJobs: store.db?.jobs?.length ?? 0,
      runtimeImages: store.db?.images?.length ?? 0,
      runtimeLedger: store.db?.ledger?.length ?? 0,
      jobRecords: safeCountRecords('jobs'),
      imageRecords: safeCountRecords('images'),
      ledgerRecords: safeCountRecords('ledger'),
      partialCollections: [...(store.partialCollections || [])]
    }
  };
}

function countJobWaiters() {
  let count = 0;
  for (const waiters of jobWaiters.values()) count += waiters?.size || 0;
  return count;
}

function safeCountRecords(collection) {
  try {
    return store.countRecords(collection);
  } catch {
    return null;
  }
}

async function readCgroupMemory() {
  const current = parseMemoryNumber(await readTextFileOrNull('/sys/fs/cgroup/memory.current'))
    ?? parseMemoryNumber(await readTextFileOrNull('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  const max = parseMemoryNumber(await readTextFileOrNull('/sys/fs/cgroup/memory.max'))
    ?? parseMemoryNumber(await readTextFileOrNull('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  const statText = await readTextFileOrNull('/sys/fs/cgroup/memory.stat')
    ?? await readTextFileOrNull('/sys/fs/cgroup/memory/memory.stat');
  const statValues = parseMemoryStat(statText);
  return {
    current,
    max,
    anon: statValues.anon ?? statValues.rss ?? null,
    file: statValues.file ?? statValues.cache ?? null,
    inactiveFile: statValues.inactive_file ?? null,
    activeFile: statValues.active_file ?? null,
    stat: statValues
  };
}

async function readTextFileOrNull(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function parseMemoryNumber(text) {
  const value = String(text || '').trim();
  if (!value || value === 'max') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseMemoryStat(text) {
  const values = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const [key, value] = line.trim().split(/\s+/);
    if (!key) return;
    const number = Number(value);
    if (Number.isFinite(number)) values[key] = number;
  });
  return values;
}

function runtimeSlowLog(label, startedAt, detail = '', thresholdMs = 500) {
  const duration = Date.now() - startedAt;
  if (duration < thresholdMs) return;
  console.log(`[runtime] slow ${label}: ${duration}ms${detail ? ` (${detail})` : ''}`);
}

function runtimeRequestLog(label, startedAt, detail = {}) {
  const duration = Date.now() - startedAt;
  const parts = Object.entries(detail)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.log(`[runtime] ${label}: total=${duration}ms${parts ? ` ${parts}` : ''}`);
}

function logNovelAiGenerateError(error, request = {}, account = {}, job = {}) {
  const message = String(error?.message || error || '');
  if (!/NovelAI returned 5\d\d/i.test(message)) return;
  const cid = message.match(/cid=([a-z0-9]+)/i)?.[1] || '-';
  console.error([
    `[runtime] NovelAI generate error status=5xx`,
    `cid=${cid}`,
    `job=${shortRuntimeId(job?.id)}`,
    `route=${account?.routeId || '-'}`,
    `account=${shortRuntimeId(account?.id)}`,
    `proxy=${account?.proxyUrl ? 1 : 0}`,
    `model=${request.model || '-'}`,
    `size=${request.width || '-'}x${request.height || '-'}`,
    `steps=${request.steps || '-'}`,
    `sampler=${request.sampler || '-'}`,
    `noise=${request.noiseSchedule || '-'}`
  ].join(' '));
}

function shortRuntimeId(value = '') {
  const text = String(value || '');
  if (!text) return '-';
  if (text.length <= 12) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function installRuntimeSafetyHandlers() {
  if (installRuntimeSafetyHandlers.installed) return;
  installRuntimeSafetyHandlers.installed = true;
  process.on('uncaughtException', (error) => {
    if (isRecoverableRuntimeAbort(error)) {
      console.error(`[runtime] recovered from async abort/socket error: ${error?.message || error}`);
      return;
    }
    console.error('[runtime] uncaught exception:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (isRecoverableRuntimeAbort(error)) {
      console.error(`[runtime] recovered from async abort/socket rejection: ${error.message}`);
      return;
    }
    console.error('[runtime] unhandled rejection:', reason);
    process.exit(1);
  });
}

function installShutdownHandlers(serverInstance) {
  if (installShutdownHandlers.installed) return;
  installShutdownHandlers.installed = true;
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[runtime] ${signal} received. Flushing SQLite changes before shutdown.`);
    if (accountQuotaRefreshTimer) clearTimeout(accountQuotaRefreshTimer);
    try {
      store.flushSync();
    } catch (error) {
      console.error('[runtime] failed to flush SQLite changes during shutdown:', error);
    }
    const forceTimer = setTimeout(() => process.exit(0), 5000);
    forceTimer.unref?.();
    serverInstance.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

function isRecoverableRuntimeAbort(error) {
  const text = String(error?.stack || error?.message || error || '');
  return isAbortError(error)
    || /direct generate timeout|This operation was aborted|ECONNRESET|ERR_STREAM_DESTROYED|socket hang up/i.test(text);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
