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

// --- Core services ---
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
  } catch (err) {
    rcon = null;
    return false;
  }
}

async function scheduleRconConnect(delayMs = 5000) {
  clearTimeout(rconReconnectTimer);
  rconReconnectTimer = setTimeout(async () => {
    let attempts = 0;
    while (attempts < 24) { // try for 2 minutes
      if (!mc.running) break;
      if (await connectRcon()) return;
      await new Promise(r => setTimeout(r, 5000));
      attempts++;
    }
    console.log('[RCON] Could not connect after server start (check rcon settings in server.properties)');
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
const sessions = new Map(); // token -> expiry
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
  sessions.set(token, Date.now() + SESSION_TTL); // refresh
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
  // Validate token from query string
  const url = new URL(req.url, 'ws://localhost');
  const token = url.searchParams.get('token');
  if (!validateToken(token)) { ws.close(4001, 'Unauthorized'); return; }

  wsClients.add(ws);

  // Send recent log history
  for (const entry of mc.logs) {
    ws.send(JSON.stringify({ type: 'log', ...entry }));
  }
  ws.send(JSON.stringify({ type: 'status', running: mc.running, uptime: mc.getUptime() }));

  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

mc.on('log', (entry) => {
  const msg = JSON.stringify({ type: 'log', ...entry });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
});

function broadcastStatus() {
  const msg = JSON.stringify({ type: 'status', running: mc.running, uptime: mc.getUptime() });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// Broadcast status every 10 seconds while server is running
setInterval(broadcastStatus, 10000);

// --- Auth routes ---
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (!password || password !== config.webPassword) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: createSession() });
});

// All routes below require auth
app.use('/api', requireAuth);

// --- Status ---
app.get('/api/status', async (req, res) => {
  let onlineCount = 0;
  let tps = null;
  if (rcon?.connected) {
    try {
      const listResult = await rconCmd('list');
      // "There are 2 of a max of 20 players online: ..."
      const m = listResult.match(/There are (\d+)/);
      if (m) onlineCount = parseInt(m[1]);
    } catch { /* server starting */ }
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

// --- Server control ---
app.post('/api/server/start', async (req, res) => {
  try {
    mc.start(config.serverPath, config.startCommand);
    scheduleRconConnect(15000); // give Forge time to load
    broadcastStatus();
    res.json({ ok: true, message: 'Server starting...' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/server/stop', async (req, res) => {
  try {
    if (rcon?.connected) {
      await rconCmd('stop');
    } else {
      mc.stop();
    }
    res.json({ ok: true, message: 'Stop signal sent' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/server/kill', async (req, res) => {
  mc.kill();
  res.json({ ok: true, message: 'Process killed' });
});

app.post('/api/server/restart', async (req, res) => {
  try {
    const stopped = new Promise(resolve => mc.once('stopped', resolve));
    if (rcon?.connected) { await rconCmd('stop'); } else { mc.stop(); }
    await Promise.race([stopped, new Promise(r => setTimeout(r, 30000))]);
    mc.start(config.serverPath, config.startCommand);
    scheduleRconConnect(15000);
    broadcastStatus();
    res.json({ ok: true, message: 'Restarting...' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send raw RCON command
app.post('/api/server/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const result = await rconCmd(command);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// Send to stdin (useful when RCON isn't up yet)
app.post('/api/server/stdin', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    mc.sendConsoleCommand(command);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Players ---
app.get('/api/players/online', async (req, res) => {
  try {
    const result = await rconCmd('list');
    // Parse "There are X of a max of Y players online: name1, name2"
    const m = result.match(/There are \d+ of a max of \d+ players online: (.*)/);
    const names = m && m[1].trim() ? m[1].split(', ').map(n => n.trim()) : [];
    res.json({ players: names, raw: result });
  } catch (err) {
    res.status(503).json({ error: err.message, players: [] });
  }
});

app.get('/api/players/ops', async (req, res) => {
  res.json(await SF.getOps(config.serverPath));
});

app.post('/api/players/op', async (req, res) => {
  const { name, level = 4 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    // Use RCON if available for immediate effect; also update file
    if (rcon?.connected) await rconCmd(`op ${name}`);
    // Read current ops and upsert
    const ops = await SF.getOps(config.serverPath);
    const existing = ops.find(o => o.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.level = level;
    } else {
      ops.push({ uuid: '', name, level, bypassesPlayerLimit: false });
    }
    await SF.setOps(config.serverPath, ops);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/players/op/:name', async (req, res) => {
  const { name } = req.params;
  try {
    if (rcon?.connected) await rconCmd(`deop ${name}`);
    const ops = await SF.getOps(config.serverPath);
    await SF.setOps(config.serverPath, ops.filter(o => o.name.toLowerCase() !== name.toLowerCase()));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/players/whitelist', async (req, res) => {
  res.json(await SF.getWhitelist(config.serverPath));
});

app.post('/api/players/whitelist', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    if (rcon?.connected) await rconCmd(`whitelist add ${name}`);
    const list = await SF.getWhitelist(config.serverPath);
    if (!list.find(e => e.name.toLowerCase() === name.toLowerCase())) {
      list.push({ uuid: '', name });
      await SF.setWhitelist(config.serverPath, list);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/players/whitelist/:name', async (req, res) => {
  const { name } = req.params;
  try {
    if (rcon?.connected) await rconCmd(`whitelist remove ${name}`);
    const list = await SF.getWhitelist(config.serverPath);
    await SF.setWhitelist(config.serverPath, list.filter(e => e.name.toLowerCase() !== name.toLowerCase()));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/players/banned', async (req, res) => {
  res.json({
    players: await SF.getBannedPlayers(config.serverPath),
    ips: await SF.getBannedIps(config.serverPath),
  });
});

app.post('/api/players/ban', async (req, res) => {
  const { name, reason = 'Banned by admin' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    if (rcon?.connected) {
      await rconCmd(`ban ${name} ${reason}`);
    } else {
      const list = await SF.getBannedPlayers(config.serverPath);
      if (!list.find(e => e.name.toLowerCase() === name.toLowerCase())) {
        list.push({ uuid: '', name, source: 'Manager', expires: 'forever', reason, created: new Date().toISOString() });
        await SF.setBannedPlayers(config.serverPath, list);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/players/ban/:name', async (req, res) => {
  const { name } = req.params;
  try {
    if (rcon?.connected) await rconCmd(`pardon ${name}`);
    const list = await SF.getBannedPlayers(config.serverPath);
    await SF.setBannedPlayers(config.serverPath, list.filter(e => e.name.toLowerCase() !== name.toLowerCase()));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/kick', async (req, res) => {
  const { name, reason = 'Kicked by admin' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await rconCmd(`kick ${name} ${reason}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.post('/api/players/say', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    await rconCmd(`say ${message}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// --- Mods ---
app.get('/api/mods', async (req, res) => {
  try {
    const mods = await SF.listMods(config.serverPath, config.modsFolder, config.disabledModsFolder);
    res.json({ mods });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hash all mods and look them up on Modrinth for metadata (client/server/both info)
app.get('/api/mods/lookup', async (req, res) => {
  try {
    const hashMap = await SF.hashMods(config.serverPath, config.modsFolder, config.disabledModsFolder);
    const hashes = Object.values(hashMap).map(v => v.hash);
    const modrinthData = await Modrinth.lookupByHashes(hashes);

    // Invert: filename -> modrinth data
    const result = {};
    for (const [filename, { hash, enabled }] of Object.entries(hashMap)) {
      result[filename] = { hash, enabled, modrinth: modrinthData[hash] || null };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mods/toggle', async (req, res) => {
  const { filename, enable } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  try {
    await SF.toggleMod(config.serverPath, filename, enable, config.modsFolder, config.disabledModsFolder);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/mods/:filename', async (req, res) => {
  try {
    await SF.deleteMod(config.serverPath, req.params.filename, config.modsFolder, config.disabledModsFolder);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Modrinth search ---
app.get('/api/modrinth/search', async (req, res) => {
  const { q = '', side = 'all', limit = 20, offset = 0 } = req.query;
  try {
    const results = await Modrinth.searchMods(q, {
      mcVersion: config.minecraftVersion,
      loader: 'forge',
      side,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/modrinth/versions/:projectId', async (req, res) => {
  try {
    const versions = await Modrinth.getProjectVersions(req.params.projectId, {
      mcVersion: config.minecraftVersion,
      loader: 'forge',
    });
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download a mod from Modrinth directly to the mods folder
app.post('/api/modrinth/download', async (req, res) => {
  const { versionId, filename } = req.body;
  if (!versionId) return res.status(400).json({ error: 'versionId required' });
  try {
    const version = await Modrinth.getVersion(versionId);
    const file = version.files.find(f => f.primary) || version.files[0];
    if (!file) throw new Error('No downloadable file found for this version');

    const name = filename || file.filename;
    const { buffer } = await Modrinth.downloadModFile(file.url, name);
    await SF.saveMod(config.serverPath, name, buffer, config.modsFolder);
    res.json({ ok: true, filename: name, size: buffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Server properties ---
app.get('/api/settings/properties', async (req, res) => {
  try {
    res.json(await SF.getServerProperties(config.serverPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/properties', async (req, res) => {
  try {
    await SF.setServerProperties(config.serverPath, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- App config ---
app.get('/api/config', (req, res) => {
  // Never expose webPassword
  const { webPassword: _, ...safe } = config;
  res.json(safe);
});

app.post('/api/config', async (req, res) => {
  const allowed = ['serverPath', 'rconHost', 'rconPort', 'rconPassword',
    'startCommand', 'minecraftVersion', 'modsFolder', 'disabledModsFolder'];
  const updates = {};
  for (const k of allowed) {
    if (k in req.body) updates[k] = req.body[k];
  }
  // Allow password change if provided
  if (req.body.webPassword) updates.webPassword = req.body.webPassword;
  try {
    await saveConfig(updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reconnect RCON manually
app.post('/api/rcon/connect', async (req, res) => {
  const ok = await connectRcon();
  res.json({ ok, connected: ok });
});

// --- Start ---
const PORT = config.webPort || 3000;
httpServer.listen(PORT, () => {
  console.log(`\nMinecraft Manager running at http://localhost:${PORT}`);
  console.log(`Server path: ${config.serverPath}`);
  console.log('Log in with the webPassword from config.json\n');
});
