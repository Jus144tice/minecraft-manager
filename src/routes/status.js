// Server status route: running state, uptime, RCON status, online player count.

import { Router } from 'express';
import * as Demo from '../demoData.js';

export default function statusRoutes(ctx) {
  const router = Router();

  router.get('/status', async (req, res) => {
    if (ctx.config.demoMode) {
      return res.json(Demo.getDemoStatus(ctx.demoState.running, ctx.getDemoUptime()));
    }
    let onlineCount = 0;
    if (ctx.rconConnected) {
      try {
        const r = await ctx.rconCmd('list');
        const m = r.match(/There are (\d+)/);
        if (m) onlineCount = parseInt(m[1]);
      } catch { /* starting */ }
    }
    res.json({
      running: ctx.mc.running,
      uptime: ctx.mc.getUptime(),
      rconConnected: ctx.rconConnected,
      onlineCount,
      serverPath: ctx.config.serverPath,
      minecraftVersion: ctx.config.minecraftVersion || 'unknown',
    });
  });

  return router;
}
