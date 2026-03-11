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
import { buildHelmet, buildAuthLimiter, buildApiLimiter, buildSameOriginCheck, buildCsrfCheck } from './src/middleware.js';
import { info } from './src/audit.js';
import { initDatabase } from './src/db.js';
import * as Backup from './src/backup.js';
import { createServices } from './src/services.js';

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

async function saveConfig(updates) {
  config = { ...config, ...updates };
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

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
    broadcast({ type: 'status', running: mc.running, uptime: mc.getUptime() });
  }
}

const ctx = createServices({ config, saveConfig, loadConfig, mc, broadcast, broadcastStatus });

if (config.demoMode) ctx.startDemoActivityTimer();

// ============================================================
// Middleware stack
// ============================================================

app.disable('x-powered-by');
app.use(buildHelmet());
app.use(sessionMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/session', (req, res) => {
  if (req.session?.user) {
    const { email, name, provider, adminLevel, loginAt } = req.session.user;
    res.json({ loggedIn: true, email, name, provider, adminLevel: adminLevel || 0, loginAt, dbConnected: dbReady });
  } else {
    res.json({ loggedIn: false });
  }
});

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
// Route modules
// ============================================================

app.use('/api', statusRoutes(ctx));
app.use('/api', serverRoutes(ctx));
app.use('/api', playerRoutes(ctx));
app.use('/api', modRoutes(ctx));
app.use('/api', modrinthRoutes(ctx));
app.use('/api', settingsRoutes(ctx));
app.use('/api', userRoutes());
app.use('/api', backupRoutes(ctx));
app.use('/api', modpackRoutes(ctx));
app.use('/api', auditRoutes());

app.post('/api/rcon/connect', async (req, res) => {
  if (ctx.config.demoMode) return res.json({ ok: true, connected: true, demo: true });
  const ok = await ctx.connectRcon();
  res.json({ ok, connected: ok });
});

// ============================================================
// WebSocket server for live console
// ============================================================

wss.on('connection', (ws, req) => {
  sessionMiddleware(req, { getHeader: () => {}, setHeader: () => {}, end: () => {} }, () => {
    if (!req.session?.user) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    wsClients.add(ws);

    if (config.demoMode) {
      for (const line of Demo.DEMO_STARTUP_LOGS) {
        ws.send(JSON.stringify({ type: 'log', time: Date.now(), line }));
      }
      for (let i = 0; i < 6; i++) {
        ws.send(JSON.stringify({ type: 'log', time: Date.now(), line: Demo.DEMO_ACTIVITY_LOGS[i] }));
      }
      ws.send(JSON.stringify({ type: 'status', running: ctx.demoState.running, uptime: ctx.getDemoUptime(), demoMode: true }));
    } else {
      for (const entry of mc.logs) {
        ws.send(JSON.stringify({ type: 'log', ...entry }));
      }
      ws.send(JSON.stringify({ type: 'status', running: mc.running, uptime: mc.getUptime() }));
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

setInterval(broadcastStatus, 10000);

// ============================================================
// Start
// ============================================================

const PORT = config.webPort || 3000;

if (config.demoMode) {
  await Demo.enrichDemoIcons().catch(err =>
    console.warn('[Demo] Icon enrichment failed (icons may be missing):', err.message),
  );
}

if (!config.demoMode) {
  Backup.setupBackupSchedule(config, mc);
}

const BIND_HOST = config.bindHost || '0.0.0.0';
httpServer.listen(PORT, BIND_HOST, () => {
  info('Minecraft Manager started', { port: PORT, demoMode: !!config.demoMode });
  if (config.demoMode) {
    console.log(`\nMinecraft Manager running at http://${BIND_HOST}:${PORT}`);
    console.log('*** DEMO MODE — showing seed data, no real server connection ***');
    console.log('Disable: set "demoMode": false in config.json and restart.\n');
  } else {
    console.log(`\nMinecraft Manager running at http://${BIND_HOST}:${PORT}`);
    console.log(`Server path: ${config.serverPath}\n`);
  }
});
