// Modrinth integration routes: browse, search, project detail, versions, download.
// Client-only mods are filtered out of all search results (they crash the server).

import { Router } from 'express';
import * as SF from '../serverFiles.js';
import * as Modrinth from '../modrinth.js';
import * as Demo from '../demoData.js';
import { audit } from '../audit.js';
import { isSafeModFilename } from '../validate.js';
import { marked } from 'marked';

export default function modrinthRoutes(ctx) {
  const router = Router();

  router.get('/modrinth/browse', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    if (ctx.config.demoMode) {
      const start = offset;
      const end = start + limit;
      return res.json({
        ...Demo.DEMO_BROWSE_RESULTS,
        hits: Demo.DEMO_BROWSE_RESULTS.hits.slice(start, end),
        offset: start,
        limit,
      });
    }
    try {
      const results = await Modrinth.searchMods('', {
        mcVersion: ctx.config.minecraftVersion,
        loader: 'forge',
        side: 'all',
        limit,
        offset,
        index: 'downloads',
      });
      res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/modrinth/search', async (req, res) => {
    const q = String(req.query.q || '').slice(0, 200);
    const side = ['all', 'server', 'both'].includes(req.query.side) ? req.query.side : 'all';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    try {
      const results = await Modrinth.searchMods(q, {
        mcVersion: ctx.config.minecraftVersion || (ctx.config.demoMode ? '1.20.1' : undefined),
        loader: 'forge',
        side,
        limit,
        offset,
      });
      res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/modrinth/project/:id', async (req, res) => {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ error: 'Invalid project ID' });
    try {
      const project = await Modrinth.getProject(id);
      const bodyHtml = marked.parse(project.body || '', { breaks: true })
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/javascript:/gi, 'blocked:');
      res.json({ ...project, bodyHtml });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/modrinth/versions/batch', async (req, res) => {
    if (ctx.config.demoMode) return res.json([]);
    try {
      const ids = JSON.parse(req.query.ids || '[]');
      if (!Array.isArray(ids) || ids.length === 0) return res.json([]);
      const clean = ids.filter(id => /^[a-zA-Z0-9_-]{1,64}$/.test(id)).slice(0, 50);
      res.json(await Modrinth.getVersionsBatch(clean));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/modrinth/versions/:projectId', async (req, res) => {
    const { projectId } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) return res.status(400).json({ error: 'Invalid project ID' });
    try {
      const versions = await Modrinth.getProjectVersions(projectId, {
        mcVersion: ctx.config.minecraftVersion || (ctx.config.demoMode ? '1.20.1' : undefined),
        loader: 'forge',
      });
      res.json(versions);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/modrinth/download', async (req, res) => {
    const { versionId } = req.body;
    if (!versionId) return res.status(400).json({ error: 'versionId required' });
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(versionId)) return res.status(400).json({ error: 'Invalid version ID' });

    if (ctx.config.demoMode) {
      const version = await Modrinth.getVersion(versionId).catch(() => null);
      const file = version?.files?.find(f => f.primary) || version?.files?.[0];
      const name = file?.filename || `${versionId}.jar`;
      if (!isSafeModFilename(name)) return res.status(400).json({ error: 'Invalid filename from Modrinth' });
      const fakeSize = file?.size || 1024 * 1024;
      Demo.DEMO_MODS.push({
        filename: name, size: fakeSize, enabled: true,
        modrinthData: { projectTitle: name.replace(/\.jar$/i, ''), clientSide: 'required', serverSide: 'required', versionNumber: 'downloaded', iconUrl: null },
      });
      return res.json({ ok: true, filename: name, size: fakeSize, demo: true });
    }

    try {
      const version = await Modrinth.getVersion(versionId);
      const file = version.files.find(f => f.primary) || version.files[0];
      if (!file) throw new Error('No downloadable file found for this version');
      const name = file.filename;
      if (!isSafeModFilename(name)) throw new Error(`Unsafe filename from Modrinth: ${name}`);
      const { buffer } = await Modrinth.downloadModFile(file.url, name, file.hashes?.sha1);
      await SF.saveMod(ctx.config.serverPath, name, buffer, ctx.config.modsFolder);
      audit('MOD_INSTALL', { user: req.session.user.email, filename: name, versionId, ip: req.ip });
      res.json({ ok: true, filename: name, size: buffer.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
