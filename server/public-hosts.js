const localHost = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
const dnsHost = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// 仅按 Host 与显式配置逐项匹配；不信任转发头、通配符、后缀或 URL 格式配置。
export function isPublicHost(host, env = process.env) {
  if (env.PUBLIC_MODE !== 'true' || typeof host !== 'string') return false;
  const normalized = host.toLowerCase();
  if (!dnsHost.test(normalized)) return false;
  const configured = [env.PUBLIC_HOST, ...String(env.PUBLIC_HOST_ALIASES || '').split(',')];
  return configured.some(value => {
    const allowed = String(value || '').trim().toLowerCase();
    return dnsHost.test(allowed) && normalized === allowed;
  });
}

// 保留私有入口的同源限制；公开别名只扩展成员客户端入口，管理路由仍独立校验本机 Host。
export function privateAccessAllowed(req, env = process.env) {
  const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
  const publicHost = isPublicHost(host, env);
  const publicClient = publicHost && !/^\/(?:api\/admin|admin|memory)(?:[/?]|$)/.test(req.url || '/');
  const origin = req.headers.origin;
  const originAllowed = publicClient || !origin || origin === `http://${host}` || origin === `https://${host}`;
  return (localHost.test(host) || publicHost) && originAllowed && (publicClient || req.headers['sec-fetch-site'] !== 'cross-site');
}
