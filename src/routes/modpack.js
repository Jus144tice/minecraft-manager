// Modpack routes: export current mods as a shareable manifest, import from manifest.
// Uses Modrinth hashes to identify mods and resolve versions for download.

import { Router } from 'express';
import * as SF from '../serverFiles.js';
import * as Modrinth from '../modrinth.js';
import * as Demo from '../demoData.js';
import { audit } from '../audit.js';
import { isSafeModFilename } from '../validate.js';
import { acquireOp, releaseOp } from '../operationLock.js';
import { requireAdmin } from '../middleware.js';

export default function modpackRoutes(ctx) {
  const router = Router();

  router.get('/modpack/export', async (req, res) => {
    try {
      const hashMap = ctx.config.demoMode
        ? (() => {
            const m = {};
            for (const mod of Demo.DEMO_MODS) m[mod.filename] = { hash: 'demo-' + mod.filename, enabled: mod.enabled };
            return m;
          })()
        : await SF.hashMods(ctx.config.serverPath, ctx.config.modsFolder, ctx.config.disabledModsFolder);

      let modrinthLookup = {};
      if (ctx.config.demoMode) {
        for (const mod of Demo.DEMO_MODS) {
          if (mod.modrinthData) {
            modrinthLookup['demo-' + mod.filename] = {
              projectId: mod.modrinthData.projectId || mod.filename,
              projectTitle: mod.modrinthData.projectTitle || mod.filename,
              versionId: mod.modrinthData.versionId || 'demo',
              versionNumber: mod.modrinthData.versionNumber || '0.0.0',
              clientSide: mod.modrinthData.clientSide || 'required',
              serverSide: mod.modrinthData.serverSide || 'required',
            };
          }
        }
      } else {
        const hashes = Object.values(hashMap).map((v) => v.hash);
        modrinthLookup = await Modrinth.lookupByHashes(hashes);
      }

      const mods = [];
      const skipped = { clientOnly: 0, unidentified: 0 };
      for (const [filename, { hash }] of Object.entries(hashMap)) {
        const mr = modrinthLookup[hash];
        if (!mr) {
          skipped.unidentified++;
          continue;
        }
        if (mr.serverSide === 'unsupported') {
          skipped.clientOnly++;
          continue;
        }
        mods.push({
          projectId: mr.projectId,
          projectSlug: mr.projectSlug || null,
          versionId: mr.versionId,
          projectTitle: mr.projectTitle || filename,
          versionNumber: mr.versionNumber || '',
          filename,
          clientSide: mr.clientSide,
          serverSide: mr.serverSide,
        });
      }

      const modpack = {
        name: `${ctx.config.minecraftVersion || 'Minecraft'} Server Modpack`,
        minecraftVersion: ctx.config.minecraftVersion || 'unknown',
        loader: 'forge',
        exportedAt: new Date().toISOString(),
        modCount: mods.length,
        mods,
      };

      audit('MODPACK_EXPORT', { user: req.session.user.email, modCount: mods.length, skipped, ip: req.ip });
      res.json({ modpack, skipped });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/modpack/analyze', async (req, res) => {
    const { modpack } = req.body;
    if (!modpack?.mods || !Array.isArray(modpack.mods)) {
      return res.status(400).json({ error: 'Invalid modpack format: expected { modpack: { mods: [...] } }' });
    }

    try {
      let installedByProject = {};
      if (ctx.config.demoMode) {
        for (const mod of Demo.DEMO_MODS) {
          if (mod.modrinthData?.projectId) {
            installedByProject[mod.modrinthData.projectId] = {
              filename: mod.filename,
              versionId: mod.modrinthData.versionId || 'demo',
              versionNumber: mod.modrinthData.versionNumber || '0.0.0',
            };
          }
        }
      } else {
        const hashMap = await SF.hashMods(ctx.config.serverPath, ctx.config.modsFolder, ctx.config.disabledModsFolder);
        const hashes = Object.values(hashMap).map((v) => v.hash);
        const modrinthLookup = await Modrinth.lookupByHashes(hashes);
        for (const [filename, { hash }] of Object.entries(hashMap)) {
          const mr = modrinthLookup[hash];
          if (mr?.projectId) {
            installedByProject[mr.projectId] = {
              filename,
              versionId: mr.versionId,
              versionNumber: mr.versionNumber,
            };
          }
        }
      }

      const results = {
        skip: [],
        conflict: [],
        install: [],
        clientOnly: [],
      };

      for (const mod of modpack.mods) {
        if (mod.serverSide === 'unsupported') {
          results.clientOnly.push({ ...mod, reason: 'Client-only mod' });
          continue;
        }
        const installed = installedByProject[mod.projectId];
        if (installed) {
          if (installed.versionId === mod.versionId) {
            results.skip.push({
              ...mod,
              reason: 'Same version already installed',
              installedVersion: installed.versionNumber,
            });
          } else {
            results.conflict.push({
              ...mod,
              reason: 'Different version installed',
              installedVersion: installed.versionNumber,
              installedVersionId: installed.versionId,
              installedFilename: installed.filename,
            });
          }
        } else {
          results.install.push(mod);
        }
      }

      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/modpack/import', requireAdmin, async (req, res) => {
    const { mods } = req.body;
    if (!Array.isArray(mods) || mods.length === 0) {
      return res.status(400).json({ error: 'No mods to install' });
    }

    let lockId;
    if (!ctx.config.demoMode) {
      try {
        lockId = acquireOp('modpack import', ['files']);
      } catch (err) {
        return res.status(409).json({ error: err.message });
      }
    }

    const report = { installed: [], failed: [], skipped: [] };

    try {
      for (const mod of mods) {
        if (!mod.versionId || !/^[a-zA-Z0-9_-]{1,64}$/.test(mod.versionId)) {
          report.failed.push({ title: mod.projectTitle || mod.versionId, error: 'Invalid version ID' });
          continue;
        }

        try {
          if (ctx.config.demoMode) {
            const version = await Modrinth.getVersion(mod.versionId).catch(() => null);
            const file = version?.files?.find((f) => f.primary) || version?.files?.[0];
            const name = file?.filename || `${mod.versionId}.jar`;
            Demo.DEMO_MODS.push({
              filename: name,
              size: file?.size || 1024 * 1024,
              enabled: true,
              modrinthData: {
                projectId: mod.projectId,
                projectTitle: mod.projectTitle,
                clientSide: mod.clientSide || 'required',
                serverSide: mod.serverSide || 'required',
                versionNumber: mod.versionNumber || 'imported',
                iconUrl: null,
              },
            });
            report.installed.push({ title: mod.projectTitle, filename: name, versionNumber: mod.versionNumber });
            continue;
          }

          if (mod.replaceFilename) {
            try {
              await SF.deleteMod(
                ctx.config.serverPath,
                mod.replaceFilename,
                ctx.config.modsFolder,
                ctx.config.disabledModsFolder,
              );
            } catch {
              /* old file may already be gone */
            }
          }

          const version = await Modrinth.getVersion(mod.versionId);
          const file = version.files.find((f) => f.primary) || version.files[0];
          if (!file) {
            report.failed.push({ title: mod.projectTitle, error: 'No downloadable file' });
            continue;
          }
          if (!isSafeModFilename(file.filename)) {
            report.failed.push({ title: mod.projectTitle, error: 'Unsafe filename' });
            continue;
          }

          const { buffer } = await Modrinth.downloadModFile(file.url, file.filename, file.hashes?.sha1);
          await SF.saveMod(ctx.config.serverPath, file.filename, buffer, ctx.config.modsFolder);
          report.installed.push({
            title: mod.projectTitle,
            filename: file.filename,
            versionNumber: mod.versionNumber,
            size: buffer.length,
          });
        } catch (err) {
          report.failed.push({ title: mod.projectTitle || mod.versionId, error: err.message });
        }
      }

      audit('MODPACK_IMPORT', {
        user: req.session.user.email,
        installed: report.installed.length,
        failed: report.failed.length,
        ip: req.ip,
      });
      res.json(report);
    } finally {
      if (lockId != null) releaseOp(lockId);
    }
  });

  return router;
}
