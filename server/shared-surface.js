// 共享模式仅开放成员门户、管理与生图所需接口，旧功能及静态回退不再可达。
const staticPaths = new Set(['/account.html', '/account.js', '/members.css', '/shared-status.js', '/admin/members.html', '/admin/members.js']);
const routes = new Map([
  ['/api/health', ['GET', 'HEAD']],
  ['/api/me/quota', ['GET']],
  ['/v1/models', ['GET']],
  ['/user/subscription', ['GET']],
  ['/v1/user/subscription', ['GET']],
  ['/ai/user/subscription', ['GET']],
  ['/v1/ai/user/subscription', ['GET']],
  ['/ai/generate-image-stream', ['POST']],
  ['/v1/ai/generate-image-stream', ['POST']],
  ['/v1/chat/completions', ['POST']],
  ['/ai/generate-image', ['POST']],
  ['/v1/ai/generate-image', ['POST']],
  ['/ai/encode-vibe', ['POST']],
  ['/v1/ai/encode-vibe', ['POST']],
  ['/ai/upscale', ['POST']],
  ['/v1/ai/upscale', ['POST']],
  ['/generate', ['GET']],
  ['/api/jobs', ['POST']],
  ['/api/jobs/events', ['GET']],
  ['/api/admin/member-management', ['GET', 'POST']],
  ['/api/admin/summary', ['GET']],
  ['/api/admin/ping', ['GET']],
  ['/api/admin/accounts', ['POST', 'PATCH']],
  ['/api/admin/accounts/quota', ['POST']],
  ['/api/admin/fair-quota', ['POST']],
]);
export function sharedSurface(pathname, method = 'GET') {
  const alias = pathname === '/' || pathname === '/index.html' ? '/account.html'
    : ['/admin', '/admin/', '/admin.html'].includes(pathname) ? '/admin/members.html' : pathname;
  if (staticPaths.has(alias)) return { allowed: ['GET', 'HEAD'].includes(method), pathname: alias };
  let methods = routes.get(pathname);
  if (/^\/api\/member\/(login|logout)$/.test(pathname)) methods = ['POST'];
  if (/^\/api\/member\/(me|key|shared-status|shared-events)$/.test(pathname)) methods = ['GET'];
  if (/^\/api\/jobs\/[^/]+(?:\/content)?$/.test(pathname)) methods ||= ['GET'];
  if (/^\/api\/images\/[^/]+\/content$/.test(pathname)) methods = ['GET'];
  if (/^\/api\/admin\/accounts\/[^/]+$/.test(pathname)) methods ||= ['PATCH'];
  return { allowed: Boolean(methods && (methods.includes(method) || method === 'OPTIONS')), pathname };
}
