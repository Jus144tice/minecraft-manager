import { Router } from 'express';
import * as SF from '../serverFiles.js';
import * as Demo from '../demoData.js';
import * as Backup from '../backup.js';
import { audit } from '../audit.js';

export default function settingsRoutes(ctx) {
  const router = Router();

  router.get('/settings/properties', async (req, res) => {
    if (ctx.config.demoMode) return res.json(Demo.DEMO_PROPERTIES);
    try { res.json(await SF.getServerProperties(ctx.config.serverPath)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/settings/properties', async (req, res) => {
    if (ctx.config.demoMode) {
      Object.assign(Demo.DEMO_PROPERTIES, req.body);
      return res.json({ ok: true, demo: true });
    }
    try {
      await SF.setServerProperties(ctx.config.serverPath, req.body);
      audit('PROPS_SAVE', { user: req.session.user.email, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/config', (req, res) => {
    const { webPassword: _1, rconPassword: _2, ...safe } = ctx.config;
    res.json(safe);
  });

  router.post('/config', async (req, res) => {
    const allowed = ['serverPath', 'rconHost', 'rconPort', 'rconPassword',
      'startCommand', 'minecraftVersion', 'modsFolder', 'disabledModsFolder', 'demoMode',
      'backupPath', 'backupSchedule', 'backupEnabled', 'maxBackups', 'backupTimezone', 'bindHost'];
    const updates = {};
    for (const k of allowed) {
      if (k in req.body) updates[k] = req.body[k];
    }
    if (req.body.webPassword) updates.webPassword = req.body.webPassword;
    try {
      await ctx.saveConfig(updates);
      if (updates.demoMode === false) ctx.stopDemoActivityTimer();
      if (updates.demoMode === true) ctx.startDemoActivityTimer();
      if (['backupPath', 'backupSchedule', 'backupEnabled', 'maxBackups', 'backupTimezone'].some(k => k in updates)) {
        Backup.setupBackupSchedule(ctx.config, ctx.mc);
      }
      audit('CONFIG_SAVE', { user: req.session.user.email, keys: Object.keys(updates).filter(k => k !== 'webPassword' && k !== 'rconPassword'), ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
