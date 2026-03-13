// Player management routes: online list, ops, whitelist, bans, kick, broadcast.
// Uses RCON when connected; falls back to editing JSON files directly when offline.

import { Router } from 'express';
import * as SF from '../serverFiles.js';
import * as Demo from '../demoData.js';
import { audit } from '../audit.js';
import { isValidMinecraftName, isSafeCommand, sanitizeReason } from '../validate.js';

export default function playerRoutes(ctx) {
  const router = Router();

  router.get('/players/online', async (req, res) => {
    if (ctx.config.demoMode) {
      const players = ctx.demoState.running ? Demo.DEMO_ONLINE_PLAYERS : [];
      return res.json({ players, raw: `There are ${players.length} of a max of 8 players online: ${players.join(', ')}` });
    }
    try {
      const result = await ctx.rconCmd('list');
      const m = result.match(/There are \d+ of a max of \d+ players online: (.*)/);
      const names = m && m[1].trim() ? m[1].split(', ').map(n => n.trim()) : [];
      res.json({ players: names, raw: result });
    } catch (err) { res.status(503).json({ error: err.message, players: [] }); }
  });

  router.get('/players/ops', async (req, res) => {
    if (ctx.config.demoMode) return res.json(Demo.DEMO_OPS);
    res.json(await SF.getOps(ctx.config.serverPath));
  });

  router.post('/players/op', async (req, res) => {
    const { name, level = 4 } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
    if (![1, 2, 3, 4].includes(Number(level))) return res.status(400).json({ error: 'level must be 1–4' });
    if (ctx.config.demoMode) {
      const i = Demo.DEMO_OPS.findIndex(o => o.name.toLowerCase() === name.toLowerCase());
      if (i !== -1) { Demo.DEMO_OPS[i].level = level; }
      else { Demo.DEMO_OPS.push({ uuid: '', name, level, bypassesPlayerLimit: false }); }
      return res.json({ ok: true });
    }
    try {
      if (ctx.rconConnected) await ctx.rconCmd(`op ${name}`);
      const ops = await SF.getOps(ctx.config.serverPath);
      const existing = ops.find(o => o.name.toLowerCase() === name.toLowerCase());
      if (existing) { existing.level = Number(level); }
      else { ops.push({ uuid: '', name, level: Number(level), bypassesPlayerLimit: false }); }
      await SF.setOps(ctx.config.serverPath, ops);
      audit('OP_ADD', { user: req.session.user.email, target: name, level, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/players/op/:name', async (req, res) => {
    const { name } = req.params;
    if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
    if (ctx.config.demoMode) {
      const i = Demo.DEMO_OPS.findIndex(o => o.name.toLowerCase() === name.toLowerCase());
      if (i !== -1) Demo.DEMO_OPS.splice(i, 1);
      return res.json({ ok: true });
    }
    try {
      if (ctx.rconConnected) await ctx.rconCmd(`deop ${name}`);
      await SF.setOps(ctx.config.serverPath, (await SF.getOps(ctx.config.serverPath)).filter(o => o.name.toLowerCase() !== name.toLowerCase()));
      audit('OP_REMOVE', { user: req.session.user.email, target: name, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/players/whitelist', async (req, res) => {
    if (ctx.config.demoMode) return res.json(Demo.DEMO_WHITELIST);
    res.json(await SF.getWhitelist(ctx.config.serverPath));
  });

  router.post('/players/whitelist', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
    if (ctx.config.demoMode) {
      if (!Demo.DEMO_WHITELIST.find(e => e.name.toLowerCase() === name.toLowerCase())) {
        Demo.DEMO_WHITELIST.push({ uuid: '', name });
      }
      return res.json({ ok: true });
    }
    try {
      if (ctx.rconConnected) await ctx.rconCmd(`whitelist add ${name}`);
      const list = await SF.getWhitelist(ctx.config.serverPath);
      if (!list.find(e => e.name.toLowerCase() === name.toLowerCase())) {
        list.push({ uuid: '', name });
        await SF.setWhitelist(ctx.config.serverPath, list);
      }
      audit('WHITELIST_ADD', { user: req.session.user.email, target: name, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/players/whitelist/:name', async (req, res) => {
    const { name } = req.params;
    if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
    if (ctx.config.demoMode) {
      const i = Demo.DEMO_WHITELIST.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
      if (i !== -1) Demo.DEMO_WHITELIST.splice(i, 1);
      return res.json({ ok: true });
    }
    try {
      if (ctx.rconConnected) await ctx.rconCmd(`whitelist remove ${name}`);
      await SF.setWhitelist(ctx.config.serverPath, (await SF.getWhitelist(ctx.config.serverPath)).filter(e => e.name.toLowerCase() !== name.toLowerCase()));
      audit('WHITELIST_REMOVE', { user: req.session.user.email, target: name, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/players/banned', async (req, res) => {
    if (ctx.config.demoMode) return res.json(Demo.DEMO_BANS);
    res.json({ players: await SF.getBannedPlayers(ctx.config.serverPath), ips: await SF.getBannedIps(ctx.config.serverPath) });
  });

  router.post('/players/ban', async (req, res) => {
    const { name, reason: rawReason = 'Banned by admin' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
    const reason = sanitizeReason(rawReason);
    if (ctx.config.demoMode) {
      if (!Demo.DEMO_BANS.players.find(e => e.name.toLowerCase() === name.toLowerCase())) {
        Demo.DEMO_BANS.players.push({ uuid: '', name, source: 'Manager', expires: 'forever', reason, created: new Date().toISOString() });
      }
      return res.json({ ok: true });
    }
    try {
      if (ctx.rconConnected) { await ctx.rconCmd(`ban ${name} ${reason}`); }
      else {
        const list = await SF.getBannedPlayers(ctx.config.serverPath);
        list.push({ uuid: '', name, source: 'Manager', expires: 'forever', reason, created: new Date().toISOString() });
        await SF.setBannedPlayers(ctx.config.serverPath, list);
      }
      audit('PLAYER_BAN', { user: req.session.user.email, target: name, reason, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/players/ban/:name', async (req, res) => {
    const { name } = req.params;
    if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
    if (ctx.config.demoMode) {
      const i = Demo.DEMO_BANS.players.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
      if (i !== -1) Demo.DEMO_BANS.players.splice(i, 1);
      return res.json({ ok: true });
    }
    try {
      if (ctx.rconConnected) await ctx.rconCmd(`pardon ${name}`);
      await SF.setBannedPlayers(ctx.config.serverPath, (await SF.getBannedPlayers(ctx.config.serverPath)).filter(e => e.name.toLowerCase() !== name.toLowerCase()));
      audit('PLAYER_UNBAN', { user: req.session.user.email, target: name, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/players/kick', async (req, res) => {
    const { name, reason: rawReason = 'Kicked by admin' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!isValidMinecraftName(name)) return res.status(400).json({ error: 'Invalid player name' });
    const reason = sanitizeReason(rawReason);
    if (ctx.config.demoMode) {
      ctx.broadcast({ type: 'log', time: Date.now(), line: `[Server thread/INFO] [minecraft/MinecraftServer]: [DEMO] Kicked ${name}: ${reason}` });
      return res.json({ ok: true });
    }
    try {
      await ctx.rconCmd(`kick ${name} ${reason}`);
      audit('PLAYER_KICK', { user: req.session.user.email, target: name, reason, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(503).json({ error: err.message }); }
  });

  router.post('/players/say', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    if (!isSafeCommand(message)) return res.status(400).json({ error: 'Invalid message' });
    if (ctx.config.demoMode) {
      ctx.broadcast({ type: 'log', time: Date.now(), line: `[Server thread/INFO] [minecraft/MinecraftServer]: [Server] ${message}` });
      return res.json({ ok: true });
    }
    try { await ctx.rconCmd(`say ${message}`); res.json({ ok: true }); }
    catch (err) { res.status(503).json({ error: err.message }); }
  });

  return router;
}
