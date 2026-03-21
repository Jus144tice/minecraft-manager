// Installed mod routes: list, Modrinth lookup (bulk SHA1), toggle, delete, cache management.
// Mutating endpoints (toggle, delete) require admin access.

import { Router } from 'express';
import * as SF from '../serverFiles.js';
import * as Modrinth from '../modrinth.js';
import * as Demo from '../demoData.js';
import * as ModCache from '../modCache.js';
import { audit } from '../audit.js';
import { isSafeModFilename } from '../validate.js';
import { requireCapability } from '../middleware.js';
import { getSelectedConfig } from '../environments.js';

export default function modRoutes(ctx) {
  const router = Router();

  router.get('/mods', async (req, res) => {
    if (ctx.config.demoMode) return res.json({ mods: Demo.DEMO_MODS });
    try {
      const env = getSelectedConfig(ctx, req);
      const mods = await SF.listMods(env.serverPath, env.modsFolder, env.disabledModsFolder);
      res.json({ mods });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
      const env = getSelectedConfig(ctx, req);
      const hashMap = await SF.hashMods(env.serverPath, env.modsFolder, env.disabledModsFolder);
      const allHashes = Object.values(hashMap).map((v) => v.hash);

      // Check cache first
      const cached = await ModCache.getCachedBatch(allHashes);
      const missHashes = allHashes.filter((h) => !cached.has(h));

      // Fetch only cache misses from Modrinth
      let freshData = {};
      if (missHashes.length > 0) {
        freshData = await Modrinth.lookupByHashes(missHashes);
        // Store results + negatives in cache
        const entries = missHashes.map((h) => ({
          sha1: h,
          found: !!freshData[h],
          metadata: freshData[h] || null,
        }));
        await ModCache.setCachedBatch(entries);
        // Cache icons (fire-and-forget)
        for (const entry of entries) {
          if (entry.metadata?.iconUrl) {
            ModCache.cacheIcon(entry.sha1, entry.metadata.iconUrl).catch(() => {});
          }
        }
      }

      // Merge cached + fresh
      const result = {};
      for (const [filename, { hash, enabled }] of Object.entries(hashMap)) {
        const cachedEntry = cached.get(hash);
        const modrinth = cachedEntry?.found ? cachedEntry.metadata : freshData[hash] || null;
        result[filename] = { hash, enabled, modrinth };
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cache invalidation
  router.post('/mods/cache/invalidate', requireCapability('server.manage_mods'), async (req, res) => {
    if (ctx.config.demoMode) return res.json({ ok: true });
    await ModCache.invalidateAll();
    audit('MOD_CACHE_INVALIDATE', { user: req.session?.user?.email, ip: req.ip });
    res.json({ ok: true });
  });

  router.post('/mods/toggle', requireCapability('server.manage_mods'), async (req, res) => {
    const { filename, enable } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (!isSafeModFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
    if (ctx.config.demoMode) {
      const mod = Demo.DEMO_MODS.find((m) => m.filename === filename);
      if (mod) mod.enabled = enable;
      return res.json({ ok: true });
    }
    try {
      const env = getSelectedConfig(ctx, req);
      await SF.toggleMod(env.serverPath, filename, enable, env.modsFolder, env.disabledModsFolder);
      audit('MOD_TOGGLE', { user: req.session.user.email, filename, enable, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/mods/:filename', requireCapability('server.manage_mods'), async (req, res) => {
    const { filename } = req.params;
    if (!isSafeModFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
    if (ctx.config.demoMode) {
      const i = Demo.DEMO_MODS.findIndex((m) => m.filename === filename);
      if (i !== -1) Demo.DEMO_MODS.splice(i, 1);
      return res.json({ ok: true });
    }
    try {
      const env = getSelectedConfig(ctx, req);
      await SF.deleteMod(env.serverPath, filename, env.modsFolder, env.disabledModsFolder);
      audit('MOD_DELETE', { user: req.session.user.email, filename, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
