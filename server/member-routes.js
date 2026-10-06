import { setMemberCredentials, loginMember, checkMemberLoginRate, createMemberSession, authenticateMemberSession, logoutMemberSession } from './member-auth.js';
import { configureFairGroups, fairQuotaSummary, syncFairQuota } from './fair-quota.js';
import { sharedAccountStatus } from './shared-status.js';
const statusStreams = new Map();
const error = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const cookieName = 'nai_member_session';
function cookie(req) { return String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || ''; }
function sameOrigin(req) {
  const host = String(req.headers.host || '');
  const origin = req.headers.origin;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const expected = `${local ? 'http' : 'https'}://${host}`;
  if ((origin && origin !== expected) || req.headers['sec-fetch-site'] === 'cross-site') error(403, '此接口仅允许本站访问');
  if (!['GET', 'HEAD'].includes(req.method) && origin !== expected) error(403, '缺少本站 Origin');
}
function reply(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), 'x-content-type-options': 'nosniff' });
  res.end(text);
}
async function json(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) error(415, '仅接受 JSON');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32768) error(413, '请求过大'); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { error(400, 'JSON 格式错误'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') error(400, '请求内容无效');
  return value;
}
function setCookie(req, res, token) {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || ''));
  res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/api/member; HttpOnly; SameSite=Strict; Max-Age=${token ? 43200 : 0}${local ? '' : '; Secure'}`);
}

export async function handleMemberRoutes(req, res, url, deps) {
  const member = url.pathname.startsWith('/api/member/');
  const admin = url.pathname === '/api/admin/member-management';
  if (!member && !admin) return false;
  sameOrigin(req);
  const { store } = deps;
  if (admin) {
    // 管理 API 同时保留私有入口限制和管理员密钥校验，成员会话不参与鉴权。
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ''))) error(404, 'not found.');
    deps.assertAdmin(req, url);
    if (req.method === 'GET') {
      const payload = await store.update(db => {
        syncFairQuota(db);
        return { groups: db.settings.fairQuota?.groups || [], status: db.settings.fairQuota?.status,
          autoAnlasFallback: db.settings.fairQuota?.autoAnlasFallback === true,
          users: db.users.map(u => ({ id: u.id, username: u.memberAuth?.username || '', note: u.note || '', enabled: u.enabled !== false,
            quota: fairQuotaSummary(db, u) })) };
      }, { collections: ['settings'] });
      reply(res, 200, payload); return true;
    }
    if (req.method !== 'POST') error(405, 'method not allowed');
    const body = await json(req);
    if (body.action === 'fallback-policy') {
      if (typeof body.enabled !== 'boolean') error(400, 'enabled 必须为布尔值');
      await store.update(db => {
        const state = db.settings.fairQuota;
        if (!state?.enabled) error(409, '共享账本尚未配置');
        state.autoAnlasFallback = body.enabled;
        state.policyHistory = [...(state.policyHistory || []), { at: Date.now(), actor: 'administrator', autoAnlasFallback: body.enabled }].slice(-1000);
      }, { collections: ['settings'], immediate: true });
      reply(res, 200, { autoAnlasFallback: body.enabled }); return true;
    }
    if (body.action === 'credentials') {
      const result = await store.update(async db => {
        const draft = { users: structuredClone(db.users) };
        let userId = body.userId;
        if (!userId) {
          if (draft.users.length >= 200) error(409, '账户数已达上限');
          const user = { id: deps.createId('usr'), token: deps.createPublicToken('STA1N'), balance: 0, enabled: true,
            note: String(body.note || '管理员创建的成员').slice(0, 120), createdAt: new Date().toISOString() };
          userId = user.id; draft.users.push(user);
        }
        const result = await setMemberCredentials(draft, userId, body);
        db.users = draft.users;
        return result;
      }, { collections: ['users'], immediate: true });
      reply(res, 200, result); return true;
    }
    if (body.action === 'groups') {
      const result = await store.update(db => {
        configureFairGroups(db, body.groups, { actorId: 'administrator', redistributeRemaining: body.redistributeRemaining === true });
        syncFairQuota(db);
        return { groups: db.settings.fairQuota.groups, status: db.settings.fairQuota.status };
      }, { collections: ['settings'], immediate: true });
      reply(res, 200, result); return true;
    }
    error(400, '不支持的管理操作');
  }

  if (url.pathname === '/api/member/login' && req.method === 'POST') {
    const body = await json(req);
    checkMemberLoginRate(body.username, req.socket?.remoteAddress || 'unknown');
    const user = await store.update(db => loginMember(db, body.username, body.password), { persist: false });
    setCookie(req, res, createMemberSession(user));
    reply(res, 200, { ok: true }); return true;
  }
  if (url.pathname === '/api/member/logout' && req.method === 'POST') {
    logoutMemberSession(cookie(req)); setCookie(req, res, ''); reply(res, 200, { ok: true }); return true;
  }
  const user = await store.update(db => authenticateMemberSession(db, cookie(req)), { persist: false });
  if (!user) error(401, '请先登录');
  if (req.method !== 'GET') error(403, '成员账户没有管理权限，请联系管理员');
  if (url.pathname === '/api/member/shared-status') {
    const state = await store.update(db => sharedAccountStatus(db), { persist: false });
    reply(res, 200, state); return true;
  }
  if (url.pathname === '/api/member/shared-events') {
    if ((statusStreams.get(user.id) || 0) >= 3 || [...statusStreams.values()].reduce((n, v) => n + v, 0) >= 100) error(429, '状态连接过多，请关闭多余页面');
    statusStreams.set(user.id, (statusStreams.get(user.id) || 0) + 1);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'connection': 'keep-alive' });
    res.flushHeaders?.();
    let closed = false, timer, previous = '', heartbeat = 0;
    const stop = () => {
      if (closed) return;
      closed = true; clearTimeout(timer);
      const count = (statusStreams.get(user.id) || 1) - 1;
      if (count) statusStreams.set(user.id, count); else statusStreams.delete(user.id);
    };
    res.once('close', stop); res.once('error', stop);
    const tick = async () => {
      try {
        const state = await store.update(db => authenticateMemberSession(db, cookie(req)) ? sharedAccountStatus(db) : null, { persist: false });
        if (closed) return;
        if (!state) { res.write('event: auth-expired\ndata: {}\n\n'); res.end(); stop(); return; }
        const text = JSON.stringify(state);
        if (text !== previous) { res.write(`event: shared-status\ndata: ${text}\n\n`); previous = text; heartbeat = Date.now(); }
        else if (Date.now() - heartbeat > 15000) { res.write(': keepalive\n\n'); heartbeat = Date.now(); }
        if (res.writableLength > 65536) { res.end(); stop(); return; }
      } catch { if (!closed) { res.end(); stop(); } return; }
      if (!closed) { timer = setTimeout(tick, 2000); timer.unref?.(); }
    };
    void tick();
    return true;
  }
  if (url.pathname === '/api/member/key') {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || ''));
    reply(res, 200, { apiKey: user.token, baseUrl: `${local ? 'http' : 'https'}://${req.headers.host}/v1` }); return true;
  }
  if (url.pathname === '/api/member/me') {
    const payload = await store.update(db => ({ username: user.memberAuth.username, quota: fairQuotaSummary(db, user),
      jobs: db.jobs.filter(j => j.userToken === user.token).slice(0, 30).map(j => ({ id: j.id, createdAt: j.createdAt,
        model: j.request?.model || '', status: j.status, charge: j.fairCharge ? { resource: j.fairCharge.resource, amount: j.fairCharge.amount, status: j.fairCharge.status, estimated: j.fairCharge.estimated,
          billingMode: j.fairCharge.billingMode || null, v5Equivalent: j.fairCharge.v5Equivalent ?? null, upstreamBilling: j.fairCharge.upstreamBilling || null } : null }))
    }), { collections: ['settings'] });
    reply(res, 200, payload); return true;
  }
  error(404, 'not found.');
}
