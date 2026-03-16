// Backup routes: list, create, restore, delete, schedule info.
// Endpoints require specific backup capabilities.

import { Router } from 'express';
import * as Backup from '../backup.js';
import { requireCapability } from '../middleware.js';
import { getActiveOps } from '../operationLock.js';

export default function backupRoutes(ctx) {
  const router = Router();

  router.get('/backups', requireCapability('server.view_backups'), async (req, res) => {
    try {
      res.json(await Backup.listBackups(ctx.config));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/backups', requireCapability('server.create_backup'), async (req, res) => {
    const { note } = req.body || {};
    try {
      const result = await Backup.createBackup(ctx.config, {
        type: 'manual',
        note: String(note || '').slice(0, 200),
        user: req.session.user.email,
        rconCmd: ctx.rconConnected ? ctx.rconCmd : null,
      });
      res.json(result);
    } catch (err) {
      const status = err.message.includes('already in progress') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.post('/backups/restore', requireCapability('server.restore_backup'), async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (ctx.config.demoMode) return res.status(400).json({ error: 'Cannot restore in demo mode' });
    try {
      const result = await Backup.restoreBackup(ctx.config, filename, ctx.mc);
      ctx.config = await ctx.loadConfig();
      res.json(result);
    } catch (err) {
      const status = err.message.includes('already in progress') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.get('/backups/lock', requireCapability('server.view_backups'), (_req, res) => {
    res.json({ lock: Backup.getBackupLock() });
  });

  router.get('/operations', requireCapability('server.view_backups'), (_req, res) => {
    res.json({ operations: getActiveOps() });
  });

  router.post('/backups/validate', requireCapability('server.view_backups'), async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (!filename.endsWith('.tar.gz')) return res.status(400).json({ error: 'Invalid backup file' });
    try {
      const result = await Backup.validateBackup(ctx.config, filename);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/backups/:filename', requireCapability('server.delete_backup'), async (req, res) => {
    const { filename } = req.params;
    if (!filename.endsWith('.tar.gz')) return res.status(400).json({ error: 'Invalid backup file' });
    try {
      await Backup.deleteBackup(ctx.config, filename);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/backups/schedule', requireCapability('server.view_backups'), (req, res) => {
    res.json({
      enabled: !!ctx.config.backupEnabled,
      schedule: ctx.config.backupSchedule || '0 3 * * *',
      backupPath: ctx.config.backupPath || '',
      maxBackups: ctx.config.maxBackups || 0,
      backupTimezone: ctx.config.backupTimezone || '',
    });
  });

  return router;
}
