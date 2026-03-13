// Server status route: running state, uptime, RCON status, performance metrics.

import { Router } from 'express';
import * as Demo from '../demoData.js';
import { collectMetrics, collectDemoMetrics } from '../metrics.js';

export default function statusRoutes(ctx) {
  const router = Router();

  router.get('/status', async (req, res) => {
    if (ctx.config.demoMode) {
      const m = collectDemoMetrics();
      return res.json({
        ...Demo.getDemoStatus(ctx.demoState.running, ctx.getDemoUptime()),
        ...m,
      });
    }
    const m = await collectMetrics({
      mc: ctx.mc,
      rconCmd: ctx.rconCmd,
      rconConnected: ctx.rconConnected,
      config: ctx.config,
    });
    res.json({
      running: ctx.mc.running,
      uptime: ctx.mc.getUptime(),
      rconConnected: ctx.rconConnected,
      serverPath: ctx.config.serverPath,
      minecraftVersion: ctx.config.minecraftVersion || 'unknown',
      ...m,
    });
  });

  return router;
}
