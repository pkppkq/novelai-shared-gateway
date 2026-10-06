// Only the latest preview of each running job lives here. Never persisted.
export class JobPreviews {
  frames = new Map();
  listeners = new Map();

  subscribe(token, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no'
    });
    res.write(': connected\n\n');
    const listeners = this.listeners.get(token) || new Set();
    listeners.add(res);
    this.listeners.set(token, listeners);
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableNeedDrain) res.write(': keepalive\n\n');
    }, 15000);
    heartbeat.unref();
    res.once('close', () => {
      clearInterval(heartbeat);
      listeners.delete(res);
      if (!listeners.size) this.listeners.delete(token);
    });
    for (const frame of this.frames.values()) {
      if (frame.token === token) this.send(res, frame);
    }
  }

  update(job, progress) {
    if (!job || job.status !== 'running') return;
    const buffer = progress.previewBuffer;
    if (!buffer?.length || buffer.length > 512 * 1024) return;
    const previous = this.frames.get(job.id);
    const now = Date.now();
    const frame = {
      token: job.userToken, jobId: job.id, buffer,
      mimeType: progress.previewMimeType,
      progress: { percent: progress.percent, step: progress.step, total: progress.total },
      sentAt: previous?.sentAt || 0
    };
    this.frames.set(job.id, frame);
    // Bound repaint/network work while retaining the newest frame for reconnects.
    if (now - frame.sentAt < 150) return;
    frame.sentAt = now;
    const listeners = this.listeners.get(frame.token);
    if (!listeners?.size) return;
    const message = this.message(frame);
    for (const res of listeners) this.send(res, frame, message);
  }

  message(frame) {
    return `data: ${JSON.stringify({
      jobId: frame.jobId,
      progress: frame.progress,
      preview: `data:${frame.mimeType};base64,${frame.buffer.toString('base64')}`
    })}\n\n`;
  }

  send(res, frame, message) {
    // Slow/disconnected clients must not block generation or queue old frames.
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) {
      res.write(message || this.message(frame));
    }
  }

  clear(jobId) {
    this.frames.delete(jobId);
  }
}
