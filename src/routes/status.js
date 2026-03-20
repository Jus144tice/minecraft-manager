// Server status route: running state, uptime, RCON status, performance metrics.

import { Router } from 'express';
import * as Demo from '../demoData.js';
import { collectMetrics, collectDemoMetrics } from '../metrics.js';
import { listEnvironments } from '../environments.js';

export default function statusRoutes(ctx) {
  const router = Router();

  router.get('/status', async (req, res) => {
    const envInfo = {
      activeEnvironment: ctx.rawConfig?.activeEnvironment || 'default',
      selectedEnvironment: req.session?.selectedEnvironment || ctx.rawConfig?.activeEnvironment || 'default',
      environments: ctx.rawConfig ? listEnvironments(ctx.rawConfig) : [],
    };

    if (ctx.config.demoMode) {
      const m = collectDemoMetrics();
      const demoEnvs = Object.entries(Demo.DEMO_ENVIRONMENTS).map(([id, env]) => ({
        id,
        name: env.name,
        isActive: id === 'production',
        minecraftVersion: env.minecraftVersion,
      }));
      return res.json({
        ...Demo.getDemoStatus(ctx.demoState.running, ctx.getDemoUptime()),
        ...m,
        activeEnvironment: 'production',
        selectedEnvironment: req.session?.selectedEnvironment || 'production',
        environments: demoEnvs,
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
      ...envInfo,
    });
  });

  return router;
}
