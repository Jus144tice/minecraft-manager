// Ops-friendly endpoints: liveness, readiness, and Prometheus metrics.
// These are unauthenticated — mount before session/auth middleware.

import { Router } from 'express';
import { collectMetrics, collectDemoMetrics } from '../metrics.js';

export default function healthRoutes(ctx, { dbReady, startTime }) {
  const router = Router();

  // ---- Liveness probe (/healthz) ----
  // Returns 200 if the Node process is alive and serving HTTP.
  router.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()) });
  });

  // ---- Readiness probe (/readyz) ----
  // Returns 200 when the app is ready to accept traffic, 503 otherwise.
  router.get('/readyz', (_req, res) => {
    const checks = {
      database: dbReady,
      config: !!ctx.config,
    };

    if (!ctx.config.demoMode) {
      checks.serverRunning = ctx.mc.running;
      checks.rconConnected = ctx.rconConnected;
    }

    // The web panel is "ready" if config loaded and DB is up.
    // Server/RCON are informational — a stopped MC server doesn't make the panel unready.
    const ready = checks.database && checks.config;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });

  // ---- Prometheus metrics (/metrics) ----
  // Text exposition format (https://prometheus.io/docs/instrumenting/exposition_formats/)
  router.get('/metrics', async (_req, res) => {
    const lines = [];
    const ts = Date.now();

    // Helper to emit a metric line
    const gauge = (name, help, value, labels) => {
      if (value == null) return;
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      const labelStr = labels
        ? `{${Object.entries(labels)
            .map(([k, v]) => `${k}="${v}"`)
            .join(',')}}`
        : '';
      lines.push(`${name}${labelStr} ${value} ${ts}`);
    };

    // Process-level
    gauge('mcmanager_process_uptime_seconds', 'Manager process uptime in seconds', Math.floor(process.uptime()));
    const mem = process.memoryUsage();
    gauge('mcmanager_process_rss_bytes', 'Manager process RSS in bytes', mem.rss);
    gauge('mcmanager_process_heap_used_bytes', 'Manager process heap used in bytes', mem.heapUsed);

    // App state
    gauge('mcmanager_database_up', 'Whether the database connection is healthy', dbReady ? 1 : 0);
    gauge('mcmanager_demo_mode', 'Whether the manager is running in demo mode', ctx.config.demoMode ? 1 : 0);
    gauge(
      'mcmanager_uptime_seconds',
      'Manager wall-clock uptime since HTTP listen',
      Math.floor((Date.now() - startTime) / 1000),
    );

    // Minecraft server metrics
    let m;
    if (ctx.config.demoMode) {
      m = collectDemoMetrics();
      gauge('minecraft_server_running', 'Whether the Minecraft server is running', ctx.demoState.running ? 1 : 0);
      gauge('minecraft_server_uptime_seconds', 'Minecraft server uptime in seconds', ctx.getDemoUptime());
    } else {
      m = await collectMetrics({
        mc: ctx.mc,
        rconCmd: ctx.rconCmd,
        rconConnected: ctx.rconConnected,
        config: ctx.config,
      });
      gauge('minecraft_server_running', 'Whether the Minecraft server is running', ctx.mc.running ? 1 : 0);
      gauge('minecraft_server_uptime_seconds', 'Minecraft server uptime in seconds', ctx.mc.getUptime());
      gauge('minecraft_rcon_connected', 'Whether RCON is connected', ctx.rconConnected ? 1 : 0);
    }

    gauge('minecraft_tps', 'Server ticks per second', m.tps);
    gauge('minecraft_cpu_percent', 'Server process CPU usage percentage', m.cpuPercent);
    gauge('minecraft_memory_bytes', 'Server process resident memory in bytes', m.memBytes);
    gauge('minecraft_disk_bytes', 'Server directory disk usage in bytes', m.diskBytes);
    gauge('minecraft_players_online', 'Number of players currently online', m.onlineCount);
    gauge('minecraft_lag_spike', 'Whether TPS is below the alert threshold', m.lagSpike ? 1 : 0);
    gauge('minecraft_tps_threshold', 'TPS alert threshold', m.tpsThreshold);

    lines.push('');
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n'));
  });

  return router;
}
