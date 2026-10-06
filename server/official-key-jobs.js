import { createHash, randomUUID } from 'node:crypto';

export const isOfficialKey = token => String(token || '').startsWith('pst-');

export function officialKeyOwner(token) {
  if (!/^pst-[A-Za-z0-9_-]{1,256}$/.test(token || '')) throw failure(401, '官方密钥格式不正确。');
  return `official:${createHash('sha256').update(token).digest('hex')}`;
}

export function officialKeyError(error) {
  const message = String(error?.message || '');
  if (/401|403|unauthorized|invalid.*token/i.test(message)) return failure(401, '官方密钥无效或账号不可用。');
  if (/402|insufficient|out.of.trial|not enough|balance/i.test(message)) return failure(402, 'NovelAI 账号额度不足。');
  if (/429|concurrent|busy/i.test(message)) return failure(429, '你的 NovelAI 账号正在忙，请稍后重试。');
  if (/abort|timeout|超时/i.test(message)) return failure(504, '官方账号请求超时，请稍后重试。');
  // Upstream errors may echo request headers; never return their body or raw key.
  return failure(502, 'NovelAI 请求失败，请稍后重试。');
}

function failure(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// Independent, bounded queue: no site users, account-pool reservation or billing.
// Raw keys live only in pending requests and are discarded on completion/failure.
export class OfficialKeyJobs {
  jobs = new Map();
  queue = [];
  running = new Set();

  constructor({ generate, saveImage, findImage, previews, maxRunning = 16, maxJobs = 512, retentionMs = 30 * 60_000 }) {
    Object.assign(this, { generate, saveImage, findImage, previews, maxRunning, maxJobs, retentionMs });
  }

  async create(token, request, { cacheKey, noCache = true, timeoutMs = 600_000 } = {}) {
    const owner = officialKeyOwner(token);
    const cached = noCache ? null : await this.findImage(cacheKey);
    // Check again after the async cache lookup to coalesce simultaneous requests.
    if (!noCache) {
      for (const job of this.jobs.values()) {
        if (job.owner === owner && job.cacheKey === cacheKey && ['queued', 'running'].includes(job.status)) return this.snapshot(job);
      }
    }
    this.prune();
    if (this.jobs.size >= this.maxJobs || this.queue.filter(job => job.owner === owner).length >= 8) {
      throw failure(429, '官方密钥任务过多，请等待已有任务完成。');
    }
    const now = new Date().toISOString();
    const job = {
      id: `job_pst_${randomUUID()}`, owner, userToken: owner, cacheKey,
      request, token, status: 'queued', createdAt: now, updatedAt: now,
      queueTotal: Math.max(2, this.queue.filter(item => item.owner === owner).length + (this.running.has(owner) ? 1 : 0) + 1),
      generationProgress: { percent: 0, step: 0, total: request.steps },
      controller: new AbortController()
    };
    job.done = new Promise(resolve => { job.resolve = resolve; });
    this.jobs.set(job.id, job);
    if (cached) {
      this.finish(job, 'done', { image: cached, cacheHit: true });
    } else {
      job.timer = setTimeout(() => {
        job.controller.abort();
        this.finish(job, 'failed', { error: '官方账号请求超时，请稍后重试。' });
        this.drain();
      }, timeoutMs);
      job.timer.unref?.();
      this.queue.push(job);
      this.drain();
    }
    return this.snapshot(job);
  }

  get(id, token) {
    const job = this.jobs.get(id);
    if (!job) throw failure(404, '任务已过期，请重新提交。');
    if (job.owner !== officialKeyOwner(token)) throw failure(403, '无权访问该任务。');
    return job;
  }

  snapshot(job) {
    const ahead = this.queue.slice(0, this.queue.indexOf(job)).filter(item => item.owner === job.owner).length + (this.running.has(job.owner) ? 1 : 0);
    return {
      id: job.id, status: job.status, authMode: 'official', cost: 0,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
      queuePosition: job.status === 'queued' ? Math.max(1, Math.min(job.queueTotal - 1, job.queueTotal - ahead)) : job.queueTotal,
      queuedCount: job.queueTotal, generationProgress: { ...job.generationProgress },
      imageUrl: job.image ? `/api/images/${job.image.id}/content` : '', error: job.error || ''
    };
  }

  drain() {
    this.queue = this.queue.filter(job => job.status === 'queued');
    for (const job of [...this.queue]) {
      if (this.running.size >= this.maxRunning) break;
      if (this.running.has(job.owner)) continue;
      this.queue.splice(this.queue.indexOf(job), 1);
      this.running.add(job.owner);
      job.status = 'running';
      job.updatedAt = new Date().toISOString();
      void this.run(job);
    }
  }

  async run(job) {
    try {
      const image = await this.generate(job.request, { token: job.token }, {
        signal: job.controller.signal, forceStream: true,
        onProgress: progress => {
          if (job.status !== 'running') return;
          job.generationProgress = {
            percent: Math.max(job.generationProgress.percent, Math.min(100, Number(progress.percent) || 0)),
            step: Number(progress.step) || 0, total: job.request.steps
          };
          this.previews.update(job, progress);
        }
      });
      if (job.status !== 'running') return;
      const saved = await this.saveImage(job, image);
      if (job.status === 'running') this.finish(job, 'done', { image: saved });
    } catch (error) {
      if (job.status === 'running') this.finish(job, 'failed', { error: officialKeyError(error).message });
    } finally {
      this.running.delete(job.owner);
      this.drain();
    }
  }

  finish(job, status, result) {
    if (['done', 'failed'].includes(job.status)) return;
    clearTimeout(job.timer);
    Object.assign(job, result, { status, updatedAt: new Date().toISOString() });
    if (status === 'done') job.generationProgress.percent = 100;
    delete job.token;
    delete job.request;
    this.previews.clear(job.id);
    job.resolve(job);
    delete job.resolve;
  }

  prune() {
    for (const [id, job] of this.jobs) {
      if (['done', 'failed'].includes(job.status) && (Date.now() - Date.parse(job.updatedAt) > this.retentionMs || this.jobs.size >= this.maxJobs)) this.jobs.delete(id);
    }
  }
}
