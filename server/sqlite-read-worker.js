import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const sqlite = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
sqlite.pragma('query_only = ON');
sqlite.pragma('busy_timeout = 3000');

parentPort.on('message', ({ id, type, payload = {} }) => {
  try {
    const result = type === 'adminStats'
      ? readAdminStats(payload)
      : type === 'imagePage'
        ? readImagePage(payload)
        : type === 'userPage'
          ? readUserPage(payload)
          : (() => { throw new Error(`Unknown read task: ${type}`); })();
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message || String(error) });
  }
});

function readAdminStats({ now = Date.now(), days = 7 } = {}) {
  const oneMinuteAgo = new Date(now - 60_000).toISOString();
  const oneHourAgo = new Date(now - 60 * 60_000).toISOString();
  const chartCutoff = new Date(now - days * 24 * 60 * 60_000).toISOString();
  const requestRow = sqlite.prepare(`
    SELECT COUNT(*) AS total
    FROM jobs INDEXED BY idx_jobs_created_stats
    WHERE created_at >= ?
  `).get(oneMinuteAgo);
  // Generation prices start at 1; zero/fractional-cost completions are cached deliveries.
  const generationRow = sqlite.prepare(`
    SELECT COUNT(*) AS total
    FROM jobs INDEXED BY idx_jobs_updated_stats
    WHERE updated_at >= @since AND updated_at <= @now
      AND status = 'done' AND cost >= 1
  `).get({ since: oneMinuteAgo, now: new Date(now).toISOString() });
  const accountRows = sqlite.prepare(`
    SELECT status, account_id AS accountId, stats_excluded AS statsExcluded, COUNT(*) AS count
    FROM jobs INDEXED BY idx_jobs_created_stats
    WHERE created_at >= @since
      AND status IN ('done', 'failed')
    GROUP BY status, account_id, stats_excluded
  `).all({ since: oneHourAgo });
  const speedRows = sqlite.prepare(`
    SELECT
      CASE
        WHEN model LIKE 'nai-diffusion-5%' THEN 'v5'
        WHEN model LIKE 'nai-diffusion-4-5%' THEN 'v45'
        ELSE ''
      END AS modelVersion,
      COUNT(*) AS count,
      SUM(MAX(0, (julianday(updated_at) - julianday(created_at)) * 86400.0)) AS durationSeconds
    FROM jobs INDEXED BY idx_jobs_updated_stats
    WHERE updated_at >= @since
      AND status = 'done'
      AND created_at IS NOT NULL
      AND model LIKE 'nai-diffusion-%'
    GROUP BY modelVersion
  `).all({ since: oneHourAgo });
  const usageRows = sqlite.prepare(`
    SELECT
      strftime('%Y-%m-%d', datetime(updated_at, '+8 hours')) AS date,
      CAST(strftime('%H', datetime(updated_at, '+8 hours')) AS INTEGER) AS hour,
      status,
      SUM(CASE WHEN status = 'failed' OR cost >= 1 THEN 1 ELSE 0 END) AS count,
      SUM(CASE WHEN status = 'done' THEN cost ELSE 0 END) AS credits
    FROM jobs INDEXED BY idx_jobs_updated_stats
    WHERE updated_at >= @cutoff
      AND status IN ('done', 'failed')
    GROUP BY date, hour, status
  `).all({ cutoff: chartCutoff });

  const jobStats = { done: 0, failed: 0 };
  const accountStats = {};
  const speed = {
    v45: { seconds: null, count: 0 },
    v5: { seconds: null, count: 0 }
  };
  const speedTotals = { v45: 0, v5: 0 };

  for (const row of accountRows) {
    const count = Number(row.count || 0);
    if (!row.statsExcluded && (row.status === 'done' || row.status === 'failed')) {
      jobStats[row.status] += count;
      if (row.accountId) {
        accountStats[row.accountId] ||= { done: 0, failed: 0 };
        accountStats[row.accountId][row.status] += count;
      }
    }
  }
  for (const row of speedRows) {
    if (!speed[row.modelVersion]) continue;
    speed[row.modelVersion].count = Number(row.count || 0);
    speedTotals[row.modelVersion] = Number(row.durationSeconds || 0);
  }

  for (const version of Object.keys(speed)) {
    const count = speed[version].count;
    speed[version].seconds = count ? Math.max(0, speedTotals[version] / count) : null;
  }
  for (const accountId of Object.keys(accountStats)) accountStats[accountId] = finalizeStats(accountStats[accountId]);

  return {
    requestStats1m: { total: Number(requestRow?.total || 0) },
    generationStats1m: { total: Number(generationRow?.total || 0) },
    jobStats1h: finalizeStats(jobStats),
    generationSpeed1h: speed,
    accountStats1h: accountStats,
    usageHourlyDays: buildUsageDays(usageRows, now, days),
    statsRowsRead: accountRows.length + speedRows.length + usageRows.length + 2
  };
}

function readImagePage({ limit = 60, offset = 0, q = '', tier = '', model = '' } = {}) {
  const filters = [];
  const params = { limit, offset };
  if (tier) {
    filters.push('resolution_tier = @tier');
    params.tier = tier;
  }
  if (model) {
    filters.push('model = @model');
    params.model = model;
  }
  if (q) {
    filters.push('search_text LIKE @q');
    params.q = `%${q}%`;
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const total = Number(sqlite.prepare('SELECT COUNT(*) AS count FROM images').get()?.count || 0);
  const matched = filters.length
    ? Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM images ${where}`).get(params)?.count || 0)
    : total;
  const rows = sqlite.prepare(`
    SELECT data FROM images
    ${where}
    ORDER BY order_value DESC
    LIMIT @limit OFFSET @offset
  `).all(params);
  return { images: parseRows(rows), total, matched, offset, limit };
}

function readUserPage({ limit = 300, offset = 0, q = '' } = {}) {
  const params = { limit, offset };
  const where = q ? 'WHERE search_text LIKE @q' : '';
  if (q) params.q = `%${q}%`;
  const total = Number(sqlite.prepare('SELECT COUNT(*) AS count FROM users').get()?.count || 0);
  const matched = q
    ? Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(params)?.count || 0)
    : total;
  const rows = sqlite.prepare(`
    SELECT data FROM users
    ${where}
    ORDER BY order_value DESC
    LIMIT @limit OFFSET @offset
  `).all(params);
  return { users: parseRows(rows), total, matched, offset, limit };
}

function parseRows(rows) {
  const values = [];
  for (const row of rows) {
    try {
      values.push(JSON.parse(row.data));
    } catch {
      // Skip corrupt rows without failing the whole admin page.
    }
  }
  return values;
}

function buildUsageDays(rows, now, days) {
  const offsetMs = 8 * 60 * 60_000;
  const current = new Date(now + offsetMs);
  const midnight = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
  const result = Array.from({ length: days }, (_, index) => {
    const date = new Date(midnight + (index - days + 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
    return {
      date,
      label: date.slice(5),
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
    };
  });
  const byDate = new Map(result.map((item) => [item.date, item]));
  for (const row of rows) {
    const day = byDate.get(row.date);
    const hour = Number(row.hour || 0);
    if (!day || !day.hours[hour]) continue;
    const count = Number(row.count || 0);
    const credits = Math.max(0, Number(row.credits || 0));
    if (row.status === 'done') {
      day.done += count;
      day.credits += credits;
      day.hours[hour].done += count;
      day.hours[hour].credits += credits;
    } else if (row.status === 'failed') {
      day.failed += count;
      day.hours[hour].failed += count;
    }
  }
  for (const day of result) {
    Object.assign(day, finalizeStats(day));
    for (const hour of day.hours) Object.assign(hour, finalizeStats(hour));
  }
  return result;
}

function finalizeStats(value) {
  const done = Number(value.done || 0);
  const failed = Number(value.failed || 0);
  const total = done + failed;
  return { done, failed, total, successRate: total ? done / total : 0 };
}
