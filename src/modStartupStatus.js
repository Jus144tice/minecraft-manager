// Mod startup status monitoring: parses Forge log output during server startup
// to track per-mod loading status (loaded, warning, error, critical).
// Reads mod IDs from JAR files' META-INF/mods.toml for log-to-filename mapping.

import { readdir, stat, readFile } from 'fs/promises';
import path from 'path';
import yauzl from 'yauzl';

// ---- Mod ID extraction from JAR files ----

// Cache: filename+mtimeMs -> [modId, ...]
const modIdFileCache = new Map();

/**
 * Read mod IDs from a JAR file's META-INF/mods.toml.
 * Returns array of mod IDs declared in the JAR.
 */
function readModIdsFromJar(jarPath) {
  return new Promise((resolve) => {
    readFile(jarPath)
      .then((buffer) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
          if (err) return resolve([]);
          const modIds = [];
          zipfile.readEntry();
          zipfile.on('entry', (entry) => {
            if (entry.fileName === 'META-INF/mods.toml') {
              zipfile.openReadStream(entry, (streamErr, stream) => {
                if (streamErr) {
                  zipfile.close();
                  return resolve([]);
                }
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', () => {
                  const toml = Buffer.concat(chunks).toString('utf8');
                  // Extract modId values from [[mods]] sections
                  const matches = toml.matchAll(/modId\s*=\s*"([^"]+)"/g);
                  for (const m of matches) modIds.push(m[1]);
                  zipfile.close();
                  resolve(modIds);
                });
              });
            } else {
              zipfile.readEntry();
            }
          });
          zipfile.on('end', () => resolve(modIds));
        });
      })
      .catch(() => resolve([]));
  });
}

/**
 * Build a mapping of modId -> filename for all JARs in the mods folder.
 * Uses a file-level cache keyed by filename + mtime to avoid re-reading unchanged JARs.
 */
export async function buildModIdMap(serverPath, modsFolder = 'mods') {
  const modIdToFilename = new Map();
  const modsPath = path.join(serverPath, modsFolder);

  let entries;
  try {
    entries = await readdir(modsPath);
  } catch {
    return modIdToFilename;
  }

  for (const name of entries) {
    if (!name.endsWith('.jar')) continue;
    const fullPath = path.join(modsPath, name);
    try {
      const s = await stat(fullPath);
      const cacheKey = `${fullPath}:${s.mtimeMs}`;
      let modIds = modIdFileCache.get(cacheKey);
      if (!modIds) {
        modIds = await readModIdsFromJar(fullPath);
        modIdFileCache.set(cacheKey, modIds);
      }
      for (const id of modIds) {
        modIdToFilename.set(id.toLowerCase(), name);
      }
    } catch {
      /* skip unreadable */
    }
  }

  return modIdToFilename;
}

// ---- Log Parser ----

// Forge log line pattern: [HH:MM:SS] [thread/LEVEL] [source/category]: message
const LOG_PATTERN = /^\[[\d:]+\]\s+\[([^/]+)\/(INFO|WARN|ERROR|FATAL)\]\s+\[([^/\]]+)(?:\/[^\]]*)\]:\s*(.*)$/;

// LoadingFailedException — critical mod failure
const CRITICAL_PATTERN = /(?:LoadingFailedException|has failed to load correctly)/;
const CRITICAL_MOD_PATTERN = /(\w[\w.-]+)\s+\((\w+)\)\s+has failed to load/;

// "Done (Xs)!" — server finished starting
const DONE_PATTERN = /Done\s+\(\d+[\d.]*s\)!/;

// Stack trace continuation lines
const STACK_TRACE_PATTERN = /^\s+at\s|^\s*Caused by:|^\s+\.\.\.\s+\d+\s+more/;

// Forge version check source (lower priority)
const VERSION_CHECK_SOURCE = 'ne.mi.fm.VersionChecker';

// Known non-mod sources to ignore for status tracking
const SYSTEM_SOURCES = new Set(['minecraft', 'mojang', 'forge', 'fml', 'mixin', 'modlauncher', 'cpw.mods', 'STDOUT']);

/**
 * Mod startup status parser. Processes log lines and tracks per-mod status.
 */
export class ModStartupParser {
  constructor() {
    this.modIdMap = new Map(); // modId -> filename
    this.statuses = new Map(); // filename -> { status, messages[] }
    this._collecting = null; // { filename, messageIndex } when collecting stack trace
    this._started = false;
    this._finalized = false;
  }

  /** Set the modId-to-filename mapping (call before parsing begins). */
  setModIdMap(map) {
    this.modIdMap = map;
  }

  /** Reset all state for a new server start. */
  reset() {
    this.statuses.clear();
    this._collecting = null;
    this._started = true;
    this._finalized = false;
  }

  /**
   * Parse a single log line. Returns a change event if status changed, or null.
   * Change event: { filename, modId, status, message }
   */
  parseLine(line) {
    if (!this._started || this._finalized) return null;

    // Check for server done
    if (DONE_PATTERN.test(line)) {
      this._finalized = true;
      return { type: 'complete' };
    }

    // Check for critical failure (LoadingFailedException)
    if (CRITICAL_PATTERN.test(line)) {
      const modMatch = CRITICAL_MOD_PATTERN.exec(line);
      if (modMatch) {
        const modName = modMatch[1];
        const modId = modMatch[2].toLowerCase();
        const filename = this.modIdMap.get(modId);
        if (filename) {
          return this._addMessage(filename, modId, 'critical', 'ERROR', modName, line, null);
        }
      }
    }

    // Stack trace continuation: lines that are part of a stack trace or exception
    // (whitespace-prefixed, \tat, Caused by:, or any non-log-pattern line while collecting)
    if (this._collecting) {
      const isStackLine = STACK_TRACE_PATTERN.test(line) || /^\s/.test(line);
      const isLogLine = LOG_PATTERN.test(line);
      if (isStackLine || !isLogLine) {
        const entry = this.statuses.get(this._collecting.filename);
        if (entry) {
          const msg = entry.messages[this._collecting.messageIndex];
          if (msg) {
            if (!msg.stackTrace) msg.stackTrace = [];
            msg.stackTrace.push(line);
          }
        }
        return null;
      }
      // It's a new log line — stop collecting
      this._collecting = null;
    }

    // Parse structured log line
    const match = LOG_PATTERN.exec(line);
    if (!match) return null;

    const [, , level, source, text] = match;

    // Skip system/non-mod sources
    const sourceLower = source.toLowerCase();
    if (SYSTEM_SOURCES.has(sourceLower)) return null;

    // Try to map source to a filename
    // Source can be a mod ID, a class path prefix, or a mod name
    let filename = this.modIdMap.get(sourceLower);
    let modId = sourceLower;

    // If direct lookup failed, try fuzzy matching against known mod IDs
    if (!filename) {
      for (const [knownId, knownFile] of this.modIdMap) {
        if (sourceLower.includes(knownId) || knownId.includes(sourceLower)) {
          filename = knownFile;
          modId = knownId;
          break;
        }
      }
    }

    if (!filename) return null; // unmapped source, skip

    // Skip version check INFO lines (noise)
    if (source === VERSION_CHECK_SOURCE && level === 'INFO') return null;

    // Determine status level
    let status;
    if (level === 'ERROR' || level === 'FATAL') {
      status = 'error';
    } else if (level === 'WARN') {
      status = 'warning';
      // Version check warnings are lower priority
      if (source === VERSION_CHECK_SOURCE) status = 'warning';
    } else {
      // INFO — track as loaded (only if no worse status exists)
      const existing = this.statuses.get(filename);
      if (!existing) {
        this.statuses.set(filename, { status: 'loaded', messages: [] });
        return { type: 'status', filename, modId, status: 'loaded', message: null };
      }
      return null; // already tracked, INFO doesn't change status
    }

    return this._addMessage(filename, modId, status, level, source, text, line);
  }

  _addMessage(filename, modId, status, level, source, text, _rawLine) {
    let entry = this.statuses.get(filename);
    if (!entry) {
      entry = { status: 'loaded', messages: [] };
      this.statuses.set(filename, entry);
    }

    // Only escalate status, never downgrade
    const priority = { loaded: 0, warning: 1, error: 2, critical: 3 };
    if (priority[status] > priority[entry.status]) {
      entry.status = status;
    }

    const message = { level, source, text, stackTrace: null };
    entry.messages.push(message);

    // Start collecting stack trace for WARN/ERROR lines
    if (level === 'WARN' || level === 'ERROR' || level === 'FATAL') {
      this._collecting = { filename, messageIndex: entry.messages.length - 1 };
    }

    return { type: 'status', filename, modId, status: entry.status, message };
  }

  /**
   * Finalize: mark all unmapped mods as "loaded" (they loaded silently).
   * Call when server "Done!" is detected.
   */
  finalize() {
    this._finalized = true;
    for (const [, filename] of this.modIdMap) {
      if (!this.statuses.has(filename)) {
        this.statuses.set(filename, { status: 'loaded', messages: [] });
      }
    }
  }

  /** Get the full status map keyed by filename. */
  getStatuses() {
    const result = {};
    for (const [filename, entry] of this.statuses) {
      result[filename] = { status: entry.status, messages: entry.messages };
    }
    return result;
  }

  /** Get status for a specific filename. */
  getStatusForFile(filename) {
    return this.statuses.get(filename) || null;
  }
}
