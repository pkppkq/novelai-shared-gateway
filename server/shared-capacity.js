// 每份 Opus 独立控制并发；这里只保存调度状态，不改变成员额度或请求参数。
export const SHARED_ACCOUNT_MAX_CONCURRENCY = 4;
export const SHARED_ACCOUNT_START_GAP_MS = 10_000;
const PROBE_DELAY_MS = 15 * 60_000;
const SUCCESSES_BEFORE_PROBE = 20;
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value || '') || 0;

export function sharedAccountConcurrency(account, now = Date.now()) {
  const learned = Number(account?.capacityConcurrencyLimit);
  if (Number.isInteger(learned) && learned >= 1 && learned <= SHARED_ACCOUNT_MAX_CONCURRENCY) return learned;
  // 旧版仅保存五分钟窗口；迁移时保留尚未结束的窗口，不永久惩罚过去的失败。
  return timestamp(account?.capacityLimitedUntil) > now ? 1 : SHARED_ACCOUNT_MAX_CONCURRENCY;
}

export function sharedAccountReadyDelay(account, now = Date.now(), activeRequests = account?.inFlight) {
  const cooldown = Math.max(0, timestamp(account?.cooldownUntil) - now);
  // 空闲账户立即派发；已有任务时错开发送，避免把四个槽位理解为同时突发四次。
  const lastStart = timestamp(account?.lastSharedDispatchAt || account?.lastUsedAt);
  const spacing = count(activeRequests) > 0 && lastStart > 0 ? Math.max(0, lastStart + SHARED_ACCOUNT_START_GAP_MS - now) : 0;
  return Math.max(cooldown, spacing);
}

export function recordSharedCapacityError(account, now = Date.now(), activeRequests = account?.inFlight) {
  if (!account) return;
  const previous = sharedAccountConcurrency(account, now);
  const legacyStrike = timestamp(account.capacityLimitedUntil) > now ? 1 : 0;
  account.capacityStrikeCount = Math.min(4, Math.max(legacyStrike, count(account.capacityStrikeCount)) + 1);
  account.capacityConcurrencyLimit = Math.max(1, Math.min(previous - 1, count(activeRequests) - 1));
  account.capacitySuccesses = 0;
  account.capacityLastErrorAt = new Date(now).toISOString();
  const cooldownMs = Math.min(120_000, 30_000 * 2 ** (account.capacityStrikeCount - 1));
  account.cooldownUntil = new Date(Math.max(timestamp(account.cooldownUntil), now + cooldownMs)).toISOString();
  // 再次拒绝时延长观察期，不能每五分钟重新撞到相同的并发锁。
  account.capacityProbeAfter = new Date(now + PROBE_DELAY_MS * 2 ** (account.capacityStrikeCount - 1)).toISOString();
}

export function recordSharedCapacitySuccess(account, now = Date.now(), startedAt = now) {
  if (!account) return;
  const limit = sharedAccountConcurrency(account, now);
  if (limit >= SHARED_ACCOUNT_MAX_CONCURRENCY) return;
  // 报错前已派发的迟到成功不能用来证明报错后的容量已经恢复。
  if (timestamp(startedAt) < timestamp(account.capacityLastErrorAt)) return;
  account.capacityConcurrencyLimit = limit;
  account.capacityStrikeCount = Math.max(1, count(account.capacityStrikeCount));
  account.capacitySuccesses = Math.min(SUCCESSES_BEFORE_PROBE, count(account.capacitySuccesses) + 1);
  if (!timestamp(account.capacityProbeAfter)) account.capacityProbeAfter = new Date(now + PROBE_DELAY_MS).toISOString();
  if (now < timestamp(account.capacityProbeAfter) || account.capacitySuccesses < SUCCESSES_BEFORE_PROBE) return;
  // 由正常成功请求逐级恢复，不主动发送探测图片，也不一次恢复到四并发。
  account.capacityConcurrencyLimit = Math.min(SHARED_ACCOUNT_MAX_CONCURRENCY, limit + 1);
  account.capacitySuccesses = 0;
  account.capacityProbeAfter = new Date(now + PROBE_DELAY_MS).toISOString();
  if (account.capacityConcurrencyLimit === SHARED_ACCOUNT_MAX_CONCURRENCY) account.capacityStrikeCount = 0;
}
