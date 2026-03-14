// Settings routes: server.properties editor, app config (config.json), directory browser.
// Config POST validates cron expressions and refreshes the backup schedule when changed.
// GET /config redacts rconPassword and webPassword before responding.

import { Router } from 'express';
import { readdir, stat, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import * as SF from '../serverFiles.js';
import * as Demo from '../demoData.js';
import cron from 'node-cron';
import * as Backup from '../backup.js';
import { audit } from '../audit.js';
import { runPreflight } from '../preflight.js';
import { requireAdmin } from '../middleware.js';

export default function settingsRoutes(ctx) {
  const router = Router();

  router.get('/settings/properties', async (req, res) => {
    if (ctx.config.demoMode) return res.json(Demo.DEMO_PROPERTIES);
    try {
      res.json(await SF.getServerProperties(ctx.config.serverPath));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/settings/properties', requireAdmin, async (req, res) => {
    if (ctx.config.demoMode) {
      Object.assign(Demo.DEMO_PROPERTIES, req.body);
      return res.json({ ok: true, demo: true });
    }
    try {
      await SF.setServerProperties(ctx.config.serverPath, req.body);
      audit('PROPS_SAVE', { user: req.session.user.email, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/config', (req, res) => {
    const { webPassword: _1, rconPassword: _2, ...safe } = ctx.config;
    res.json(safe);
  });

  router.post('/config', requireAdmin, async (req, res) => {
    const allowed = [
      'serverPath',
      'serverAddress',
      'rconHost',
      'rconPort',
      'rconPassword',
      'launch',
      'minecraftVersion',
      'modsFolder',
      'disabledModsFolder',
      'demoMode',
      'backupPath',
      'backupSchedule',
      'backupEnabled',
      'maxBackups',
      'backupTimezone',
      'bindHost',
      'autoStart',
      'autoRestart',
      'tpsAlertThreshold',
      'notifications',
    ];
    const updates = {};
    for (const k of allowed) {
      if (k in req.body) updates[k] = req.body[k];
    }
    // Validate launch config structure
    if (updates.launch) {
      if (typeof updates.launch !== 'object' || !updates.launch.executable || !Array.isArray(updates.launch.args)) {
        return res.status(400).json({
          error: 'Invalid launch config: must include "executable" (string) and "args" (array).',
        });
      }
      if (!updates.launch.executable.trim()) {
        return res.status(400).json({ error: 'Launch executable cannot be empty.' });
      }
      // Sanitize: only keep known keys
      updates.launch = {
        executable: updates.launch.executable,
        args: updates.launch.args.map(String),
        ...(updates.launch.env && typeof updates.launch.env === 'object' ? { env: updates.launch.env } : {}),
      };
    }
    // Sanitize notifications config
    if (updates.notifications) {
      if (typeof updates.notifications !== 'object' || Array.isArray(updates.notifications)) {
        return res.status(400).json({ error: 'notifications must be an object.' });
      }
      const n = updates.notifications;
      updates.notifications = {
        ...(n.webhookUrl && typeof n.webhookUrl === 'string' ? { webhookUrl: n.webhookUrl.trim() } : {}),
        ...(Array.isArray(n.events) ? { events: n.events.filter((e) => typeof e === 'string') } : {}),
      };
    }
    // Validate cron expression before saving
    if (updates.backupSchedule && !cron.validate(updates.backupSchedule)) {
      return res.status(400).json({
        error: `Invalid cron expression: "${updates.backupSchedule}". Use a format like "0 3 * * *" (minute hour day month weekday).`,
      });
    }

    try {
      await ctx.saveConfig(updates);
      if (updates.demoMode === false) ctx.stopDemoActivityTimer();
      if (updates.demoMode === true) ctx.startDemoActivityTimer();
      if (['backupPath', 'backupSchedule', 'backupEnabled', 'maxBackups', 'backupTimezone'].some((k) => k in updates)) {
        Backup.setupBackupSchedule(ctx.config, {
          rconCmd: ctx.rconCmd,
          get rconConnected() {
            return ctx.rconConnected;
          },
        });
      }
      audit('CONFIG_SAVE', {
        user: req.session.user.email,
        keys: Object.keys(updates).filter((k) => k !== 'rconPassword'),
        ip: req.ip,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Server-side directory browser ---
  router.get('/browse-dirs', async (req, res) => {
    const isWin = os.platform() === 'win32';
    const requested = req.query.path || '';

    try {
      // No path requested: return filesystem roots
      if (!requested) {
        if (isWin) {
          const drives = [];
          for (let c = 65; c <= 90; c++) {
            const letter = String.fromCharCode(c);
            try {
              await stat(`${letter}:\\`);
              drives.push({ name: `${letter}:\\`, path: `${letter}:\\` });
            } catch {
              /* drive not available */
            }
          }
          return res.json({ current: '', sep: '\\', crumbs: [], dirs: drives });
        }
        return res.json({ current: '/', sep: '/', crumbs: [{ name: '/', path: '/' }], dirs: [] });
      }

      // Resolve to absolute, walk up to the nearest existing ancestor if needed
      let resolved = path.resolve(requested);
      for (let attempts = 0; attempts < 50; attempts++) {
        try {
          const info = await stat(resolved);
          if (info.isDirectory()) break;
          resolved = path.dirname(resolved);
        } catch {
          const parent = path.dirname(resolved);
          if (parent === resolved) break; // hit root
          resolved = parent;
        }
      }

      const entries = await readdir(resolved, { withFileTypes: true });
      const dirs = entries
        .filter((e) => {
          try {
            return e.isDirectory() && !e.name.startsWith('.');
          } catch {
            return false;
          } // permission errors on some dirs
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((e) => ({
          name: e.name,
          path: path.join(resolved, e.name),
        }));

      // Build breadcrumb segments for the current path
      const crumbs = [];
      let crumbPath = resolved;
      while (true) {
        const name = path.basename(crumbPath) || crumbPath; // root has no basename
        crumbs.unshift({ name, path: crumbPath });
        const parent = path.dirname(crumbPath);
        if (parent === crumbPath) break; // hit root
        crumbPath = parent;
      }

      res.json({ current: resolved, sep: path.sep, crumbs, dirs });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Preflight checks ----
  router.get('/preflight', async (_req, res) => {
    try {
      const result = await runPreflight(ctx.config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a directory (used by the directory browser's "New Folder" button)
  router.post('/mkdir', requireAdmin, async (req, res) => {
    const { path: dirPath } = req.body;
    if (!dirPath || typeof dirPath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    try {
      const resolved = path.resolve(dirPath);
      await mkdir(resolved, { recursive: true });
      res.json({ ok: true, path: resolved });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
