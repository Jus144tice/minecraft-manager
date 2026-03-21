// Metrics collection for the live dashboard.
// Gathers TPS, CPU, RAM, disk usage, and player list from RCON and the OS.

import { execFile } from 'child_process';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import os from 'os';

// ---- CPU snapshot for the MC child process ----

let prevCpuTime = 0;
let prevWall = Date.now();

/**
 * Estimate CPU% for a PID between two successive calls.
 * Falls back to null if the PID is unavailable or the platform lacks ps/tasklist.
 */
function sampleProcessCpu(pid) {
  if (!pid) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // wmic gives KernelModeTime + UserModeTime in 100-ns units
      execFile(
        'wmic',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'KernelModeTime,UserModeTime', '/FORMAT:CSV'],
        { timeout: 3000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const lines = stdout
            .trim()
            .split('\n')
            .filter((l) => l.includes(','));
          if (lines.length < 2) return resolve(null);
          const parts = lines[lines.length - 1].split(',');
          // CSV: Node,KernelModeTime,UserModeTime
          const kernel = parseInt(parts[1]) || 0;
          const user = parseInt(parts[2]) || 0;
          const totalUs = (kernel + user) / 10; // convert 100-ns → µs
          const now = Date.now();
          const wallUs = (now - prevWall) * 1000;
          const cpuUs = totalUs - prevCpuTime;
          prevCpuTime = totalUs;
          prevWall = now;
          if (wallUs <= 0 || cpuUs < 0) return resolve(null);
          resolve(Math.min(100, (cpuUs / wallUs) * 100));
        },
      );
    } else {
      // Linux/macOS: read /proc/<pid>/stat for utime+stime (clock ticks)
      execFile('ps', ['-o', '%cpu=', '-p', String(pid)], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null);
        const val = parseFloat(stdout.trim());
        if (!Number.isFinite(val)) return resolve(null);
        // ps reports per-core CPU% (can exceed 100% on multi-core systems).
        // Normalize to 0-100% by dividing by the number of logical cores.
        const cores = os.cpus().length || 1;
        resolve(Math.min(100, val / cores));
      });
    }
  });
}

/**
 * Get RSS (resident memory) in bytes for a PID.
 */
function getProcessMemory(pid) {
  if (!pid) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null);
        // tasklist CSV: "name","PID","Session Name","Session#","Mem Usage"
        // Mem Usage looks like: "1,234,567 K"
        const match = stdout.match(/"([0-9,]+)\s*K"/);
        if (match) return resolve(parseInt(match[1].replace(/,/g, '')) * 1024);
        resolve(null);
      });
    } else {
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null);
        const kb = parseInt(stdout.trim());
        resolve(Number.isFinite(kb) ? kb * 1024 : null);
      });
    }
  });
}

// ---- Mod count (cached — only needs periodic refresh) ----

let modCountCache = { count: null, timestamp: 0 };
const MOD_COUNT_CACHE_TTL = 30_000; // refresh every 30 seconds

async function getModCount(serverPath, modsFolder = 'mods', disabledFolder = 'mods_disabled') {
  if (!serverPath) return null;
  if (Date.now() - modCountCache.timestamp < MOD_COUNT_CACHE_TTL) return modCountCache.count;

  try {
    let enabled = 0;
    let disabled = 0;
    for (const [folder, isEnabled] of [
      [modsFolder, true],
      [disabledFolder, false],
    ]) {
      try {
        const entries = await readdir(path.join(serverPath, folder));
        const count = entries.filter((f) => f.endsWith('.jar')).length;
        if (isEnabled) enabled = count;
        else disabled = count;
      } catch {
        /* folder may not exist */
      }
    }
    const result = { total: enabled + disabled, enabled, disabled };
    modCountCache = { count: result, timestamp: Date.now() };
    return result;
  } catch {
    return modCountCache.count; // return stale on error
  }
}

// ---- Disk usage (cached — expensive to compute) ----

let diskCache = { bytes: null, timestamp: 0 };
const DISK_CACHE_TTL = 60_000; // refresh at most once per minute

async function getDiskUsage(serverPath) {
  if (!serverPath) return null;
  if (Date.now() - diskCache.timestamp < DISK_CACHE_TTL) return diskCache.bytes;

  try {
    const bytes = await dirSize(serverPath);
    diskCache = { bytes, timestamp: Date.now() };
    return bytes;
  } catch {
    return diskCache.bytes; // return stale on error
  }
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        /* skip */
      }
    } else if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      total += await dirSize(full);
    }
  }
  return total;
}

// ---- TPS parsing ----
// Supports Paper/Spigot (`tps` command) and Forge (`forge tps` command).
// Vanilla servers lack a TPS command — returns null.

const TPS_STRIP_RE = /§[0-9a-fk-or]/gi; // strip Minecraft colour codes

function parseTps(raw) {
  if (!raw) return null;
  const clean = raw.replace(TPS_STRIP_RE, '');
  // Paper/Spigot: "TPS from last 1m, 5m, 15m: 20.0, 19.8, 19.6"
  const spigot = clean.match(/TPS.*?:\s*([\d.]+)/);
  if (spigot) return parseFloat(spigot[1]);
  // Forge: "Overall : Mean tick time: 12.34 ms. Mean TPS: 20.0"
  const forge = clean.match(/Mean TPS:\s*([\d.]+)/);
  if (forge) return parseFloat(forge[1]);
  return null;
}

// ---- Lag spike detection ----

const TPS_HISTORY_SIZE = 30; // ~5 minutes at 10s intervals
const tpsHistory = [];

function recordTps(tps) {
  if (tps == null) return;
  tpsHistory.push({ tps, time: Date.now() });
  if (tpsHistory.length > TPS_HISTORY_SIZE) tpsHistory.shift();
}

function isLagSpike(tps, threshold) {
  return tps != null && tps < threshold;
}

// ---- Public API ----

/**
 * Collect all performance metrics. Safe to call every 10 seconds.
 *
 * @param {object} opts
 * @param {import('./minecraftProcess.js').MinecraftProcess} opts.mc
 * @param {Function} opts.rconCmd - async (cmd) => string
 * @param {boolean} opts.rconConnected
 * @param {object} opts.config
 * @returns {Promise<object>} metrics snapshot
 */
export async function collectMetrics({ mc, rconCmd, rconConnected, config }) {
  const metrics = {
    tps: null,
    cpuPercent: null,
    memBytes: null,
    diskBytes: null,
    modCount: null,
    onlineCount: 0,
    players: [],
    lagSpike: false,
    tpsThreshold: config.tpsAlertThreshold ?? 18,
  };

  // Mod count is useful even when server is stopped
  metrics.modCount = await getModCount(config.serverPath, config.modsFolder, config.disabledModsFolder);

  if (!mc.running) return metrics;

  // Collect in parallel where possible
  const pid = mc.proc?.pid;
  const [cpu, mem, disk] = await Promise.all([
    sampleProcessCpu(pid),
    getProcessMemory(pid),
    getDiskUsage(config.serverPath),
  ]);

  metrics.cpuPercent = cpu != null ? Math.round(cpu * 10) / 10 : null;
  metrics.memBytes = mem;
  metrics.diskBytes = disk;

  // RCON-dependent metrics
  if (rconConnected) {
    try {
      const listResult = await rconCmd('list');
      const countMatch = listResult.match(/There are (\d+)/);
      if (countMatch) metrics.onlineCount = parseInt(countMatch[1]);
      const namesMatch = listResult.match(/players online:\s*(.*)/);
      if (namesMatch && namesMatch[1].trim()) {
        metrics.players = namesMatch[1]
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
      }
    } catch {
      /* RCON not ready */
    }

    // TPS — try paper/spigot first, then forge, then give up
    try {
      const tpsRaw = await rconCmd('tps');
      metrics.tps = parseTps(tpsRaw);
    } catch {
      /* no tps command */
    }
    if (metrics.tps == null) {
      try {
        const forgeRaw = await rconCmd('forge tps');
        metrics.tps = parseTps(forgeRaw);
      } catch {
        /* not forge either */
      }
    }
  }

  // Lag spike detection
  recordTps(metrics.tps);
  metrics.lagSpike = isLagSpike(metrics.tps, metrics.tpsThreshold);

  return metrics;
}

/**
 * Generate fake metrics for demo mode.
 */
export function collectDemoMetrics() {
  const t = Date.now();
  // Simulate slight TPS variation
  const tps = 19.5 + Math.sin(t / 60000) * 0.5;
  return {
    tps: Math.round(tps * 10) / 10,
    cpuPercent: Math.round((12 + Math.sin(t / 30000) * 8) * 10) / 10,
    memBytes: 2_147_483_648 + Math.floor(Math.sin(t / 45000) * 200_000_000), // ~2 GB
    diskBytes: 1_610_612_736, // ~1.5 GB
    modCount: { total: 22, enabled: 20, disabled: 2 },
    onlineCount: 3,
    players: ['Steve', 'Alex', 'CreeperSlayer99'],
    lagSpike: false,
    tpsThreshold: 18,
  };
}

// Exported for testing
/** Reset cached mod count and disk usage (e.g. after switching active environment). */
export function resetCaches() {
  modCountCache = { count: null, timestamp: 0 };
  diskCache = { bytes: null, timestamp: 0 };
}

export { parseTps, isLagSpike };
