// Environment management routes: list, create, update, delete, deploy, select.
// Only one server runs at a time — "deploy" stops the current server and
// switches the active environment.

import { Router } from 'express';
import { cp, access, mkdir } from 'fs/promises';
import { audit, info } from '../audit.js';
import { requireCapability } from '../middleware.js';
import { acquireOp, releaseOp } from '../operationLock.js';
import { resetCaches } from '../metrics.js';
import {
  listEnvironments,
  getEnvironment,
  createEnvironment,
  updateEnvironment,
  deleteEnvironment,
  validateEnvironmentId,
  validateEnvironmentConfig,
  slugify,
  resolveConfig,
} from '../environments.js';
import * as Demo from '../demoData.js';

export default function environmentRoutes(ctx) {
  const router = Router();

  // ---- Read-only endpoints (any authenticated user) ---------

  /** GET /environments — list all environments */
  router.get('/environments', (req, res) => {
    if (ctx.config.demoMode) {
      const envs = Object.entries(Demo.DEMO_ENVIRONMENTS).map(([id, env]) => ({
        id,
        name: env.name,
        isActive: id === 'production',
        serverPath: env.serverPath,
        minecraftVersion: env.minecraftVersion,
      }));
      return res.json({ environments: envs, activeEnvironment: 'production' });
    }
    const envs = listEnvironments(ctx.rawConfig);
    res.json({ environments: envs, activeEnvironment: ctx.rawConfig.activeEnvironment });
  });

  /** GET /environments/:id — get full environment config */
  router.get('/environments/:id', (req, res) => {
    if (ctx.config.demoMode) {
      const env = Demo.DEMO_ENVIRONMENTS[req.params.id];
      if (!env) return res.status(404).json({ error: 'Environment not found' });
      return res.json({ id: req.params.id, ...env, isActive: req.params.id === 'production' });
    }
    const env = getEnvironment(ctx.rawConfig, req.params.id);
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    // Redact rconPassword
    const { rconPassword: _rp, ...safe } = env;
    res.json({ id: req.params.id, ...safe, isActive: req.params.id === ctx.rawConfig.activeEnvironment });
  });

  /** POST /environments/select — set the selected environment for UI browsing */
  router.post('/environments/select', (req, res) => {
    const { id } = req.body;
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Environment ID is required.' });
    }
    if (ctx.config.demoMode) {
      if (!Demo.DEMO_ENVIRONMENTS[id]) {
        return res.status(404).json({ error: 'Environment not found' });
      }
      req.session.selectedEnvironment = id;
      return res.json({ selected: id });
    }
    if (!getEnvironment(ctx.rawConfig, id)) {
      return res.status(404).json({ error: 'Environment not found' });
    }
    req.session.selectedEnvironment = id;
    res.json({ selected: id });
  });

  // ---- Mutation endpoints (environments.manage capability) ---

  /** POST /environments — create a new environment */
  router.post('/environments', requireCapability('environments.manage'), async (req, res) => {
    if (ctx.config.demoMode) return res.status(400).json({ error: 'Cannot create environments in demo mode.' });

    const { id: requestedId, name, clone, ...envSettings } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Environment name is required.' });
    }

    const id = requestedId && typeof requestedId === 'string' ? requestedId : slugify(name);
    if (!validateEnvironmentId(id)) {
      return res.status(400).json({
        error: `Invalid environment ID "${id}". Use lowercase letters, numbers, and hyphens (1-32 chars).`,
      });
    }

    // Clone mode: copy server directory from source environment
    if (clone && typeof clone === 'object' && clone.sourceId && clone.destPath) {
      const sourceEnv = getEnvironment(ctx.rawConfig, clone.sourceId);
      if (!sourceEnv) {
        return res.status(400).json({ error: `Source environment "${clone.sourceId}" not found.` });
      }

      // Check destination doesn't exist
      try {
        await access(clone.destPath);
        return res.status(400).json({ error: `Destination path "${clone.destPath}" already exists.` });
      } catch {
        // Expected — path doesn't exist yet
      }

      let lockId;
      try {
        lockId = acquireOp('environment clone', ['files']);

        // Create parent directory if needed
        const parentDir = clone.destPath.replace(/[\\/][^\\/]+$/, '');
        await mkdir(parentDir, { recursive: true });

        // Copy the server directory
        info('Cloning environment', { source: clone.sourceId, dest: clone.destPath });
        await cp(sourceEnv.serverPath, clone.destPath, { recursive: true });

        // Create the new environment with cloned settings
        const envConfig = {
          ...sourceEnv,
          name,
          serverPath: clone.destPath,
          ...envSettings,
        };
        delete envConfig.createdAt;

        const updated = createEnvironment(ctx.rawConfig, id, envConfig);
        ctx.rawConfig = updated;
        await ctx.saveRawConfig();

        audit('ENVIRONMENT_CREATE', { id, name, clonedFrom: clone.sourceId }, req);
        info('Environment cloned', { id, source: clone.sourceId, dest: clone.destPath });

        res.json({ id, environment: getEnvironment(ctx.rawConfig, id) });
      } catch (err) {
        res.status(400).json({ error: err.message });
      } finally {
        if (lockId != null) releaseOp(lockId);
      }
      return;
    }

    // Point-to-directory mode
    const envConfig = { name, ...envSettings };
    const errors = validateEnvironmentConfig(envConfig);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(' ') });
    }

    try {
      const updated = createEnvironment(ctx.rawConfig, id, envConfig);
      ctx.rawConfig = updated;
      await ctx.saveRawConfig();

      audit('ENVIRONMENT_CREATE', { id, name }, req);
      info('Environment created', { id, name });

      res.json({ id, environment: getEnvironment(ctx.rawConfig, id) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** PUT /environments/:id — update an environment's config */
  router.put('/environments/:id', requireCapability('environments.manage'), async (req, res) => {
    if (ctx.config.demoMode) return res.status(400).json({ error: 'Cannot modify environments in demo mode.' });

    try {
      const updated = updateEnvironment(ctx.rawConfig, req.params.id, req.body);
      ctx.rawConfig = updated;

      // Re-materialize config if updating the active environment
      if (req.params.id === ctx.rawConfig.activeEnvironment) {
        ctx.config = resolveConfig(ctx.rawConfig);
      }

      await ctx.saveRawConfig();

      audit('ENVIRONMENT_UPDATE', { id: req.params.id, changes: Object.keys(req.body) }, req);
      res.json({ id: req.params.id, environment: getEnvironment(ctx.rawConfig, req.params.id) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** DELETE /environments/:id — delete a non-active environment */
  router.delete('/environments/:id', requireCapability('environments.manage'), async (req, res) => {
    if (ctx.config.demoMode) return res.status(400).json({ error: 'Cannot delete environments in demo mode.' });

    try {
      const updated = deleteEnvironment(ctx.rawConfig, req.params.id);
      ctx.rawConfig = updated;
      await ctx.saveRawConfig();

      audit('ENVIRONMENT_DELETE', { id: req.params.id }, req);
      info('Environment deleted', { id: req.params.id });

      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** POST /environments/:id/deploy — stop current server, switch active env, optionally start */
  router.post('/environments/:id/deploy', requireCapability('environments.manage'), async (req, res) => {
    const targetId = req.params.id;

    if (ctx.config.demoMode) {
      // Demo: simulate deploy
      req.session.selectedEnvironment = targetId;
      return res.json({ ok: true, activeEnvironment: targetId, started: !!req.body.start });
    }

    if (!getEnvironment(ctx.rawConfig, targetId)) {
      return res.status(404).json({ error: `Environment "${targetId}" not found.` });
    }

    const previousEnv = ctx.rawConfig.activeEnvironment;
    if (targetId === previousEnv) {
      return res.json({ ok: true, activeEnvironment: targetId, message: 'Already the active environment.' });
    }

    let lockId;
    try {
      lockId = acquireOp('environment deploy', ['lifecycle', 'files']);

      // 1. Stop server if running
      if (ctx.mc.running) {
        ctx.markIntentionalStop();
        info('Deploy: stopping current server', { currentEnv: previousEnv, targetEnv: targetId });

        if (ctx.rconConnected) {
          try {
            await ctx.rconCmd('say Switching environments — server restarting...');
            await ctx.rconCmd('save-all');
            await new Promise((r) => setTimeout(r, 2000));
            await ctx.rconCmd('stop');
          } catch {
            ctx.mc.stop();
          }
        } else {
          ctx.mc.stop();
        }

        // Wait for stop (up to 45s)
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            ctx.mc.kill();
            resolve();
          }, 45000);
          ctx.mc.once('stopped', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }

      // 2. Switch active environment
      await ctx.switchEnvironment(targetId);
      resetCaches();

      // 3. Update session selection to match
      req.session.selectedEnvironment = targetId;

      // 4. Optionally start the new environment's server
      let started = false;
      if (req.body.start) {
        ctx.mc.start(ctx.config.launch, ctx.config.serverPath);
        ctx.scheduleRconConnect(15000);
        started = true;
      }

      ctx.broadcastStatus();
      ctx.broadcast({ type: 'environment-switched', activeEnvironment: targetId, previousEnvironment: previousEnv });

      audit('ENVIRONMENT_DEPLOY', { from: previousEnv, to: targetId, started }, req);
      info('Environment deployed', { from: previousEnv, to: targetId, started });

      res.json({ ok: true, activeEnvironment: targetId, previousEnvironment: previousEnv, started });
    } catch (err) {
      res.status(400).json({ error: err.message });
    } finally {
      if (lockId != null) releaseOp(lockId);
    }
  });

  return router;
}
