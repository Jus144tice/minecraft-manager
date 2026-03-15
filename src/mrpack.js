// .mrpack (Modrinth modpack) parsing, validation, classification, and building.
// The mrpack format is a ZIP archive containing modrinth.index.json plus override directories.
// This module provides pure functions — no Express dependencies.

import yauzl from 'yauzl';
import yazl from 'yazl';
import { safeJoin } from './pathUtils.js';

// ============================================================
// Constants
// ============================================================

const MAX_MRPACK_SIZE = 500 * 1024 * 1024; // 500 MB
const MAX_ENTRY_COUNT = 10_000;
const VALID_ENV_VALUES = ['required', 'optional', 'unsupported'];

// ============================================================
// Classification
// ============================================================

/**
 * Classify a single file entry as client, server, both, or unknown.
 * Uses the env field from modrinth.index.json: { client, server } where values
 * are "required", "optional", or "unsupported".
 *
 * @param {{ env?: { client?: string, server?: string } }} fileEntry
 * @returns {'client' | 'server' | 'both' | 'unknown'}
 */
export function classifyEntry(fileEntry) {
  const env = fileEntry?.env;
  if (!env) return 'unknown';

  const client = env.client;
  const server = env.server;

  // If either side is explicitly unsupported, the entry is for the other side only
  if (server === 'unsupported') return 'client';
  if (client === 'unsupported') return 'server';

  // Both sides have some level of support
  if ((server === 'required' || server === 'optional') && (client === 'required' || client === 'optional')) {
    return 'both';
  }

  return 'unknown';
}

/**
 * Map Modrinth project-level side fields to mrpack env format.
 * Modrinth projects use client_side/server_side with the same value set.
 */
export function sideToEnv(clientSide, serverSide) {
  return {
    client: VALID_ENV_VALUES.includes(clientSide) ? clientSide : 'optional',
    server: VALID_ENV_VALUES.includes(serverSide) ? serverSide : 'optional',
  };
}

// ============================================================
// Validation
// ============================================================

/**
 * Validate a modrinth.index.json structure.
 * Returns an array of error strings (empty = valid).
 *
 * @param {object} index
 * @returns {string[]}
 */
export function validateIndex(index) {
  const errors = [];

  if (!index || typeof index !== 'object') {
    return ['Index must be a JSON object'];
  }

  if (index.formatVersion !== 1) {
    errors.push(`Unsupported formatVersion: ${index.formatVersion} (expected 1)`);
  }
  if (index.game !== 'minecraft') {
    errors.push(`Unsupported game: ${index.game} (expected "minecraft")`);
  }
  if (!index.name || typeof index.name !== 'string') {
    errors.push('Missing or invalid "name" field');
  }
  if (!index.versionId || typeof index.versionId !== 'string') {
    errors.push('Missing or invalid "versionId" field');
  }
  if (!Array.isArray(index.files)) {
    errors.push('Missing or invalid "files" array');
  } else {
    for (let i = 0; i < index.files.length; i++) {
      const f = index.files[i];
      if (!f.path || typeof f.path !== 'string') {
        errors.push(`files[${i}]: missing or invalid "path"`);
      }
      if (!f.hashes || typeof f.hashes !== 'object') {
        errors.push(`files[${i}]: missing "hashes" object`);
      } else if (!f.hashes.sha1 && !f.hashes.sha512) {
        errors.push(`files[${i}]: hashes must include sha1 or sha512`);
      }
      if (!Array.isArray(f.downloads) || f.downloads.length === 0) {
        errors.push(`files[${i}]: missing or empty "downloads" array`);
      } else {
        for (const url of f.downloads) {
          try {
            const parsed = new URL(url);
            if (!['https:', 'http:'].includes(parsed.protocol)) {
              errors.push(`files[${i}]: download URL has invalid protocol: ${parsed.protocol}`);
            }
          } catch {
            errors.push(`files[${i}]: invalid download URL: ${url}`);
          }
        }
      }
      if (f.env) {
        if (f.env.client && !VALID_ENV_VALUES.includes(f.env.client)) {
          errors.push(`files[${i}]: invalid env.client value: ${f.env.client}`);
        }
        if (f.env.server && !VALID_ENV_VALUES.includes(f.env.server)) {
          errors.push(`files[${i}]: invalid env.server value: ${f.env.server}`);
        }
      }
    }
  }

  if (!index.dependencies || typeof index.dependencies !== 'object') {
    errors.push('Missing "dependencies" object');
  }

  return errors;
}

/**
 * Extract Minecraft version and loader info from index dependencies.
 */
export function extractDependencies(index) {
  const deps = index?.dependencies || {};
  const result = { minecraftVersion: deps.minecraft || null, loader: null, loaderVersion: null };

  const loaderKeys = {
    forge: 'forge',
    neoforge: 'neoforge',
    'fabric-loader': 'fabric',
    'quilt-loader': 'quilt',
  };

  for (const [key, name] of Object.entries(loaderKeys)) {
    if (deps[key]) {
      result.loader = name;
      result.loaderVersion = deps[key];
      break;
    }
  }

  return result;
}

// ============================================================
// Analysis
// ============================================================

/**
 * Partition all file entries into server/client/both/unknown categories.
 *
 * @param {object} index - Parsed modrinth.index.json
 * @returns {{ server: object[], client: object[], both: object[], unknown: object[] }}
 */
export function analyzeForServer(index) {
  const result = { server: [], client: [], both: [], unknown: [] };

  for (const file of index.files || []) {
    const cat = classifyEntry(file);
    result[cat].push({ ...file, _classification: cat });
  }

  return result;
}

// ============================================================
// Parsing
// ============================================================

/**
 * Validate an override entry path is safe (no traversal, no absolute, no null bytes).
 */
export function isSafeOverridePath(relativePath) {
  if (typeof relativePath !== 'string') return false;
  if (relativePath.length === 0 || relativePath.length > 500) return false;
  if (relativePath.includes('\0')) return false;
  if (relativePath.includes('\\')) return false;
  if (relativePath.startsWith('/')) return false;
  if (relativePath.includes('..')) return false;
  return true;
}

/**
 * Parse a .mrpack ZIP buffer.
 * Extracts modrinth.index.json and catalogs override entries.
 * Does NOT extract override file contents (use extractOverrides for that).
 *
 * @param {Buffer} buffer - The .mrpack file contents
 * @returns {Promise<{ index: object, overridePaths: string[], serverOverridePaths: string[] }>}
 */
export function parseMrpack(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return Promise.reject(new Error('Expected a Buffer'));
  }
  if (buffer.length > MAX_MRPACK_SIZE) {
    return Promise.reject(
      new Error(
        `File too large: ${(buffer.length / 1024 / 1024).toFixed(1)} MB (max ${MAX_MRPACK_SIZE / 1024 / 1024} MB)`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(new Error(`Invalid ZIP archive: ${err.message}`));

      let index = null;
      const overridePaths = [];
      const serverOverridePaths = [];
      let entryCount = 0;

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        entryCount++;
        if (entryCount > MAX_ENTRY_COUNT) {
          zipfile.close();
          return reject(new Error(`Too many entries in archive (max ${MAX_ENTRY_COUNT})`));
        }

        const name = entry.fileName;

        if (name === 'modrinth.index.json') {
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2) return reject(err2);
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => {
              try {
                index = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch (e) {
                return reject(new Error(`Invalid JSON in modrinth.index.json: ${e.message}`));
              }
              zipfile.readEntry();
            });
            stream.on('error', reject);
          });
          return;
        }

        // Catalog override paths (skip directory entries)
        if (!name.endsWith('/')) {
          if (name.startsWith('overrides/')) {
            const rel = name.slice('overrides/'.length);
            if (isSafeOverridePath(rel)) overridePaths.push(rel);
          } else if (name.startsWith('server-overrides/')) {
            const rel = name.slice('server-overrides/'.length);
            if (isSafeOverridePath(rel)) serverOverridePaths.push(rel);
          }
          // client-overrides/ intentionally skipped — this is a server app
        }

        zipfile.readEntry();
      });

      zipfile.on('end', () => {
        if (!index) return reject(new Error('Missing modrinth.index.json in .mrpack archive'));
        resolve({ index, overridePaths, serverOverridePaths });
      });
      zipfile.on('error', reject);
    });
  });
}

/**
 * Extract override files from a .mrpack ZIP buffer for server installation.
 * Extracts from overrides/ and server-overrides/ (not client-overrides/).
 * Each entry path is validated for safety.
 *
 * @param {Buffer} buffer - The .mrpack file contents
 * @param {string} serverPath - Target server directory (for safeJoin validation)
 * @returns {Promise<Array<{ relativePath: string, buffer: Buffer }>>}
 */
export function extractOverrides(buffer, serverPath) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(new Error(`Invalid ZIP archive: ${err.message}`));

      const files = [];
      const pending = [];

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const name = entry.fileName;

        // Only extract overrides/ and server-overrides/ (not client-overrides/)
        let relativePath = null;
        if (name.startsWith('overrides/') && !name.endsWith('/')) {
          relativePath = name.slice('overrides/'.length);
        } else if (name.startsWith('server-overrides/') && !name.endsWith('/')) {
          relativePath = name.slice('server-overrides/'.length);
        }

        if (relativePath && isSafeOverridePath(relativePath)) {
          // Validate it won't escape serverPath
          try {
            safeJoin(serverPath, relativePath);
          } catch {
            // Skip unsafe paths silently
            zipfile.readEntry();
            return;
          }

          const p = new Promise((res, rej) => {
            zipfile.openReadStream(entry, (err2, stream) => {
              if (err2) return rej(err2);
              const chunks = [];
              stream.on('data', (c) => chunks.push(c));
              stream.on('end', () => {
                files.push({ relativePath, buffer: Buffer.concat(chunks) });
                res();
              });
              stream.on('error', rej);
            });
          });
          pending.push(p);
          // Wait for stream to finish before reading next entry
          p.then(() => zipfile.readEntry()).catch(reject);
          return;
        }

        zipfile.readEntry();
      });

      zipfile.on('end', () => {
        Promise.all(pending)
          .then(() => resolve(files))
          .catch(reject);
      });
      zipfile.on('error', reject);
    });
  });
}

// ============================================================
// Building
// ============================================================

/**
 * Build a .mrpack ZIP buffer from the given components.
 *
 * @param {object} opts
 * @param {string} opts.name - Pack name
 * @param {string} opts.versionId - Pack version string
 * @param {object} opts.dependencies - { minecraft: "1.20.1", forge: "47.2.0", ... }
 * @param {Array} opts.files - Array of { path, hashes, downloads, fileSize, env }
 * @param {Array} [opts.overrides] - Array of { relativePath, buffer } for server-overrides/
 * @returns {Promise<Buffer>}
 */
export function buildMrpack({ name, versionId, dependencies, files, overrides }) {
  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();

    // Build modrinth.index.json
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: versionId || '1.0.0',
      name: name || 'Server Modpack',
      files: files.map((f) => ({
        path: f.path,
        hashes: f.hashes,
        downloads: f.downloads,
        fileSize: f.fileSize,
        ...(f.env ? { env: f.env } : {}),
      })),
      dependencies: dependencies || {},
    };

    zipfile.addBuffer(Buffer.from(JSON.stringify(index, null, 2), 'utf8'), 'modrinth.index.json');

    // Add server-overrides
    if (overrides && overrides.length > 0) {
      for (const entry of overrides) {
        if (isSafeOverridePath(entry.relativePath)) {
          zipfile.addBuffer(entry.buffer, `server-overrides/${entry.relativePath}`);
        }
      }
    }

    zipfile.end();

    const chunks = [];
    zipfile.outputStream.on('data', (c) => chunks.push(c));
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.outputStream.on('error', reject);
  });
}
