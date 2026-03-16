// Server control routes: start, stop, kill, restart, RCON command, stdin.
// All mutating endpoints require admin access.

import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import * as Demo from '../demoData.js';
import { audit } from '../audit.js';
import { isSafeCommand } from '../validate.js';
import { getActiveOps } from '../operationLock.js';
import { requireCapability } from '../middleware.js';
import { getServerProperties } from '../serverFiles.js';

export default function serverRoutes(ctx) {
  const router = Router();

  // Check if a conflicting operation holds the 'lifecycle' scope (e.g. restore).
  function checkLifecycleLock(action) {
    const conflict = getActiveOps().find((op) => op.scopes.includes('lifecycle'));
    if (conflict) {
      throw new Error(
        `Cannot ${action}: ${conflict.name} is already in progress (started ${new Date(conflict.startedAt).toISOString()}). Wait for it to finish.`,
      );
    }
  }

  router.post('/server/start', requireCapability('server.start'), async (req, res) => {
    if (ctx.config.demoMode) {
      if (ctx.demoState.running) return res.status(400).json({ error: 'Demo server is already running' });
      ctx.demoState.running = true;
      ctx.demoState.startTime = Date.now();
      ctx.broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Starting demo server...' });
      Demo.DEMO_STARTUP_LOGS.forEach((line, i) => {
        setTimeout(() => {
          ctx.broadcast({ type: 'log', time: Date.now(), line });
          if (i === Demo.DEMO_STARTUP_LOGS.length - 1) {
            ctx.broadcastStatus();
            ctx.startDemoActivityTimer();
          }
        }, i * 120);
      });
      return res.json({ ok: true, message: '[DEMO] Server starting...' });
    }
    try {
      checkLifecycleLock('start server');
      ctx.mc.start(ctx.config.launch, ctx.config.serverPath);
      ctx.scheduleRconConnect(15000);
      ctx.broadcastStatus();
      audit('SERVER_START', { user: req.session.user.email, ip: req.ip });
      res.json({ ok: true, message: 'Server starting...' });
    } catch (err) {
      const status = err.message.includes('already in progress') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.post('/server/stop', requireCapability('server.stop'), async (req, res) => {
    if (ctx.config.demoMode) {
      if (!ctx.demoState.running) return res.status(400).json({ error: 'Demo server is not running' });
      ctx.broadcast({
        type: 'log',
        time: Date.now(),
        line: '[Server thread/INFO] [minecraft/MinecraftServer]: Stopping server',
      });
      ctx.broadcast({
        type: 'log',
        time: Date.now(),
        line: '[Server thread/INFO] [minecraft/MinecraftServer]: Saving worlds',
      });
      ctx.broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Server stopped.' });
      ctx.demoState.running = false;
      ctx.demoState.startTime = null;
      ctx.stopDemoActivityTimer();
      ctx.broadcastStatus();
      return res.json({ ok: true, message: '[DEMO] Server stopped.' });
    }
    try {
      ctx.markIntentionalStop();
      if (ctx.rconConnected) {
        await ctx.rconCmd('stop');
      } else {
        ctx.mc.stop();
      }
      audit('SERVER_STOP', { user: req.session.user.email, ip: req.ip });
      res.json({ ok: true, message: 'Stop signal sent' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/server/kill', requireCapability('server.stop'), async (req, res) => {
    if (ctx.config.demoMode) {
      ctx.demoState.running = false;
      ctx.demoState.startTime = null;
      ctx.stopDemoActivityTimer();
      ctx.broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Process force-killed.' });
      ctx.broadcastStatus();
      return res.json({ ok: true, message: '[DEMO] Killed.' });
    }
    ctx.markIntentionalStop();
    ctx.mc.kill();
    audit('SERVER_KILL', { user: req.session.user.email, ip: req.ip });
    res.json({ ok: true, message: 'Process killed' });
  });

  router.post('/server/restart', requireCapability('server.restart'), async (req, res) => {
    if (ctx.config.demoMode) {
      ctx.demoState.running = false;
      ctx.demoState.startTime = null;
      ctx.stopDemoActivityTimer();
      ctx.broadcast({ type: 'log', time: Date.now(), line: '[Manager] [DEMO] Restarting server...' });
      ctx.broadcastStatus();
      setTimeout(async () => {
        ctx.demoState.running = true;
        ctx.demoState.startTime = Date.now();
        Demo.DEMO_STARTUP_LOGS.forEach((line, i) => {
          setTimeout(() => {
            ctx.broadcast({ type: 'log', time: Date.now(), line });
            if (i === Demo.DEMO_STARTUP_LOGS.length - 1) {
              ctx.broadcastStatus();
              ctx.startDemoActivityTimer();
            }
          }, i * 120);
        });
      }, 1500);
      return res.json({ ok: true, message: '[DEMO] Restarting...' });
    }
    try {
      checkLifecycleLock('restart server');
      ctx.markIntentionalStop();
      const stopped = new Promise((resolve) => ctx.mc.once('stopped', resolve));
      if (ctx.rconConnected) {
        await ctx.rconCmd('stop');
      } else {
        ctx.mc.stop();
      }
      await Promise.race([stopped, new Promise((r) => setTimeout(r, 30000))]);
      ctx.mc.start(ctx.config.launch, ctx.config.serverPath);
      ctx.scheduleRconConnect(15000);
      ctx.broadcastStatus();
      audit('SERVER_RESTART', { user: req.session.user.email, ip: req.ip });
      res.json({ ok: true, message: 'Restarting...' });
    } catch (err) {
      const status = err.message.includes('already in progress') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.post('/server/command', requireCapability('server.send_console_command'), async (req, res) => {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    if (!isSafeCommand(command)) return res.status(400).json({ error: 'Invalid command' });
    if (ctx.config.demoMode) {
      const line = `[Server thread/INFO] [minecraft/DedicatedServer]: [DEMO] Executed: ${command}`;
      ctx.broadcast({ type: 'log', time: Date.now(), line });
      return res.json({ ok: true, result: '[DEMO] Command echoed to console.' });
    }
    try {
      const result = await ctx.rconCmd(command);
      audit('CONSOLE_CMD', { user: req.session.user.email, command, ip: req.ip });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  router.post('/server/stdin', requireCapability('server.send_console_command'), async (req, res) => {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    if (!isSafeCommand(command)) return res.status(400).json({ error: 'Invalid command' });
    if (ctx.config.demoMode) {
      ctx.broadcast({ type: 'log', time: Date.now(), line: `> ${command}` });
      return res.json({ ok: true });
    }
    try {
      ctx.mc.sendConsoleCommand(command);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/server/regenerate-world', requireCapability('server.manage_world'), async (req, res) => {
    if (ctx.config.demoMode) {
      return res.json({ ok: true, message: '[DEMO] World deleted. Start the server to generate a new world.' });
    }
    try {
      if (ctx.mc.running) {
        return res.status(400).json({ error: 'Server must be stopped before regenerating the world.' });
      }
      checkLifecycleLock('regenerate world');

      const props = await getServerProperties(ctx.config.serverPath);
      const levelName = props['level-name'] || 'world';

      // Validate level-name is safe (no traversal)
      if (levelName.includes('..') || levelName.includes('/') || levelName.includes('\\')) {
        return res.status(400).json({ error: 'Invalid level-name in server.properties' });
      }

      const worldPath = path.join(ctx.config.serverPath, levelName);

      // Also remove nether/end dimension folders that Minecraft creates alongside
      const folders = [worldPath, `${worldPath}_nether`, `${worldPath}_the_end`];
      for (const dir of folders) {
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          /* folder may not exist */
        }
      }

      audit('WORLD_REGENERATE', { user: req.session.user.email, levelName, ip: req.ip });
      res.json({
        ok: true,
        message: `World "${levelName}" deleted. Start the server to generate a new world.`,
      });
    } catch (err) {
      const status = err.message.includes('already in progress') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  return router;
}
