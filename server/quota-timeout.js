// 取消信号不保证底层请求一定结束；独立截止时间负责释放整批额度刷新。
export async function withQuotaRequestDeadline(request, timeoutMs = 15_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('额度查询超时时间必须大于零');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('订阅状态查询超时，将在下一轮自动重试'), {
        name: 'TimeoutError', code: 'QUOTA_REQUEST_TIMEOUT'
      });
      // 先结束等待，再取消网络；底层吞掉取消错误时也不能被当作本轮成功。
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    // Promise.race 也接住迟到的拒绝，过期结果不会回流到本轮账本更新。
    return await Promise.race([Promise.resolve().then(() => request(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
