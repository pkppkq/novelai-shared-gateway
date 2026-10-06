import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
const sessions = new Map();
const attempts = new Map();
const ttl = 12 * 60 * 60 * 1000;
const windowMs = 15 * 60 * 1000;
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const normalized = value => String(value || '').trim().toLowerCase();

export async function setMemberCredentials(db, userId, input) {
  const user = db.users.find(u => u.id === userId && u.enabled === true);
  if (!user) fail(404, '账户不存在或未启用');
  const username = normalized(input.username);
  const password = input.password;
  if (!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username)) fail(400, '用户名需为 3–40 位字母、数字、下划线、点或短横线');
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, '密码需为 12–128 个字符');
  if (db.users.some(u => u.id !== userId && u.memberAuth?.username === username)) fail(409, '用户名已存在');
  const salt = randomBytes(24).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  user.memberAuth = { username, salt, hash, version: randomBytes(16).toString('hex') };
  user.updatedAt = new Date().toISOString();
  return { id: user.id, username };
}

function prune(map, now) {
  for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
}

export function checkMemberLoginRate(username, remote, now = Date.now()) {
  prune(attempts, now);
  const keys = [`user:${normalized(username).slice(0, 128)}`, `remote:${String(remote).slice(0, 128)}`];
  const limits = [10, 120];
  if (attempts.size >= 10000 || keys.some((key, i) => (attempts.get(key)?.count || 0) >= limits[i])) fail(429, '登录尝试过多，请 15 分钟后重试');
  // 对每次尝试计数，防止并发请求在密码校验完成前绕过限制。
  keys.forEach(key => { const a = attempts.get(key) || { count: 0, expiresAt: now + windowMs }; a.count++; attempts.set(key, a); });
}

export async function loginMember(db, username, password) {
  const user = db.users.find(u => u.memberAuth?.username === normalized(username));
  const auth = user?.memberAuth;
  const candidate = typeof password === 'string' && password.length <= 128 ? password : '';
  // 不存在的账户也执行相同派生过程，避免通过响应时间枚举用户名。
  const hash = await scrypt(candidate, auth?.salt || '000000000000000000000000000000000000000000000000', 64);
  const expected = auth?.hash && /^[a-f0-9]{128}$/.test(auth.hash) ? Buffer.from(auth.hash, 'hex') : Buffer.alloc(64);
  if (!timingSafeEqual(hash, expected) || !auth || user.enabled !== true || !candidate) fail(401, '用户名或密码错误');
  return user;
}

export function createMemberSession(user, now = Date.now()) {
  prune(sessions, now);
  if (sessions.size >= 10000) fail(503, '登录会话已满，请稍后重试');
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, version: user.memberAuth.version, expiresAt: now + ttl });
  return token;
}

export function authenticateMemberSession(db, token, now = Date.now()) {
  const session = sessions.get(token);
  if (!session || session.expiresAt <= now) { sessions.delete(token); return null; }
  const user = db.users.find(u => u.id === session.userId && u.enabled === true && u.memberAuth?.version === session.version);
  if (!user) sessions.delete(token);
  return user || null;
}

export function logoutMemberSession(token) { sessions.delete(token); }
