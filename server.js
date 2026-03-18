// Minecraft Server Manager — main Express application
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { MinecraftProcess } from './src/minecraftProcess.js';
import * as Demo from './src/demoData.js';
import { buildSessionMiddleware, buildAuthRouter, requireSession } from './src/auth.js';
import {
  buildHelmet,
  buildAuthLimiter,
  buildApiLimiter,
  buildSameOriginCheck,
  buildCsrfCheck,
  checkWsOrigin,
  requireCapability,
} from './src/middleware.js';
import { getCapabilitiesForRole } from './src/permissions.js';
import { validateConfig, migrateLaunchConfig, launchToString } from './src/validate.js';
import { info, setNotifyHook } from './src/audit.js';
import { initDatabase } from './src/db.js';
import * as Backup from './src/backup.js';
import { createServices } from './src/services.js';
import { collectMetrics, collectDemoMetrics } from './src/metrics.js';
import { initNotifications, onAuditEvent, notifyLagSpike, updateNotificationsConfig } from './src/notify.js';
import { initDiscord, shutdownDiscord, notifyDiscord } from './src/integrations/discord/index.js';

// Route modules
import statusRoutes from './src/routes/status.js';
import serverRoutes from './src/routes/server.js';
import playerRoutes from './src/routes/players.js';
import modRoutes from './src/routes/mods.js';
import modrinthRoutes from './src/routes/modrinth.js';
import settingsRoutes from './src/routes/settings.js';
import userRoutes from './src/routes/users.js';
import backupRoutes from './src/routes/backups.js';
import modpackRoutes from './src/routes/modpack.js';
import auditRoutes from './src/routes/audit.js';
import healthRoutes from './src/routes/health.js';
import identityRoutes from './src/routes/identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ============================================================
// Config
// ============================================================

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    console.error('ERROR: config.json not found. Copy config.example.json to config.json and edit it.');
    process.exit(1);
  }
}

let config = await loadConfig();

// Migrate legacy startCommand string → structured launch config
if (migrateLaunchConfig(config)) {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  console.log('Migrated legacy startCommand to structured launch config in config.json');
}

async function saveConfig(updates) {
  config = { ...config, ...updates };
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  updateNotificationsConfig(config);
}

// ---- Notifications ----
initNotifications(config);
setNotifyHook((action, details) => {
  onAuditEvent(action, details);
  // Also forward to Discord bot notifications (no-ops if disabled)
  notifyDiscord(action, details);
});

// ============================================================
// Database
// ============================================================

const dbReady = await initDatabase();

// ============================================================
// Trust proxy
// ============================================================

const app = express();
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
  info('Trust proxy enabled — using X-Forwarded-For for client IPs');
}

// ============================================================
// Session & Auth
// ============================================================

const sessionMiddleware = buildSessionMiddleware(config);
const { router: authRouter, providers: authProviders } = await buildAuthRouter(config);

// ============================================================
// Core services
// ============================================================

const mc = new MinecraftProcess();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const wsClients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) if (ws.readyState === 1) ws.send(msg);
}

function broadcastStatus() {
  if (config.demoMode) {
    broadcast({ type: 'status', running: ctx.demoState.running, uptime: ctx.getDemoUptime(), demoMode: true });
  } else {
    broadcast({ type: 'status', running: mc.running, stopping: mc.stopping, uptime: mc.getUptime() });
  }
}

// Full metrics broadcast — called on a timer, includes TPS/CPU/RAM/disk/players
let metricsCollecting = false;
async function broadcastMetrics() {
  if (metricsCollecting) return; // prevent overlap
  metricsCollecting = true;
  try {
    let payload;
    if (config.demoMode) {
      const m = collectDemoMetrics();
      payload = {
        type: 'status',
        running: ctx.demoState.running,
        uptime: ctx.getDemoUptime(),
        demoMode: true,
        rconConnected: true,
        minecraftVersion: config.minecraftVersion || 'unknown',
        ...m,
      };
    } else {
      // Auto-reconnect RCON if the server is running but RCON dropped
      if (mc.running && !ctx.rconConnected) {
        await ctx.connectRcon();
      }
      const m = await collectMetrics({ mc, rconCmd: ctx.rconCmd, rconConnected: ctx.rconConnected, config });
      payload = {
        type: 'status',
        running: mc.running,
        stopping: mc.stopping,
        uptime: mc.getUptime(),
        rconConnected: ctx.rconConnected,
        minecraftVersion: config.minecraftVersion || 'unknown',
        ...m,
      };
      // Notify on lag spikes (with cooldown)
      if (m.lagSpike && m.tps != null) {
        notifyLagSpike(m.tps, m.tpsThreshold);
      }
    }
    broadcast(payload);
  } catch {
    /* metrics collection should never crash the server */
  }
  metricsCollecting = false;
}

const ctx = createServices({ config, saveConfig, loadConfig, mc, broadcast, broadcastStatus });

if (config.demoMode) ctx.startDemoActivityTimer();

// ============================================================
// Middleware stack
// ============================================================

app.disable('x-powered-by');
app.use(buildHelmet(process.env.APP_URL));
app.use(sessionMiddleware);
app.use(express.json({ limit: '64mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ops endpoints — unauthenticated so probes/scrapers work without sessions
const appStartTime = Date.now();
app.use(healthRoutes(ctx, { dbReady, startTime: appStartTime }));

// Auth routes
app.use('/auth', buildAuthLimiter(), authRouter);

// Same-origin + rate limit for API
app.use('/api', buildSameOriginCheck(process.env.APP_URL));
app.use('/api', buildApiLimiter());

// ============================================================
// Public API routes (no auth required)
// ============================================================

app.get('/api/auth/providers', (req, res) => {
  res.json(authProviders);
});

app.get('/api/session', async (req, res) => {
  if (req.session?.user) {
    const { email, name, provider, adminLevel, role, loginAt } = req.session.user;
    const capabilities = [...getCapabilitiesForRole(role || 'viewer')];
    const session = {
      loggedIn: true,
      email,
      name,
      provider,
      role: role || 'viewer',
      adminLevel: adminLevel || 0,
      capabilities,
      loginAt,
      dbConnected: dbReady,
    };

    // Include linked Minecraft player if a panel link exists
    try {
      const { getLink } = await import('./src/panelLinks.js');
      const link = await getLink(email);
      if (link) {
        session.linkedPlayer = { minecraftName: link.minecraftName, verified: link.verified };
      }
    } catch {
      // panelLinks not available — that's fine
    }

    res.json(session);
  } else {
    res.json({ loggedIn: false });
  }
});

// ============================================================
// Public API routes — read-only, no auth required (guest access)
// Mutating endpoints inside these modules use requireAdmin internally.
// ============================================================

app.use('/api', statusRoutes(ctx));
app.use('/api', playerRoutes(ctx));
app.use('/api', modRoutes(ctx));
app.use('/api', modrinthRoutes(ctx));
app.use('/api', settingsRoutes(ctx));

// ============================================================
// All routes below require a valid session + CSRF
// ============================================================

app.use('/api', requireSession);

app.get('/api/csrf-token', (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.save(() => {});
  }
  res.json({ token: req.session.csrfToken });
});

app.use('/api', buildCsrfCheck());

// ============================================================
// Authenticated route modules
// ============================================================

app.use('/api', serverRoutes(ctx));
app.use('/api', userRoutes());
app.use('/api', backupRoutes(ctx));
app.use('/api', modpackRoutes(ctx));
app.use('/api', auditRoutes());
app.use('/api', identityRoutes(ctx));

app.post('/api/rcon/connect', requireCapability('server.send_console_command'), async (req, res) => {
  if (ctx.config.demoMode) return res.json({ ok: true, connected: true, demo: true });
  const ok = await ctx.connectRcon();
  res.json({ ok, connected: ok });
});

// ============================================================
// WebSocket server for live console
// ============================================================

const APP_URL = process.env.APP_URL || null;

wss.on('connection', (ws, req) => {
  // Origin check — reject cross-origin WebSocket connections
  const origin = req.headers.origin;
  const host = req.headers.host;
  const rejection = checkWsOrigin(origin, host, APP_URL);
  if (rejection) {
    info('WebSocket origin rejected', { origin, host, reason: rejection });
    ws.close(4003, 'Origin not allowed');
    return;
  }

  sessionMiddleware(req, { getHeader: () => {}, setHeader: () => {}, end: () => {} }, () => {
    // Allow guest connections (read-only) — they receive broadcasts but cannot send commands
    wsClients.add(ws);

    if (config.demoMode) {
      for (const line of Demo.DEMO_STARTUP_LOGS) {
        ws.send(JSON.stringify({ type: 'log', time: Date.now(), line }));
      }
      for (let i = 0; i < 6; i++) {
        ws.send(JSON.stringify({ type: 'log', time: Date.now(), line: Demo.DEMO_ACTIVITY_LOGS[i] }));
      }
      ws.send(
        JSON.stringify({ type: 'status', running: ctx.demoState.running, uptime: ctx.getDemoUptime(), demoMode: true }),
      );
    } else {
      for (const entry of mc.logs) {
        ws.send(JSON.stringify({ type: 'log', ...entry }));
      }
      ws.send(JSON.stringify({ type: 'status', running: mc.running, stopping: mc.stopping, uptime: mc.getUptime() }));
    }

    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });
});

mc.on('log', (entry) => {
  if (config.demoMode) return;
  const msg = JSON.stringify({ type: 'log', ...entry });
  for (const ws of wsClients) if (ws.readyState === 1) ws.send(msg);
});

const metricsInterval = setInterval(broadcastMetrics, 10000);

// ============================================================
// Config validation
// ============================================================

const configErrors = validateConfig(config);
if (configErrors.length > 0) {
  console.error('\n✖  Config validation failed:');
  for (const err of configErrors) console.error(`   - ${err}`);
  console.error('\nFix config.json and restart.\n');
  process.exit(1);
}

// ============================================================
// Start
// ============================================================

// Environment variable overrides (take precedence over config.json)
const PORT = parseInt(process.env.WEB_PORT, 10) || config.webPort || 3000;
const BIND_HOST = process.env.BIND_HOST || config.bindHost || '127.0.0.1';

if (config.demoMode) {
  await Demo.enrichDemoIcons().catch((err) =>
    console.warn('[Demo] Icon enrichment failed (icons may be missing):', err.message),
  );
  // Seed demo panel links
  const { loadDemoLinks } = await import('./src/panelLinks.js');
  loadDemoLinks(Demo.DEMO_PANEL_LINKS);
}

if (!config.demoMode) {
  Backup.setupBackupSchedule(config, {
    rconCmd: ctx.rconCmd,
    get rconConnected() {
      return ctx.rconConnected;
    },
  });
}

if (BIND_HOST === '0.0.0.0' && !config.demoMode) {
  console.warn('\n⚠  WARNING: Web panel is bound to all interfaces (0.0.0.0).');
  console.warn('   This is LAN test mode — not recommended for production.');
  console.warn('   For production, use bindHost=127.0.0.1 behind Nginx or another reverse proxy.\n');
}

if (!APP_URL && !config.demoMode) {
  console.warn('[Security] APP_URL is not set — WebSocket origin checks will fall back to the Host header.');
  console.warn('           Set APP_URL in your environment for stricter origin validation.\n');
}

// ============================================================
// Discord integration — initialize after services are ready
// ============================================================

initDiscord(config, ctx).catch((err) => {
  console.warn(`[Discord] Initialization failed: ${err.message}`);
});

httpServer.listen(PORT, BIND_HOST, () => {
  info('Minecraft Manager started', { port: PORT, bindHost: BIND_HOST, demoMode: !!config.demoMode });
  if (config.demoMode) {
    console.log(`\nMinecraft Manager running at http://${BIND_HOST}:${PORT}`);
    console.log('*** DEMO MODE — showing seed data, no real server connection ***');
    console.log('Disable: set "demoMode": false in config.json and restart.\n');
  } else {
    console.log(`\nMinecraft Manager running at http://${BIND_HOST}:${PORT}`);
    if (BIND_HOST === '127.0.0.1' || BIND_HOST === '::1') {
      console.log('Binding: localhost only (production/reverse-proxy mode)');
    } else {
      console.log(`Binding: ${BIND_HOST} (LAN test mode — use a reverse proxy for production)`);
    }
    console.log(`Server path: ${config.serverPath}`);
    console.log(`Launch: ${launchToString(config.launch)}`);

    // Auto-start Minecraft server on boot
    if (config.autoStart) {
      console.log('Auto-starting Minecraft server...\n');
      try {
        mc.start(config.launch, config.serverPath);
        ctx.scheduleRconConnect(15000);
        ctx.broadcastStatus();
        info('Auto-start: Minecraft server starting', { serverPath: config.serverPath });
      } catch (err) {
        console.error(`Auto-start failed: ${err.message}`);
        info('Auto-start failed', { error: err.message });
      }
    } else {
      console.log('Auto-start disabled — start the server from the Dashboard.\n');
    }
  }
});

// ============================================================
// Graceful shutdown — stop Minecraft cleanly before exiting
// ============================================================

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Manager] Received ${signal} — shutting down gracefully...`);

  // Stop timers that could fire during shutdown (cron, metrics broadcast)
  clearInterval(metricsInterval);
  Backup.stopBackupSchedule();

  // Disconnect Discord bot
  await shutdownDiscord().catch(() => {});

  // Close WebSocket connections
  for (const ws of wsClients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch {
      /* ignore */
    }
  }

  // Stop Minecraft server if running (needs RCON, so cleanup() comes after)
  if (!config.demoMode && mc.running) {
    ctx.markIntentionalStop();
    console.log('[Manager] Stopping Minecraft server...');
    try {
      // Try graceful stop via RCON first, fall back to stdin
      if (ctx.rconConnected) {
        await ctx.rconCmd('say Server shutting down...');
        await ctx.rconCmd('save-all');
        // Give save-all a moment to flush
        await new Promise((r) => setTimeout(r, 2000));
        await ctx.rconCmd('stop');
      } else {
        mc.stop();
      }

      // Wait up to 30 seconds for the server to stop
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.log('[Manager] Minecraft server did not stop in 30s — force killing...');
          mc.kill();
          resolve();
        }, 30000);
        mc.once('stopped', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      console.log('[Manager] Minecraft server stopped.');
    } catch (err) {
      console.error(`[Manager] Error stopping Minecraft: ${err.message}`);
      mc.kill();
    }
  }

  // Drain remaining timers (RCON reconnect, auto-restart, demo activity) and disconnect RCON
  ctx.cleanup();

  // Close HTTP server
  httpServer.close(() => {
    console.log('[Manager] HTTP server closed. Goodbye.');
    process.exit(0);
  });

  // Force exit after 5 more seconds if HTTP server hangs
  setTimeout(() => {
    console.log('[Manager] Forced exit.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
