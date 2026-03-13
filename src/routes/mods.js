// Installed mod routes: list, Modrinth lookup (bulk SHA1), toggle, delete.

import { Router } from 'express';
import * as SF from '../serverFiles.js';
import * as Modrinth from '../modrinth.js';
import * as Demo from '../demoData.js';
import { audit } from '../audit.js';
import { isSafeModFilename } from '../validate.js';

export default function modRoutes(ctx) {
  const router = Router();

  router.get('/mods', async (req, res) => {
    if (ctx.config.demoMode) return res.json({ mods: Demo.DEMO_MODS });
    try {
      const mods = await SF.listMods(ctx.config.serverPath, ctx.config.modsFolder, ctx.config.disabledModsFolder);
      res.json({ mods });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/mods/lookup', async (req, res) => {
    if (ctx.config.demoMode) {
      const result = {};
      for (const mod of Demo.DEMO_MODS) {
        result[mod.filename] = { hash: 'demo-hash-' + mod.filename, enabled: mod.enabled, modrinth: mod.modrinthData };
      }
      return res.json(result);
    }
    try {
      const hashMap = await SF.hashMods(ctx.config.serverPath, ctx.config.modsFolder, ctx.config.disabledModsFolder);
      const hashes = Object.values(hashMap).map(v => v.hash);
      const modrinthData = await Modrinth.lookupByHashes(hashes);
      const result = {};
      for (const [filename, { hash, enabled }] of Object.entries(hashMap)) {
        result[filename] = { hash, enabled, modrinth: modrinthData[hash] || null };
      }
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/mods/toggle', async (req, res) => {
    const { filename, enable } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (!isSafeModFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
    if (ctx.config.demoMode) {
      const mod = Demo.DEMO_MODS.find(m => m.filename === filename);
      if (mod) mod.enabled = enable;
      return res.json({ ok: true });
    }
    try {
      await SF.toggleMod(ctx.config.serverPath, filename, enable, ctx.config.modsFolder, ctx.config.disabledModsFolder);
      audit('MOD_TOGGLE', { user: req.session.user.email, filename, enable, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/mods/:filename', async (req, res) => {
    const { filename } = req.params;
    if (!isSafeModFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
    if (ctx.config.demoMode) {
      const i = Demo.DEMO_MODS.findIndex(m => m.filename === filename);
      if (i !== -1) Demo.DEMO_MODS.splice(i, 1);
      return res.json({ ok: true });
    }
    try {
      await SF.deleteMod(ctx.config.serverPath, filename, ctx.config.modsFolder, ctx.config.disabledModsFolder);
      audit('MOD_DELETE', { user: req.session.user.email, filename, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
