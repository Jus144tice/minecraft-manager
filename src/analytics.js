// Historical metrics persistence and query engine.
// Persists periodic snapshots of server performance metrics and notable events
// into PostgreSQL for trend analysis, charting, and insight generation.

import { getPool, isConnected } from './db.js';
import { info, warn } from './audit.js';

// ---- Schema ----

const ANALYTICS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id          SERIAL PRIMARY KEY,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT NOT NULL,
  tps         REAL,
  cpu_percent REAL,
  mem_bytes   BIGINT,
  mem_max     BIGINT,
  disk_bytes  BIGINT,
  online_count INTEGER NOT NULL DEFAULT 0,
  max_players  INTEGER,
  players     TEXT[],
  uptime      INTEGER,
  environment TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_ts ON metrics_snapshots (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_ts_asc ON metrics_snapshots (timestamp ASC);

CREATE TABLE IF NOT EXISTS server_events (
  id          SERIAL PRIMARY KEY,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type  TEXT NOT NULL,
  environment TEXT,
  details     JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_server_events_ts ON server_events (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_server_events_type ON server_events (event_type);
`;

/** Run the analytics schema migration. Called once at startup. */
export async function initAnalyticsSchema() {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(ANALYTICS_SCHEMA_SQL);
    info('Analytics schema initialised');
    return true;
  } catch (err) {
    warn('Failed to initialise analytics schema: ' + err.message);
    return false;
  }
}

// ---- Snapshot Persistence ----

/**
 * Insert a metrics snapshot. Called by the background collector.
 * @param {object} snapshot - { status, tps, cpuPercent, memBytes, memMax, diskBytes, onlineCount, maxPlayers, players, uptime, environment }
 */
export async function insertSnapshot(snapshot) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO metrics_snapshots
        (status, tps, cpu_percent, mem_bytes, mem_max, disk_bytes, online_count, max_players, players, uptime, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        snapshot.status,
        snapshot.tps ?? null,
        snapshot.cpuPercent ?? null,
        snapshot.memBytes ?? null,
        snapshot.memMax ?? null,
        snapshot.diskBytes ?? null,
        snapshot.onlineCount ?? 0,
        snapshot.maxPlayers ?? null,
        snapshot.players?.length ? snapshot.players : null,
        snapshot.uptime ?? null,
        snapshot.environment ?? null,
      ],
    );
  } catch (err) {
    // Never let a metrics write failure break the app
    if (!insertSnapshot._warned) {
      warn('Failed to write metrics snapshot: ' + err.message);
      insertSnapshot._warned = true;
    }
  }
}

// ---- Event Persistence ----

/**
 * Record a notable server event (start, stop, crash, restart, backup, etc.).
 */
export async function insertEvent(eventType, details = {}, environment = null) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query('INSERT INTO server_events (event_type, environment, details) VALUES ($1, $2, $3)', [
      eventType,
      environment,
      JSON.stringify(details),
    ]);
  } catch (err) {
    warn('Failed to write server event: ' + err.message);
  }
}

// ---- Background Collector ----

let collectorInterval = null;

/**
 * Start the background metrics collector.
 * @param {Function} getSnapshot - async function returning a snapshot object
 * @param {number} intervalMs - collection interval (default 15s)
 */
export function startCollector(getSnapshot, intervalMs = 15000) {
  stopCollector(); // prevent duplicate collectors
  if (!isConnected()) return;

  async function collect() {
    try {
      const snapshot = await getSnapshot();
      if (snapshot) await insertSnapshot(snapshot);
    } catch {
      // silently skip — getSnapshot may fail during shutdown/restart
    }
  }

  // Run first collection immediately
  collect();
  collectorInterval = setInterval(collect, intervalMs);
  info('Analytics collector started', { intervalMs });
}

/** Stop the background collector. */
export function stopCollector() {
  if (collectorInterval) {
    clearInterval(collectorInterval);
    collectorInterval = null;
  }
}

// ---- Query Helpers ----

// Bucket size selection based on time range
function getBucketInterval(rangeMs) {
  if (rangeMs <= 15 * 60 * 1000) return '15 seconds'; // ≤15m → raw (15s)
  if (rangeMs <= 60 * 60 * 1000) return '1 minute'; // ≤1h → 1m
  if (rangeMs <= 6 * 60 * 60 * 1000) return '5 minutes'; // ≤6h → 5m
  if (rangeMs <= 24 * 60 * 60 * 1000) return '15 minutes'; // ≤24h → 15m
  if (rangeMs <= 7 * 24 * 60 * 60 * 1000) return '1 hour'; // ≤7d → 1h
  return '6 hours'; // >7d → 6h
}

/**
 * Query bucketed metrics for a time range.
 * Returns aggregated data points suitable for charting.
 */
export async function queryMetrics({ from, to, bucketInterval } = {}) {
  const pool = getPool();
  if (!pool) return [];

  const now = new Date();
  const toDate = to ? new Date(to) : now;
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 60 * 60 * 1000); // default 1h

  const rangeMs = toDate.getTime() - fromDate.getTime();
  const bucket = bucketInterval || getBucketInterval(rangeMs);

  // For very short ranges (≤15m), return raw data points
  if (bucket === '15 seconds') {
    const { rows } = await pool.query(
      `SELECT timestamp, status, tps, cpu_percent, mem_bytes, mem_max,
              disk_bytes, online_count, max_players, uptime
       FROM metrics_snapshots
       WHERE timestamp >= $1 AND timestamp <= $2
       ORDER BY timestamp ASC`,
      [fromDate, toDate],
    );
    return rows.map(formatRow);
  }

  // Aggregated query with time bucketing
  const { rows } = await pool.query(
    `SELECT
       date_trunc('minute', timestamp) -
         (EXTRACT(minute FROM timestamp)::int % $3) * interval '1 minute' AS bucket,
       mode() WITHIN GROUP (ORDER BY status) AS status,
       AVG(tps)::real AS tps,
       AVG(cpu_percent)::real AS cpu_percent,
       AVG(mem_bytes)::bigint AS mem_bytes,
       MAX(mem_max)::bigint AS mem_max,
       AVG(disk_bytes)::bigint AS disk_bytes,
       ROUND(AVG(online_count))::int AS online_count,
       MAX(max_players) AS max_players,
       MAX(uptime) AS uptime,
       MIN(tps)::real AS tps_min,
       MAX(tps)::real AS tps_max,
       MIN(cpu_percent)::real AS cpu_min,
       MAX(cpu_percent)::real AS cpu_max,
       MIN(mem_bytes)::bigint AS mem_min,
       MAX(mem_bytes)::bigint AS mem_max_peak
     FROM metrics_snapshots
     WHERE timestamp >= $1 AND timestamp <= $2
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [fromDate, toDate, bucketMinutes(bucket)],
  );
  return rows.map(formatBucketRow);
}

function bucketMinutes(bucket) {
  if (bucket === '1 minute') return 1;
  if (bucket === '5 minutes') return 5;
  if (bucket === '15 minutes') return 15;
  if (bucket === '1 hour') return 60;
  if (bucket === '6 hours') return 360;
  return 1;
}

function formatRow(r) {
  return {
    timestamp: r.timestamp,
    status: r.status,
    tps: r.tps,
    cpuPercent: r.cpu_percent,
    memBytes: r.mem_bytes ? Number(r.mem_bytes) : null,
    memMax: r.mem_max ? Number(r.mem_max) : null,
    diskBytes: r.disk_bytes ? Number(r.disk_bytes) : null,
    onlineCount: r.online_count,
    maxPlayers: r.max_players,
    uptime: r.uptime,
  };
}

function formatBucketRow(r) {
  return {
    timestamp: r.bucket,
    status: r.status,
    tps: r.tps,
    tpsMin: r.tps_min,
    tpsMax: r.tps_max,
    cpuPercent: r.cpu_percent,
    cpuMin: r.cpu_min,
    cpuMax: r.cpu_max,
    memBytes: r.mem_bytes ? Number(r.mem_bytes) : null,
    memMin: r.mem_min ? Number(r.mem_min) : null,
    memMaxPeak: r.mem_max_peak ? Number(r.mem_max_peak) : null,
    memMax: r.mem_max ? Number(r.mem_max) : null,
    diskBytes: r.disk_bytes ? Number(r.disk_bytes) : null,
    onlineCount: r.online_count,
    maxPlayers: r.max_players,
    uptime: r.uptime,
  };
}

/**
 * Query server events for a time range.
 */
export async function queryEvents({ from, to, eventType } = {}) {
  const pool = getPool();
  if (!pool) return [];

  const now = new Date();
  const toDate = to ? new Date(to) : now;
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 24 * 60 * 60 * 1000);

  const conditions = ['timestamp >= $1', 'timestamp <= $2'];
  const params = [fromDate, toDate];
  if (eventType) {
    conditions.push('event_type = $3');
    params.push(eventType);
  }

  const { rows } = await pool.query(
    `SELECT timestamp, event_type, environment, details
     FROM server_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY timestamp ASC`,
    params,
  );
  return rows;
}

/**
 * Compute summary statistics for a time range.
 */
export async function querySummary({ from, to } = {}) {
  const pool = getPool();
  if (!pool) return null;

  const now = new Date();
  const toDate = to ? new Date(to) : now;
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 60 * 60 * 1000);

  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS sample_count,
       AVG(tps)::real AS avg_tps,
       MIN(tps)::real AS min_tps,
       MAX(tps)::real AS max_tps,
       AVG(cpu_percent)::real AS avg_cpu,
       MAX(cpu_percent)::real AS max_cpu,
       AVG(mem_bytes)::bigint AS avg_mem,
       MAX(mem_bytes)::bigint AS peak_mem,
       MAX(online_count) AS peak_players,
       ROUND(AVG(online_count), 1)::real AS avg_players
     FROM metrics_snapshots
     WHERE timestamp >= $1 AND timestamp <= $2
       AND status = 'running'`,
    [fromDate, toDate],
  );

  if (!rows[0] || rows[0].sample_count === '0') return null;

  const r = rows[0];

  // Count status transitions for downtime estimation
  const { rows: statusRows } = await pool.query(
    `SELECT status, COUNT(*) AS cnt
     FROM metrics_snapshots
     WHERE timestamp >= $1 AND timestamp <= $2
     GROUP BY status`,
    [fromDate, toDate],
  );

  const statusCounts = {};
  for (const sr of statusRows) statusCounts[sr.status] = parseInt(sr.cnt);
  const totalSamples = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const runningSamples = statusCounts['running'] || 0;
  const uptimePercent = totalSamples > 0 ? Math.round((runningSamples / totalSamples) * 1000) / 10 : null;

  // Count events in the range
  const { rows: eventRows } = await pool.query(
    `SELECT event_type, COUNT(*) AS cnt
     FROM server_events
     WHERE timestamp >= $1 AND timestamp <= $2
     GROUP BY event_type`,
    [fromDate, toDate],
  );
  const eventCounts = {};
  for (const er of eventRows) eventCounts[er.event_type] = parseInt(er.cnt);

  // Detect lag windows (TPS below threshold for ≥2 consecutive samples)
  const { rows: lagRows } = await pool.query(
    `SELECT COUNT(*) AS lag_samples
     FROM metrics_snapshots
     WHERE timestamp >= $1 AND timestamp <= $2
       AND tps IS NOT NULL AND tps < 18`,
    [fromDate, toDate],
  );
  const lagSamples = parseInt(lagRows[0]?.lag_samples || 0);

  return {
    sampleCount: parseInt(r.sample_count),
    avgTps: r.avg_tps,
    minTps: r.min_tps,
    maxTps: r.max_tps,
    avgCpu: r.avg_cpu,
    maxCpu: r.max_cpu,
    avgMem: r.avg_mem ? Number(r.avg_mem) : null,
    peakMem: r.peak_mem ? Number(r.peak_mem) : null,
    peakPlayers: r.peak_players,
    avgPlayers: r.avg_players,
    uptimePercent,
    eventCounts,
    lagSamples,
    totalSamples,
  };
}

// ---- Retention ----

/**
 * Delete old raw snapshots. Keeps last `retentionDays` days of data.
 * Should be called periodically (e.g. once per hour or daily).
 */
export async function pruneOldData(retentionDays = 30) {
  const pool = getPool();
  if (!pool) return;
  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const { rowCount: snapshotCount } = await pool.query('DELETE FROM metrics_snapshots WHERE timestamp < $1', [
      cutoff,
    ]);
    const { rowCount: eventCount } = await pool.query('DELETE FROM server_events WHERE timestamp < $1', [cutoff]);
    if (snapshotCount > 0 || eventCount > 0) {
      info('Analytics data pruned', { snapshotCount, eventCount, retentionDays });
    }
  } catch (err) {
    warn('Failed to prune analytics data: ' + err.message);
  }
}

// ---- Demo Data Generator ----

/**
 * Generate synthetic historical data for demo mode charting.
 * Returns the same shape as queryMetrics() output.
 */
export function generateDemoMetrics({ from, to } = {}) {
  const now = Date.now();
  const toMs = to ? new Date(to).getTime() : now;
  const fromMs = from ? new Date(from).getTime() : toMs - 60 * 60 * 1000;
  const rangeMs = toMs - fromMs;

  // Choose step size based on range
  let stepMs;
  if (rangeMs <= 15 * 60 * 1000) stepMs = 15000;
  else if (rangeMs <= 60 * 60 * 1000) stepMs = 60000;
  else if (rangeMs <= 6 * 60 * 60 * 1000) stepMs = 5 * 60000;
  else if (rangeMs <= 24 * 60 * 60 * 1000) stepMs = 15 * 60000;
  else stepMs = 60 * 60000;

  const points = [];
  // Simulate a restart event ~40% through the range
  const restartAt = fromMs + rangeMs * 0.4;
  const restartEnd = restartAt + 3 * 60000; // 3 min downtime

  for (let t = fromMs; t <= toMs; t += stepMs) {
    const isDown = t >= restartAt && t < restartEnd;
    const elapsed = (t - fromMs) / rangeMs;

    // TPS: normally 19.5-20.0, dips before restart, recovers after
    let tps = null;
    if (!isDown) {
      const base = 19.5 + Math.sin(t / 120000) * 0.3;
      // Simulate lag leading up to restart
      const preRestart = t < restartAt && t > restartAt - 10 * 60000;
      tps = preRestart ? Math.max(12, base - (1 - (restartAt - t) / (10 * 60000)) * 6) : base;
      tps = Math.round(tps * 10) / 10;
    }

    // CPU: 10-25% normally, spikes before restart
    let cpu = null;
    if (!isDown) {
      cpu = 15 + Math.sin(t / 90000) * 5 + Math.random() * 3;
      const preRestart = t < restartAt && t > restartAt - 10 * 60000;
      if (preRestart) cpu += (1 - (restartAt - t) / (10 * 60000)) * 40;
      cpu = Math.round(cpu * 10) / 10;
    }

    // Memory: 1.8-2.4 GB, gradual climb with slight sawtooth
    let mem = null;
    if (!isDown) {
      mem = 1_900_000_000 + elapsed * 400_000_000 + Math.sin(t / 300000) * 100_000_000;
      // Reset after restart
      if (t > restartEnd) mem = 1_800_000_000 + ((t - restartEnd) / rangeMs) * 200_000_000;
      mem = Math.round(mem);
    }

    // Players: 0-5 with time-of-day pattern
    const hour = new Date(t).getHours();
    const isActive = hour >= 15 && hour <= 23;
    const playerBase = isActive ? 3 : 1;
    const onlineCount = isDown ? 0 : Math.max(0, Math.round(playerBase + Math.sin(t / 600000) * 1.5));

    points.push({
      timestamp: new Date(t).toISOString(),
      status: isDown ? 'stopped' : 'running',
      tps,
      cpuPercent: cpu,
      memBytes: mem,
      memMax: 4_294_967_296,
      diskBytes: 1_610_612_736,
      onlineCount,
      maxPlayers: 20,
      uptime: isDown ? null : Math.floor((t - fromMs) / 1000),
    });
  }
  return points;
}

/**
 * Generate synthetic events for demo mode.
 */
export function generateDemoEvents({ from, to } = {}) {
  const now = Date.now();
  const toMs = to ? new Date(to).getTime() : now;
  const fromMs = from ? new Date(from).getTime() : toMs - 24 * 60 * 60 * 1000;
  const rangeMs = toMs - fromMs;

  const restartAt = fromMs + rangeMs * 0.4;
  return [
    { timestamp: new Date(restartAt).toISOString(), event_type: 'stop', details: { reason: 'user' } },
    {
      timestamp: new Date(restartAt + 3 * 60000).toISOString(),
      event_type: 'start',
      details: { reason: 'user' },
    },
    {
      timestamp: new Date(fromMs + rangeMs * 0.7).toISOString(),
      event_type: 'backup',
      details: { filename: 'backup-2026-03-22.tar.gz', size: 524288000 },
    },
  ];
}

/**
 * Generate synthetic summary for demo mode.
 */
export function generateDemoSummary() {
  return {
    sampleCount: 240,
    avgTps: 19.2,
    minTps: 14.3,
    maxTps: 20.0,
    avgCpu: 18.5,
    maxCpu: 62.3,
    avgMem: 2_100_000_000,
    peakMem: 2_680_000_000,
    peakPlayers: 5,
    avgPlayers: 2.3,
    uptimePercent: 97.5,
    eventCounts: { start: 1, stop: 1, backup: 1 },
    lagSamples: 8,
    totalSamples: 240,
  };
}
