// Minecraft Server Manager - main Express application
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { RconClient } from './src/rcon.js';
import { MinecraftProcess } from './src/minecraftProcess.js';
import * as SF from './src/serverFiles.js';
import * as Modrinth from './src/modrinth.js';
import * as Demo from './src/demoData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

// --- Config ---
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

// --- Demo mode state ---
// Tracks the simulated server state when demoMode is true
const demoState = {
  running: true,   // demo starts with server already "running"
  startTime: Date.now() - 3847000, // pretend it's been up ~64 mins
  activityIndex: 0,
  activityTimer: null,
};

// --- Core services (real mode only) ---
const mc = new MinecraftProcess();
let rcon = null;
let rconReconnectTimer = null;

async function connectRcon() {
  if (rcon) { try { rcon.disconnect(); } catch { /* ok */ } }
  rcon = new RconClient(config.rconHost || '127.0.0.1', config.rconPort || 25575, config.rconPassword);
  try {
    await rcon.connect();
    console.log('[RCON] Connected');
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
    console.log('[RCON] Could not connect after server start.');
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

// --- Session auth ---
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function validateToken(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); return false; }
  sessions.set(token, Date.now() + SESSION_TTL);
  return true;
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!validateToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// --- Express setup ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- WebSocket server for live console ---
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'ws://localhost');
  const token = url.searchParams.get('token');
  if (!validateToken(token)) { ws.close(4001, 'Unauthorized'); return; }

  wsClients.add(ws);

  if (config.demoMode) {
    // Send demo startup history
    for (const line of Demo.DEMO_STARTUP_LOGS) {
      ws.send(JSON.stringify({ type: 'log', time: Date.now(), line }));
    }
    // Send a few activity lines
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

mc.on('log', (entry) => {
  if (config.demoMode) return; // don't broadcast real logs in demo mode
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

// --- Demo helpers ---
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

// Start the demo activity timer immediately if launching in demo mode
if (config.demoMode) {
  startDemoActivityTimer();
}

// Broadcast status every 10 seconds
setInterval(broadcastStatus, 10000);

// --- Auth ---
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (!password || password !== config.webPassword) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: createSession() });
});

app.use('/api', requireAuth);

// --- Status ---
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
  res.json({ running: mc.running, uptime: mc.getUptime(), rconConnected: !!(rcon?.connected), onlineCount, serverPath: config.serverPath, minecraftVersion: config.minecraftVersion || 'unknown' });
});

// --- Server control ---
app.post('/api/server/start', async (req, res) => {
  if (config.demoMode) {
    if (demoState.running) return res.status(400).json({ error: 'Demo server is already running' });
    demoState.running = true;
    demoState.startTime = Date.now();
    broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Starting demo server...' });
    // Play startup sequence with staggered delays
    Demo.DEMO_STARTUP_LOGS.forEach((line, i) => {
      setTimeout(() => {
        broadcast({ type: 'log', time: Date.now(), line });
        if (i === Demo.DEMO_STARTUP_LOGS.length - 1) {
          broadcastStatus();
          startDemoActivityTimer();
        }
      }, i * 120);
    });
    return res.json({ ok: true, message: '[DEMO] Server starting...' });
  }
  try {
    mc.start(config.serverPath, config.startCommand);
    scheduleRconConnect(15000);
    broadcastStatus();
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
    broadcast({ type: 'log', time: Date.now(), line: '[Server thread/INFO] [minecraft/DedicatedServer]: ThreadedAnvilChunkStorage: All dimensions are saved' });
    broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Server stopped.' });
    demoState.running = false;
    demoState.startTime = null;
    stopDemoActivityTimer();
    broadcastStatus();
    return res.json({ ok: true, message: '[DEMO] Server stopped.' });
  }
  try {
    if (rcon?.connected) { await rconCmd('stop'); } else { mc.stop(); }
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
  res.json({ ok: true, message: 'Process killed' });
});

app.post('/api/server/restart', async (req, res) => {
  if (config.demoMode) {
    // Stop then start with a short delay
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
          if (i === Demo.DEMO_STARTUP_LOGS.length - 1) {
            broadcastStatus();
            startDemoActivityTimer();
          }
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
    res.json({ ok: true, message: 'Restarting...' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/server/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (config.demoMode) {
    const line = `[Server thread/INFO] [minecraft/DedicatedServer]: [DEMO] Executed: ${command}`;
    broadcast({ type: 'log', time: Date.now(), line });
    return res.json({ ok: true, result: '[DEMO] Command echoed to console.' });
  }
  try {
    const result = await rconCmd(command);
    res.json({ ok: true, result });
  } catch (err) { res.status(503).json({ error: err.message }); }
});

app.post('/api/server/stdin', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (config.demoMode) {
    broadcast({ type: 'log', time: Date.now(), line: `> ${command}` });
    return res.json({ ok: true });
  }
  try { mc.sendConsoleCommand(command); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Players ---
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
  if (config.demoMode) {
    // Mutate demo data in memory so the UI reflects changes within the session
    const i = Demo.DEMO_OPS.findIndex(o => o.name.toLowerCase() === name.toLowerCase());
    if (i !== -1) { Demo.DEMO_OPS[i].level = level; }
    else { Demo.DEMO_OPS.push({ uuid: '', name, level, bypassesPlayerLimit: false }); }
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) await rconCmd(`op ${name}`);
    const ops = await SF.getOps(config.serverPath);
    const existing = ops.find(o => o.name.toLowerCase() === name.toLowerCase());
    if (existing) { existing.level = level; } else { ops.push({ uuid: '', name, level, bypassesPlayerLimit: false }); }
    await SF.setOps(config.serverPath, ops);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/players/op/:name', async (req, res) => {
  const { name } = req.params;
  if (config.demoMode) {
    const i = Demo.DEMO_OPS.findIndex(o => o.name.toLowerCase() === name.toLowerCase());
    if (i !== -1) Demo.DEMO_OPS.splice(i, 1);
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) await rconCmd(`deop ${name}`);
    await SF.setOps(config.serverPath, (await SF.getOps(config.serverPath)).filter(o => o.name.toLowerCase() !== name.toLowerCase()));
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
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/players/whitelist/:name', async (req, res) => {
  const { name } = req.params;
  if (config.demoMode) {
    const i = Demo.DEMO_WHITELIST.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
    if (i !== -1) Demo.DEMO_WHITELIST.splice(i, 1);
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) await rconCmd(`whitelist remove ${name}`);
    await SF.setWhitelist(config.serverPath, (await SF.getWhitelist(config.serverPath)).filter(e => e.name.toLowerCase() !== name.toLowerCase()));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/players/banned', async (req, res) => {
  if (config.demoMode) return res.json(Demo.DEMO_BANS);
  res.json({ players: await SF.getBannedPlayers(config.serverPath), ips: await SF.getBannedIps(config.serverPath) });
});

app.post('/api/players/ban', async (req, res) => {
  const { name, reason = 'Banned by admin' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
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
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/players/ban/:name', async (req, res) => {
  const { name } = req.params;
  if (config.demoMode) {
    const i = Demo.DEMO_BANS.players.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
    if (i !== -1) Demo.DEMO_BANS.players.splice(i, 1);
    return res.json({ ok: true });
  }
  try {
    if (rcon?.connected) await rconCmd(`pardon ${name}`);
    await SF.setBannedPlayers(config.serverPath, (await SF.getBannedPlayers(config.serverPath)).filter(e => e.name.toLowerCase() !== name.toLowerCase()));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/players/kick', async (req, res) => {
  const { name, reason = 'Kicked by admin' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (config.demoMode) {
    broadcast({ type: 'log', time: Date.now(), line: `[Server thread/INFO] [minecraft/MinecraftServer]: [DEMO] Kicked ${name}: ${reason}` });
    return res.json({ ok: true });
  }
  try { await rconCmd(`kick ${name} ${reason}`); res.json({ ok: true }); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

app.post('/api/players/say', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (config.demoMode) {
    broadcast({ type: 'log', time: Date.now(), line: `[Server thread/INFO] [minecraft/MinecraftServer]: [Server] ${message}` });
    return res.json({ ok: true });
  }
  try { await rconCmd(`say ${message}`); res.json({ ok: true }); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

// --- Mods ---
app.get('/api/mods', async (req, res) => {
  if (config.demoMode) {
    // Return mods without modrinthData (user hits "Identify" to get that)
    return res.json({ mods: Demo.DEMO_MODS.map(({ modrinthData, ...rest }) => ({ ...rest, modrinthData: null })) });
  }
  try {
    const mods = await SF.listMods(config.serverPath, config.modsFolder, config.disabledModsFolder);
    res.json({ mods });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mods/lookup', async (req, res) => {
  if (config.demoMode) {
    // Return pre-populated demo modrinth data keyed by filename
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
  if (config.demoMode) {
    const mod = Demo.DEMO_MODS.find(m => m.filename === filename);
    if (mod) mod.enabled = enable;
    return res.json({ ok: true });
  }
  try {
    await SF.toggleMod(config.serverPath, filename, enable, config.modsFolder, config.disabledModsFolder);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/mods/:filename', async (req, res) => {
  if (config.demoMode) {
    const i = Demo.DEMO_MODS.findIndex(m => m.filename === req.params.filename);
    if (i !== -1) Demo.DEMO_MODS.splice(i, 1);
    return res.json({ ok: true });
  }
  try {
    await SF.deleteMod(config.serverPath, req.params.filename, config.modsFolder, config.disabledModsFolder);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Modrinth search (always uses real API even in demo mode) ---
app.get('/api/modrinth/search', async (req, res) => {
  const { q = '', side = 'all', limit = 20, offset = 0 } = req.query;
  try {
    const results = await Modrinth.searchMods(q, {
      mcVersion: config.minecraftVersion || (config.demoMode ? '1.20.1' : undefined),
      loader: 'forge',
      side,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/modrinth/versions/:projectId', async (req, res) => {
  try {
    const versions = await Modrinth.getProjectVersions(req.params.projectId, {
      mcVersion: config.minecraftVersion || (config.demoMode ? '1.20.1' : undefined),
      loader: 'forge',
    });
    res.json(versions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/modrinth/download', async (req, res) => {
  const { versionId, filename } = req.body;
  if (!versionId) return res.status(400).json({ error: 'versionId required' });
  if (config.demoMode) {
    // Simulate a download without touching the filesystem
    const version = await Modrinth.getVersion(versionId).catch(() => null);
    const file = version?.files?.find(f => f.primary) || version?.files?.[0];
    const name = filename || file?.filename || `${versionId}.jar`;
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
    const name = filename || file.filename;
    const { buffer } = await Modrinth.downloadModFile(file.url, name);
    await SF.saveMod(config.serverPath, name, buffer, config.modsFolder);
    res.json({ ok: true, filename: name, size: buffer.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Server properties ---
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
  try { await SF.setServerProperties(config.serverPath, req.body); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- App config ---
app.get('/api/config', (req, res) => {
  const { webPassword: _, ...safe } = config;
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
    // If demo mode was just turned off, stop the fake activity timer
    if (updates.demoMode === false) stopDemoActivityTimer();
    if (updates.demoMode === true) startDemoActivityTimer();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rcon/connect', async (req, res) => {
  if (config.demoMode) return res.json({ ok: true, connected: true, demo: true });
  const ok = await connectRcon();
  res.json({ ok, connected: ok });
});

// --- Start ---
const PORT = config.webPort || 3000;
httpServer.listen(PORT, () => {
  console.log(`\nMinecraft Manager running at http://localhost:${PORT}`);
  if (config.demoMode) {
    console.log('*** DEMO MODE ACTIVE — showing seed data, not your real server ***');
    console.log('To disable: set "demoMode": false in config.json and restart.\n');
  } else {
    console.log(`Server path: ${config.serverPath}\n`);
  }
});
