// Minecraft Server Manager — main Express application
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import crypto from 'crypto';
import { RconClient } from './src/rcon.js';
import { MinecraftProcess } from './src/minecraftProcess.js';
import * as SF from './src/serverFiles.js';
import * as Modrinth from './src/modrinth.js';
import * as Demo from './src/demoData.js';
import { buildSessionMiddleware, buildAuthRouter, requireSession } from './src/auth.js';
import { buildHelmet, buildAuthLimiter, buildApiLimiter, buildSameOriginCheck, buildCsrfCheck } from './src/middleware.js';
import { audit, info } from './src/audit.js';
import { isValidMinecraftName, isSafeModFilename, isSafeCommand, sanitizeReason } from './src/validate.js';

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
// Trust proxy (must come before app creation so rate limiter uses real IPs)
// ============================================================

const app = express();
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
  info('Trust proxy enabled — using X-Forwarded-For for client IPs');
}

// ============================================================
// Session middleware (must be added before any route handlers)
// ============================================================

const sessionMiddleware = buildSessionMiddleware(config);

// ============================================================
// Auth router (async — discovers OIDC issuers at startup)
// ============================================================

const { router: authRouter, providers: authProviders } = await buildAuthRouter(config);

// ============================================================
// Core services (real mode only)
// ============================================================

const mc = new MinecraftProcess();
let rcon = null;
let rconReconnectTimer = null;

async function connectRcon() {
  if (rcon) { try { rcon.disconnect(); } catch { /* ok */ } }
  rcon = new RconClient(config.rconHost || '127.0.0.1', config.rconPort || 25575, config.rconPassword);
  try {
    await rcon.connect();
    info('[RCON] Connected');
    return true;
  } catch {
    rcon = null;
    return false;
  }
}

async function scheduleRconConnect(delayMs = 5000) {
  clearTimeout(rconReconnectTimer);
  rconReconnectTimer = setTimeout(async () => {
    let attempts = 0;
    while (attempts < 24) {
      if (!mc.running) break;
      if (await connectRcon()) return;
      await new Promise(r => setTimeout(r, 5000));
      attempts++;
    }
    info('[RCON] Could not connect after server start.');
  }, delayMs);
}

mc.on('stopped', () => {
  if (rcon) { rcon.disconnect(); rcon = null; }
  clearTimeout(rconReconnectTimer);
  broadcastStatus();
});

async function rconCmd(cmd) {
  if (!rcon || !rcon.connected) throw new Error('RCON is not connected. Server may still be starting, or check rcon settings.');
  return rcon.sendCommand(cmd);
}

// ============================================================
// Demo mode state
// ============================================================

const demoState = {
  running: true,
  startTime: Date.now() - 3847000,
  activityIndex: 0,
  activityTimer: null,
};

function getDemoUptime() {
  if (!demoState.running || !demoState.startTime) return null;
  return Math.floor((Date.now() - demoState.startTime) / 1000);
}

function startDemoActivityTimer() {
  stopDemoActivityTimer();
  demoState.activityTimer = setInterval(() => {
    if (!demoState.running) return;
    const line = Demo.DEMO_ACTIVITY_LOGS[demoState.activityIndex % Demo.DEMO_ACTIVITY_LOGS.length];
    demoState.activityIndex++;
    broadcast({ type: 'log', time: Date.now(), line });
  }, 8000);
}

function stopDemoActivityTimer() {
  if (demoState.activityTimer) {
    clearInterval(demoState.activityTimer);
    demoState.activityTimer = null;
  }
}

if (config.demoMode) startDemoActivityTimer();

// ============================================================
// Express middleware stack
// ============================================================

app.disable('x-powered-by');

// Security headers
app.use(buildHelmet());

// Session (before auth routes and all API routes)
app.use(sessionMiddleware);

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Static files (public/) — no auth required
app.use(express.static(path.join(__dirname, 'public')));

// Auth routes: /auth/google, /auth/microsoft, /auth/callback/*, /auth/local, /auth/logout
app.use('/auth', buildAuthLimiter(), authRouter);

// Same-origin check for all mutating API requests
app.use('/api', buildSameOriginCheck(process.env.APP_URL));

// Global API rate limit
app.use('/api', buildApiLimiter());

// ============================================================
// WebSocket server for live console
// ============================================================

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const wsClients = new Set();

// Use the same express-session middleware on WS upgrade requests so we can
// read req.session and validate the user's session cookie.
wss.on('connection', (ws, req) => {
  // Run session middleware with a minimal fake response (we only need to read the session)
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
      ws.send(JSON.stringify({ type: 'status', running: demoState.running, uptime: getDemoUptime(), demoMode: true }));
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

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) if (ws.readyState === 1) ws.send(msg);
}

function broadcastStatus() {
  if (config.demoMode) {
    broadcast({ type: 'status', running: demoState.running, uptime: getDemoUptime(), demoMode: true });
  } else {
    broadcast({ type: 'status', running: mc.running, uptime: mc.getUptime() });
  }
}

setInterval(broadcastStatus, 10000);

// ============================================================
// Public API routes (no auth required)
// ============================================================

// Login page uses this to know which providers to show
app.get('/api/auth/providers', (req, res) => {
  res.json(authProviders);
});

// Returns current session info — used by the SPA to check login state on load
app.get('/api/session', (req, res) => {
  if (req.session?.user) {
    const { email, name, provider, loginAt } = req.session.user;
    res.json({ loggedIn: true, email, name, provider, loginAt });
  } else {
    res.json({ loggedIn: false });
  }
});

// Legacy endpoint — kept for backward compat with old frontend code
app.get('/api/demo', (req, res) => {
  res.json({ demoMode: !!config.demoMode });
});

// ============================================================
// All routes below require a valid session
// ============================================================

app.use('/api', requireSession);

// CSRF token endpoint — returns the session-bound token for use in X-CSRF-Token headers.
// Lazily generates a token if the session predates CSRF support (e.g. after an upgrade).
app.get('/api/csrf-token', (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.save(() => {});
  }
  res.json({ token: req.session.csrfToken });
});

// CSRF check for all mutating API requests (POST/PUT/DELETE)
app.use('/api', buildCsrfCheck());

// ============================================================
// Status
// ============================================================

app.get('/api/status', async (req, res) => {
  if (config.demoMode) {
    return res.json(Demo.getDemoStatus(demoState.running, getDemoUptime()));
  }
  let onlineCount = 0;
  if (rcon?.connected) {
    try {
      const r = await rconCmd('list');
      const m = r.match(/There are (\d+)/);
      if (m) onlineCount = parseInt(m[1]);
    } catch { /* starting */ }
  }
  res.json({
    running: mc.running,
    uptime: mc.getUptime(),
    rconConnected: !!(rcon?.connected),
    onlineCount,
    serverPath: config.serverPath,
    minecraftVersion: config.minecraftVersion || 'unknown',
  });
});

// ============================================================
// Server control
// ============================================================

app.post('/api/server/start', async (req, res) => {
  if (config.demoMode) {
    if (demoState.running) return res.status(400).json({ error: 'Demo server is already running' });
    demoState.running = true;
    demoState.startTime = Date.now();
    broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Starting demo server...' });
    Demo.DEMO_STARTUP_LOGS.forEach((line, i) => {
      setTimeout(() => {
        broadcast({ type: 'log', time: Date.now(), line });
        if (i === Demo.DEMO_STARTUP_LOGS.length - 1) { broadcastStatus(); startDemoActivityTimer(); }
      }, i * 120);
    });
    return res.json({ ok: true, message: '[DEMO] Server starting...' });
  }
  try {
    mc.start(config.serverPath, config.startCommand);
    scheduleRconConnect(15000);
    broadcastStatus();
    audit('SERVER_START', { user: req.session.user.email, ip: req.ip });
    res.json({ ok: true, message: 'Server starting...' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/server/stop', async (req, res) => {
  if (config.demoMode) {
    if (!demoState.running) return res.status(400).json({ error: 'Demo server is not running' });
    broadcast({ type: 'log', time: Date.now(), line: '[Server thread/INFO] [minecraft/MinecraftServer]: Stopping server' });
    broadcast({ type: 'log', time: Date.now(), line: '[Server thread/INFO] [minecraft/MinecraftServer]: Saving worlds' });
    broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Server stopped.' });
    demoState.running = false;
    demoState.startTime = null;
    stopDemoActivityTimer();
    broadcastStatus();
    return res.json({ ok: true, message: '[DEMO] Server stopped.' });
  }
  try {
    if (rcon?.connected) { await rconCmd('stop'); } else { mc.stop(); }
    audit('SERVER_STOP', { user: req.session.user.email, ip: req.ip });
    res.json({ ok: true, message: 'Stop signal sent' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/server/kill', async (req, res) => {
  if (config.demoMode) {
    demoState.running = false;
    demoState.startTime = null;
    stopDemoActivityTimer();
    broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Process force-killed.' });
    broadcastStatus();
    return res.json({ ok: true, message: '[DEMO] Killed.' });
  }
  mc.kill();
  audit('SERVER_KILL', { user: req.session.user.email, ip: req.ip });
  res.json({ ok: true, message: 'Process killed' });
});

app.post('/api/server/restart', async (req, res) => {
  if (config.demoMode) {
    demoState.running = false;
    demoState.startTime = null;
    stopDemoActivityTimer();
    broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Restarting server...' });
    broadcastStatus();
    setTimeout(async () => {
      demoState.running = true;
      demoState.startTime = Date.now();
      Demo.DEMO_STARTUP_LOGS.forEach((line, i) => {
        setTimeout(() => {
          broadcast({ type: 'log', time: Date.now(), line });
          if (i === Demo.DEMO_STARTUP_LOGS.length - 1) { broadcastStatus(); startDemoActivityTimer(); }
        }, i * 120);
      });
    }, 1500);
    return res.json({ ok: true, message: '[DEMO] Restarting...' });
  }
  try {
    const stopped = new Promise(resolve => mc.once('stopped', resolve));
    if (rcon?.connected) { await rconCmd('stop'); } else { mc.stop(); }
    await Promise.race([stopped, new Promise(r => setTimeout(r, 30000))]);
    mc.start(config.serverPath, config.startCommand);
    scheduleRconConnect(15000);
    broadcastStatus();
    audit('SERVER_RESTART', { user: req.session.user.email, ip: req.ip });
    res.json({ ok: true, message: 'Restarting...' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/server/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (!isSafeCommand(command)) return res.status(400).json({ error: 'Invalid command' });
  if (config.demoMode) {
    const line = `[Server thread/INFO] [minecraft/DedicatedServer]: [DEMO] Executed: ${command}`;
    broadcast({ type: 'log', time: Date.now(), line });
    return res.json({ ok: true, result: '[DEMO] Command echoed to console.' });
  }
  try {
    const result = await rconCmd(command);
    audit('CONSOLE_CMD', { user: req.session.user.email, command, ip: req.ip });
    res.json({ ok: true, result });
  } catch (err) { res.status(503).json({ error: err.message }); }
});

app.post('/api/server/stdin', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (!isSafeCommand(command)) return res.status(400).json({ error: 'Invalid command' });
  if (config.demoMode) {
    broadcast({ type: 'log', time: Date.now(), line: `> ${command}` });
    return res.json({ ok: true });
  }
  try { mc.sendConsoleCommand(command); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ============================================================
// Players
// ============================================================

app.get('/api/players/online', async (req, res) => {
  if (config.demoMode) {
    const players = demoState.running ? Demo.DEMO_ONLINE_PLAYERS : [];
    return res.json({ players, raw: `There are ${players.length} of a max of 8 players online: ${players.join(', ')}` });
  }
  try {
    const result = await rconCmd('list');
    const m = result.match(/There are \d+ of a max of \d+ players online: (.*)/);
    const names = m && m[1].trim() ? m[1].split(', ').map(n => n.trim()) : [];
    res.json({ players: names, raw: result });
  } catch (err) { res.status(503).json({ error: err.message, players: [] }); }
});

app.get('/api/players/ops', async (req, res) => {
  if (config.demoMode) return res.json(Demo.DEMO_OPS);
  res.json(await SF.getOps(config.serverPath));
});

app.post('/api/players/op', async (req, res) => {
  const { name, level = 4 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
  if (![1, 2, 3, 4].includes(Number(level))) return res.status(400).json({ error: 'level must be 1–4' });
  if (config.demoMode) {
    const i = Demo.DEMO_OPS.findIndex(o => o.name.toLowerCase() === name.toLowerCase());
    if (i !== -1) { Demo.DEMO_OPS[i].level = level; }
    else { Demo.DEMO_OPS.push({ uuid: '', name, level, bypassesPlayerLimit: false }); }
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) await rconCmd(`op ${name}`);
    const ops = await SF.getOps(config.serverPath);
    const existing = ops.find(o => o.name.toLowerCase() === name.toLowerCase());
    if (existing) { existing.level = Number(level); }
    else { ops.push({ uuid: '', name, level: Number(level), bypassesPlayerLimit: false }); }
    await SF.setOps(config.serverPath, ops);
    audit('OP_ADD', { user: req.session.user.email, target: name, level, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/players/op/:name', async (req, res) => {
  const { name } = req.params;
  if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
  if (config.demoMode) {
    const i = Demo.DEMO_OPS.findIndex(o => o.name.toLowerCase() === name.toLowerCase());
    if (i !== -1) Demo.DEMO_OPS.splice(i, 1);
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) await rconCmd(`deop ${name}`);
    await SF.setOps(config.serverPath, (await SF.getOps(config.serverPath)).filter(o => o.name.toLowerCase() !== name.toLowerCase()));
    audit('OP_REMOVE', { user: req.session.user.email, target: name, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/players/whitelist', async (req, res) => {
  if (config.demoMode) return res.json(Demo.DEMO_WHITELIST);
  res.json(await SF.getWhitelist(config.serverPath));
});

app.post('/api/players/whitelist', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
  if (config.demoMode) {
    if (!Demo.DEMO_WHITELIST.find(e => e.name.toLowerCase() === name.toLowerCase())) {
      Demo.DEMO_WHITELIST.push({ uuid: '', name });
    }
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) await rconCmd(`whitelist add ${name}`);
    const list = await SF.getWhitelist(config.serverPath);
    if (!list.find(e => e.name.toLowerCase() === name.toLowerCase())) {
      list.push({ uuid: '', name });
      await SF.setWhitelist(config.serverPath, list);
    }
    audit('WHITELIST_ADD', { user: req.session.user.email, target: name, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/players/whitelist/:name', async (req, res) => {
  const { name } = req.params;
  if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
  if (config.demoMode) {
    const i = Demo.DEMO_WHITELIST.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
    if (i !== -1) Demo.DEMO_WHITELIST.splice(i, 1);
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) await rconCmd(`whitelist remove ${name}`);
    await SF.setWhitelist(config.serverPath, (await SF.getWhitelist(config.serverPath)).filter(e => e.name.toLowerCase() !== name.toLowerCase()));
    audit('WHITELIST_REMOVE', { user: req.session.user.email, target: name, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/players/banned', async (req, res) => {
  if (config.demoMode) return res.json(Demo.DEMO_BANS);
  res.json({ players: await SF.getBannedPlayers(config.serverPath), ips: await SF.getBannedIps(config.serverPath) });
});

app.post('/api/players/ban', async (req, res) => {
  const { name, reason: rawReason = 'Banned by admin' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
  const reason = sanitizeReason(rawReason);
  if (config.demoMode) {
    if (!Demo.DEMO_BANS.players.find(e => e.name.toLowerCase() === name.toLowerCase())) {
      Demo.DEMO_BANS.players.push({ uuid: '', name, source: 'Manager', expires: 'forever', reason, created: new Date().toISOString() });
    }
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) { await rconCmd(`ban ${name} ${reason}`); }
    else {
      const list = await SF.getBannedPlayers(config.serverPath);
      list.push({ uuid: '', name, source: 'Manager', expires: 'forever', reason, created: new Date().toISOString() });
      await SF.setBannedPlayers(config.serverPath, list);
    }
    audit('PLAYER_BAN', { user: req.session.user.email, target: name, reason, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/players/ban/:name', async (req, res) => {
  const { name } = req.params;
  if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
  if (config.demoMode) {
    const i = Demo.DEMO_BANS.players.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
    if (i !== -1) Demo.DEMO_BANS.players.splice(i, 1);
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) await rconCmd(`pardon ${name}`);
    await SF.setBannedPlayers(config.serverPath, (await SF.getBannedPlayers(config.serverPath)).filter(e => e.name.toLowerCase() !== name.toLowerCase()));
    audit('PLAYER_UNBAN', { user: req.session.user.email, target: name, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/players/kick', async (req, res) => {
  const { name, reason: rawReason = 'Kicked by admin' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
  const reason = sanitizeReason(rawReason);
  if (config.demoMode) {
    broadcast({ type: 'log', time: Date.now(), line: `[Server thread/INFO] [minecraft/MinecraftServer]: [DEMO] Kicked ${name}: ${reason}` });
    return res.json({ ok: true });
  }
  try {
    await rconCmd(`kick ${name} ${reason}`);
    audit('PLAYER_KICK', { user: req.session.user.email, target: name, reason, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(503).json({ error: err.message }); }
});

app.post('/api/players/say', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!isSafeCommand(message)) return res.status(400).json({ error: 'Invalid message' });
  if (config.demoMode) {
    broadcast({ type: 'log', time: Date.now(), line: `[Server thread/INFO] [minecraft/MinecraftServer]: [Server] ${message}` });
    return res.json({ ok: true });
  }
  try { await rconCmd(`say ${message}`); res.json({ ok: true }); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

// ============================================================
// Mods
// ============================================================

app.get('/api/mods', async (req, res) => {
  if (config.demoMode) return res.json({ mods: Demo.DEMO_MODS });
  try {
    const mods = await SF.listMods(config.serverPath, config.modsFolder, config.disabledModsFolder);
    res.json({ mods });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mods/lookup', async (req, res) => {
  if (config.demoMode) {
    const result = {};
    for (const mod of Demo.DEMO_MODS) {
      result[mod.filename] = { hash: 'demo-hash-' + mod.filename, enabled: mod.enabled, modrinth: mod.modrinthData };
    }
    return res.json(result);
  }
  try {
    const hashMap = await SF.hashMods(config.serverPath, config.modsFolder, config.disabledModsFolder);
    const hashes = Object.values(hashMap).map(v => v.hash);
    const modrinthData = await Modrinth.lookupByHashes(hashes);
    const result = {};
    for (const [filename, { hash, enabled }] of Object.entries(hashMap)) {
      result[filename] = { hash, enabled, modrinth: modrinthData[hash] || null };
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mods/toggle', async (req, res) => {
  const { filename, enable } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!isSafeModFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
  if (config.demoMode) {
    const mod = Demo.DEMO_MODS.find(m => m.filename === filename);
    if (mod) mod.enabled = enable;
    return res.json({ ok: true });
  }
  try {
    await SF.toggleMod(config.serverPath, filename, enable, config.modsFolder, config.disabledModsFolder);
    audit('MOD_TOGGLE', { user: req.session.user.email, filename, enable, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/mods/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!isSafeModFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
  if (config.demoMode) {
    const i = Demo.DEMO_MODS.findIndex(m => m.filename === filename);
    if (i !== -1) Demo.DEMO_MODS.splice(i, 1);
    return res.json({ ok: true });
  }
  try {
    await SF.deleteMod(config.serverPath, filename, config.modsFolder, config.disabledModsFolder);
    audit('MOD_DELETE', { user: req.session.user.email, filename, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// Modrinth
// ============================================================

app.get('/api/modrinth/browse', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  if (config.demoMode) {
    const start = offset;
    const end = start + limit;
    return res.json({
      ...Demo.DEMO_BROWSE_RESULTS,
      hits: Demo.DEMO_BROWSE_RESULTS.hits.slice(start, end),
      offset: start,
      limit,
    });
  }
  try {
    const results = await Modrinth.searchMods('', {
      mcVersion: config.minecraftVersion,
      loader: 'forge',
      side: 'all',
      limit,
      offset,
      index: 'downloads',
    });
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/modrinth/search', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 200);
  const side = ['all', 'server', 'both'].includes(req.query.side) ? req.query.side : 'all';
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  try {
    const results = await Modrinth.searchMods(q, {
      mcVersion: config.minecraftVersion || (config.demoMode ? '1.20.1' : undefined),
      loader: 'forge',
      side,
      limit,
      offset,
    });
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/modrinth/versions/:projectId', async (req, res) => {
  // projectId from Modrinth is alphanumeric — basic sanity check
  const { projectId } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) return res.status(400).json({ error: 'Invalid project ID' });
  try {
    const versions = await Modrinth.getProjectVersions(projectId, {
      mcVersion: config.minecraftVersion || (config.demoMode ? '1.20.1' : undefined),
      loader: 'forge',
    });
    res.json(versions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/modrinth/download', async (req, res) => {
  const { versionId } = req.body;
  if (!versionId) return res.status(400).json({ error: 'versionId required' });
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(versionId)) return res.status(400).json({ error: 'Invalid version ID' });

  if (config.demoMode) {
    const version = await Modrinth.getVersion(versionId).catch(() => null);
    const file = version?.files?.find(f => f.primary) || version?.files?.[0];
    const name = file?.filename || `${versionId}.jar`;
    if (!isSafeModFilename(name)) return res.status(400).json({ error: 'Invalid filename from Modrinth' });
    const fakeSize = file?.size || 1024 * 1024;
    Demo.DEMO_MODS.push({
      filename: name, size: fakeSize, enabled: true,
      modrinthData: { projectTitle: name.replace(/\.jar$/i, ''), clientSide: 'required', serverSide: 'required', versionNumber: 'downloaded', iconUrl: null },
    });
    return res.json({ ok: true, filename: name, size: fakeSize, demo: true });
  }

  try {
    const version = await Modrinth.getVersion(versionId);
    const file = version.files.find(f => f.primary) || version.files[0];
    if (!file) throw new Error('No downloadable file found for this version');

    // Use Modrinth's authoritative filename — do not trust user-supplied filename
    const name = file.filename;
    if (!isSafeModFilename(name)) throw new Error(`Unsafe filename from Modrinth: ${name}`);

    // Verify SHA1 hash before saving to disk
    const { buffer } = await Modrinth.downloadModFile(file.url, name, file.hashes?.sha1);
    await SF.saveMod(config.serverPath, name, buffer, config.modsFolder);
    audit('MOD_INSTALL', { user: req.session.user.email, filename: name, versionId, ip: req.ip });
    res.json({ ok: true, filename: name, size: buffer.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// Server properties
// ============================================================

app.get('/api/settings/properties', async (req, res) => {
  if (config.demoMode) return res.json(Demo.DEMO_PROPERTIES);
  try { res.json(await SF.getServerProperties(config.serverPath)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/properties', async (req, res) => {
  if (config.demoMode) {
    Object.assign(Demo.DEMO_PROPERTIES, req.body);
    return res.json({ ok: true, demo: true });
  }
  try {
    await SF.setServerProperties(config.serverPath, req.body);
    audit('PROPS_SAVE', { user: req.session.user.email, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// App config
// ============================================================

app.get('/api/config', (req, res) => {
  // Never send secrets to the browser — strip passwords and RCON password
  const { webPassword: _1, rconPassword: _2, ...safe } = config;
  res.json(safe);
});

app.post('/api/config', async (req, res) => {
  const allowed = ['serverPath', 'rconHost', 'rconPort', 'rconPassword',
    'startCommand', 'minecraftVersion', 'modsFolder', 'disabledModsFolder', 'demoMode'];
  const updates = {};
  for (const k of allowed) {
    if (k in req.body) updates[k] = req.body[k];
  }
  if (req.body.webPassword) updates.webPassword = req.body.webPassword;
  try {
    await saveConfig(updates);
    if (updates.demoMode === false) stopDemoActivityTimer();
    if (updates.demoMode === true) startDemoActivityTimer();
    audit('CONFIG_SAVE', { user: req.session.user.email, keys: Object.keys(updates).filter(k => k !== 'webPassword' && k !== 'rconPassword'), ip: req.ip });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rcon/connect', async (req, res) => {
  if (config.demoMode) return res.json({ ok: true, connected: true, demo: true });
  const ok = await connectRcon();
  res.json({ ok, connected: ok });
});

// ============================================================
// Start
// ============================================================

const PORT = config.webPort || 3000;

// In demo mode, fetch real icon URLs from Modrinth before starting so icons
// are correct on first page load (avoids png/webp extension mismatches).
if (config.demoMode) {
  await Demo.enrichDemoIcons().catch(err =>
    console.warn('[Demo] Icon enrichment failed (icons may be missing):', err.message),
  );
}

httpServer.listen(PORT, '127.0.0.1', () => {
  info('Minecraft Manager started', { port: PORT, demoMode: !!config.demoMode });
  if (config.demoMode) {
    console.log(`\nMinecraft Manager running at http://localhost:${PORT}`);
    console.log('*** DEMO MODE — showing seed data, no real server connection ***');
    console.log('Disable: set "demoMode": false in config.json and restart.\n');
  } else {
    console.log(`\nMinecraft Manager running at http://localhost:${PORT}`);
    console.log(`Server path: ${config.serverPath}\n`);
  }
});
