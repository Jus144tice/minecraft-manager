// Modpack routes: export current mods as a shareable manifest, import from manifest.
// Supports both JSON manifests and .mrpack (Modrinth modpack) archives.
// Uses Modrinth hashes to identify mods and resolve versions for download.

import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import * as SF from '../serverFiles.js';
import * as Modrinth from '../modrinth.js';
import * as Demo from '../demoData.js';
import * as Mrpack from '../mrpack.js';
import { audit } from '../audit.js';
import { isSafeModFilename, isSafeMrpackFilename } from '../validate.js';
import { acquireOp, releaseOp } from '../operationLock.js';
import { requireCapability } from '../middleware.js';

// In-memory cache for analyzed .mrpack files (token → { data, expiresAt })
const mrpackCache = new Map();
const MRPACK_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function cacheMrpack(data) {
  // Prune expired entries
  const now = Date.now();
  for (const [key, entry] of mrpackCache) {
    if (entry.expiresAt < now) mrpackCache.delete(key);
  }
  // Limit cache size
  if (mrpackCache.size >= 10) {
    const oldest = [...mrpackCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) mrpackCache.delete(oldest[0]);
  }
  const token = crypto.randomBytes(16).toString('hex');
  mrpackCache.set(token, { data, expiresAt: now + MRPACK_CACHE_TTL });
  return token;
}

function getCachedMrpack(token) {
  const entry = mrpackCache.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    mrpackCache.delete(token);
    return null;
  }
  return entry.data;
}

// Raw body parser for .mrpack uploads (ZIP binary)
const rawBodyParser = express.raw({ type: 'application/octet-stream', limit: '500mb' });

export default function modpackRoutes(ctx) {
  const router = Router();

  // ============================================================
  // Existing JSON modpack routes
  // ============================================================

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

  router.post('/modpack/import', requireCapability('server.manage_mods'), async (req, res) => {
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

  // ============================================================
  // .mrpack routes
  // ============================================================

  /**
   * POST /modpack/mrpack/analyze
   * Upload a .mrpack file as raw bytes for analysis.
   * Returns classification, pack metadata, and a cache token for subsequent import.
   */
  router.post('/modpack/mrpack/analyze', rawBodyParser, async (req, res) => {
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Expected .mrpack file as request body (application/octet-stream)' });
    }

    try {
      const { index, overridePaths, serverOverridePaths } = await Mrpack.parseMrpack(req.body);

      const errors = Mrpack.validateIndex(index);
      if (errors.length > 0) {
        return res.status(400).json({ error: 'Invalid .mrpack manifest', details: errors });
      }

      const deps = Mrpack.extractDependencies(index);
      const classification = Mrpack.analyzeForServer(index);

      // Cache the raw buffer + parsed data for import
      const token = cacheMrpack({ buffer: req.body, index });

      res.json({
        token,
        name: index.name,
        versionId: index.versionId,
        summary: index.summary || null,
        minecraftVersion: deps.minecraftVersion,
        loader: deps.loader,
        loaderVersion: deps.loaderVersion,
        totalFiles: (index.files || []).length,
        classification: {
          server: classification.server.map(briefEntry),
          both: classification.both.map(briefEntry),
          client: classification.client.map(briefEntry),
          unknown: classification.unknown.map(briefEntry),
        },
        overrideCount: overridePaths.length,
        serverOverrideCount: serverOverridePaths.length,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * POST /modpack/mrpack/import
   * Import mods from a previously analyzed .mrpack.
   * Body: { token, includeOverrides, unknownAction: "install"|"skip", selectedPaths?: string[] }
   *
   * Returns { jobId } immediately. Downloads run in the background with progress
   * broadcast over WebSocket (mrpack-progress / mrpack-complete messages).
   * In demo mode, returns { jobId, report } synchronously for instant feedback.
   */
  router.post('/modpack/mrpack/import', requireCapability('server.manage_mods'), async (req, res) => {
    const { token, includeOverrides = false, unknownAction = 'skip', selectedPaths } = req.body;

    if (!token) return res.status(400).json({ error: 'Missing analysis token' });

    const cached = getCachedMrpack(token);
    if (!cached) return res.status(410).json({ error: 'Analysis expired. Please re-upload the .mrpack file.' });

    // Clean up cache entry — single use
    mrpackCache.delete(token);

    const jobId = crypto.randomBytes(16).toString('hex');
    const auditInfo = { user: req.session.user.email, pack: cached.index.name, ip: req.ip };

    // Demo mode: run synchronously and return report inline
    if (ctx.config.demoMode) {
      const report = runMrpackImportSync(cached, { unknownAction, selectedPaths, includeOverrides });
      audit('MRPACK_IMPORT', { ...auditInfo, ...reportSummary(report) });
      return res.json({ jobId, report });
    }

    let lockId;
    try {
      lockId = acquireOp('mrpack import', ['files']);
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }

    // Return immediately — downloads happen in background
    res.json({ jobId });

    runMrpackImportAsync(
      jobId,
      cached,
      { unknownAction, selectedPaths, includeOverrides },
      ctx,
      lockId,
      auditInfo,
    ).catch((err) => {
      ctx.broadcast({ type: 'mrpack-complete', jobId, report: null, error: err.message });
      if (lockId != null) releaseOp(lockId);
    });
  });

  /**
   * GET /modpack/mrpack/export
   * Export current mods as a .mrpack archive.
   * Query params:
   *   include - comma-separated categories: server,both,client,unknown (default: server,both)
   *   overrides - "true" to include server.properties in server-overrides/ (default: false)
   */
  router.get('/modpack/mrpack/export', async (req, res) => {
    const includeParam = req.query.include || 'server,both';
    const includeCategories = new Set(includeParam.split(',').map((s) => s.trim()));
    const includeOverrides = req.query.overrides === 'true';

    try {
      // Hash all mods and look up on Modrinth
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

      // Get version details for download URLs (batch fetch for efficiency)
      const versionIds = [
        ...new Set(
          Object.values(modrinthLookup)
            .map((mr) => mr.versionId)
            .filter(Boolean),
        ),
      ];
      let versionDetails = {};
      if (!ctx.config.demoMode && versionIds.length > 0) {
        const versions = await Modrinth.getVersionsBatch(versionIds);
        for (const v of versions) versionDetails[v.id] = v;
      }

      const files = [];
      const excluded = [];
      const unmanaged = [];

      for (const [filename, { hash, enabled }] of Object.entries(hashMap)) {
        const mr = modrinthLookup[hash];
        if (!mr) {
          unmanaged.push({ filename, reason: 'Not identified on Modrinth — cannot represent in .mrpack' });
          continue;
        }

        const env = Mrpack.sideToEnv(mr.clientSide, mr.serverSide);
        const category = Mrpack.classifyEntry({ env });

        if (!includeCategories.has(category)) {
          excluded.push({ filename, category, title: mr.projectTitle });
          continue;
        }

        // Get download URL and sha512 from version data
        const version = versionDetails[mr.versionId];
        const vFile = version?.files?.find((f) => f.hashes?.sha1 === hash) || version?.files?.[0];
        const downloadUrl = vFile?.url;
        const sha512 = vFile?.hashes?.sha512 || null;

        if (!downloadUrl && !ctx.config.demoMode) {
          unmanaged.push({ filename, reason: 'No download URL available' });
          continue;
        }

        // Compute sha512 if not available from Modrinth
        let fileSha512 = sha512;
        if (!fileSha512 && !ctx.config.demoMode) {
          try {
            fileSha512 = await SF.hashFileSha512(
              path.join(
                ctx.config.serverPath,
                enabled ? ctx.config.modsFolder : ctx.config.disabledModsFolder,
                filename,
              ),
            );
          } catch {
            /* non-critical */
          }
        }

        files.push({
          path: `mods/${filename}`,
          hashes: { sha1: hash, ...(fileSha512 ? { sha512: fileSha512 } : {}) },
          downloads: downloadUrl ? [downloadUrl] : [],
          fileSize: vFile?.size || 0,
          env,
        });
      }

      // Build dependencies
      const mcVersion = ctx.config.minecraftVersion || 'unknown';
      const dependencies = { minecraft: mcVersion };
      // Add loader if known from config (default to forge)
      const loaderKey = ctx.config.loader || 'forge';
      if (ctx.config.loaderVersion) {
        dependencies[loaderKey] = ctx.config.loaderVersion;
      }

      // Optionally add server.properties as override
      const overrides = [];
      if (includeOverrides && !ctx.config.demoMode) {
        try {
          const { readFile } = await import('fs/promises');
          const propsPath = path.join(ctx.config.serverPath, 'server.properties');
          const buf = await readFile(propsPath);
          overrides.push({ relativePath: 'server.properties', buffer: buf });
        } catch {
          /* server.properties may not exist */
        }
      }

      const packName = `${mcVersion} Server Modpack`;
      const mrpackBuffer = await Mrpack.buildMrpack({
        name: packName,
        versionId: `export-${Date.now()}`,
        dependencies,
        files,
        overrides,
      });

      const warnings = [];
      if (unmanaged.length > 0) {
        warnings.push(`${unmanaged.length} mod(s) could not be included (not on Modrinth or no download URL)`);
      }
      if (includeCategories.has('client') || includeCategories.has('unknown')) {
        warnings.push('This export may include content not suitable for all environments');
      }

      audit('MRPACK_EXPORT', {
        user: req.session.user.email,
        included: files.length,
        excluded: excluded.length,
        unmanaged: unmanaged.length,
        categories: [...includeCategories],
        ip: req.ip,
      });

      // If requesting JSON summary, return it; otherwise send the file
      if (req.query.summary === 'true') {
        return res.json({
          name: packName,
          included: files.length,
          excluded,
          unmanaged,
          warnings,
          categories: [...includeCategories],
        });
      }

      const safePackName = packName.replace(/[^a-zA-Z0-9._-]/g, '_');
      res.set('Content-Type', 'application/x-modrinth-modpack+zip');
      res.set('Content-Disposition', `attachment; filename="${safePackName}.mrpack"`);
      res.send(mrpackBuffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ============================================================
// Mrpack import helpers (shared between sync demo and async real)
// ============================================================

function reportSummary(report) {
  return {
    installed: report.installed.length,
    failed: report.failed.length,
    skipped: report.skipped.length,
    overrides: report.overridesApplied,
  };
}

function classifyFiles(cached, { unknownAction, selectedPaths }) {
  const classification = Mrpack.analyzeForServer(cached.index);
  const toInstall = [...classification.server, ...classification.both];
  const report = { installed: [], failed: [], skipped: [], overridesApplied: 0, warnings: [] };

  for (const file of classification.unknown) {
    if (unknownAction === 'install') {
      toInstall.push(file);
    } else if (selectedPaths && selectedPaths.includes(file.path)) {
      toInstall.push(file);
    } else {
      report.skipped.push({ path: file.path, reason: 'Unknown environment — skipped by policy' });
    }
  }
  for (const file of classification.client) {
    report.skipped.push({ path: file.path, reason: 'Client-only — not needed on server' });
  }

  return { toInstall, report };
}

/** Demo mode: run synchronously, no downloads */
function runMrpackImportSync(cached, options) {
  const { toInstall, report } = classifyFiles(cached, options);
  for (const file of toInstall) {
    report.installed.push({
      path: file.path,
      filename: path.basename(file.path),
      size: file.fileSize || 0,
      classification: file._classification || 'unknown',
    });
  }
  return report;
}

/** Production: download mods in background, broadcast progress over WebSocket */
async function runMrpackImportAsync(jobId, cached, options, ctx, lockId, auditInfo) {
  const { toInstall, report } = classifyFiles(cached, options);
  const total = toInstall.length;

  try {
    for (let i = 0; i < toInstall.length; i++) {
      const file = toInstall[i];
      const filename = path.basename(file.path);

      ctx.broadcast({ type: 'mrpack-progress', jobId, current: i + 1, total, filename });

      if (!isSafeMrpackFilename(filename)) {
        report.failed.push({ path: file.path, error: 'Unsafe filename' });
        continue;
      }

      const url = file.downloads?.[0];
      if (!url) {
        report.failed.push({ path: file.path, error: 'No download URL' });
        continue;
      }

      try {
        const expectedSha1 = file.hashes?.sha1;
        const { buffer } = await Modrinth.downloadModFile(url, filename, expectedSha1);

        if (file.hashes?.sha512) {
          const actual = crypto.createHash('sha512').update(buffer).digest('hex');
          if (actual !== file.hashes.sha512) {
            report.failed.push({ path: file.path, error: 'SHA-512 hash mismatch' });
            continue;
          }
        }

        await SF.saveMod(ctx.config.serverPath, filename, buffer, ctx.config.modsFolder);
        report.installed.push({
          path: file.path,
          filename,
          size: buffer.length,
          classification: file._classification || 'unknown',
        });
      } catch (err) {
        report.failed.push({ path: file.path, error: err.message });
      }
    }

    // Extract overrides if requested
    if (options.includeOverrides) {
      try {
        const overrides = await Mrpack.extractOverrides(cached.buffer, ctx.config.serverPath);
        for (const entry of overrides) {
          try {
            await SF.writeOverrideFile(ctx.config.serverPath, entry.relativePath, entry.buffer);
            report.overridesApplied++;
          } catch (err) {
            report.warnings.push(`Override ${entry.relativePath}: ${err.message}`);
          }
        }
      } catch (err) {
        report.warnings.push(`Override extraction failed: ${err.message}`);
      }
    }

    audit('MRPACK_IMPORT', { ...auditInfo, ...reportSummary(report) });
    ctx.broadcast({ type: 'mrpack-complete', jobId, report });
  } finally {
    if (lockId != null) releaseOp(lockId);
  }
}

/** Extract a brief summary of a file entry for the analysis response. */
function briefEntry(file) {
  return {
    path: file.path,
    fileSize: file.fileSize || 0,
    env: file.env || null,
    classification: file._classification,
    downloads: file.downloads?.length || 0,
  };
}
