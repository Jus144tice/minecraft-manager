// Mod startup status monitoring: parses Forge log output during server startup
// to track per-mod loading status (loaded, warning, error, critical).
// Reads mod IDs and display names from JAR files' META-INF/mods.toml for
// log-to-filename mapping. Buffers log lines while the map is being built.

import { readdir, stat, readFile } from 'fs/promises';
import path from 'path';
import yauzl from 'yauzl';

// ---- Mod ID extraction from JAR files ----

// Cache: cacheKey -> { modIds: [string], displayNames: [string] }
const modIdFileCache = new Map();

/**
 * Read mod IDs and display names from a JAR file's META-INF/mods.toml.
 * Returns { modIds: string[], displayNames: string[] }.
 */
function readModInfoFromJar(jarPath) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    readFile(jarPath)
      .then((buffer) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
          if (err) return done({ modIds: [], displayNames: [] });
          zipfile.readEntry();
          zipfile.on('entry', (entry) => {
            if (entry.fileName === 'META-INF/mods.toml') {
              zipfile.openReadStream(entry, (streamErr, stream) => {
                if (streamErr) {
                  zipfile.close();
                  return done({ modIds: [], displayNames: [] });
                }
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', () => {
                  const toml = Buffer.concat(chunks).toString('utf8');
                  const modIds = [...toml.matchAll(/modId\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
                  const displayNames = [...toml.matchAll(/displayName\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
                  zipfile.close();
                  done({ modIds, displayNames });
                });
              });
            } else {
              zipfile.readEntry();
            }
          });
          zipfile.on('end', () => done({ modIds: [], displayNames: [] }));
          zipfile.on('error', () => done({ modIds: [], displayNames: [] }));
        });
      })
      .catch(() => done({ modIds: [], displayNames: [] }));
  });
}

/**
 * Build a comprehensive lookup map of various source names -> filename.
 * Includes: mod IDs, display names, display names without spaces, filename stems.
 */
export async function buildModIdMap(serverPath, modsFolder = 'mods') {
  const sourceToFilename = new Map();
  const modsPath = path.join(serverPath, modsFolder);

  let entries;
  try {
    entries = await readdir(modsPath);
  } catch {
    return sourceToFilename;
  }

  for (const name of entries) {
    if (!name.endsWith('.jar')) continue;
    const fullPath = path.join(modsPath, name);
    try {
      const s = await stat(fullPath);
      const cacheKey = `${fullPath}:${s.mtimeMs}`;
      let info = modIdFileCache.get(cacheKey);
      if (!info) {
        info = await readModInfoFromJar(fullPath);
        modIdFileCache.set(cacheKey, info);
      }

      // Register mod IDs (primary key)
      for (const id of info.modIds) {
        sourceToFilename.set(id.toLowerCase(), name);
      }

      // Register display names (e.g., "Create Deco", "Railways", "FTB Quests Optimizer")
      for (const dn of info.displayNames) {
        sourceToFilename.set(dn.toLowerCase(), name);
        // Also register without spaces for fuzzy matching
        const noSpaces = dn.replace(/\s+/g, '').toLowerCase();
        if (noSpaces !== dn.toLowerCase()) sourceToFilename.set(noSpaces, name);
      }

      // Register filename stem (e.g., "geckolib" from "geckolib-forge-1.20.1-4.7.1.2.jar")
      const stem = name.replace(/[-_](?:forge|fabric|neoforge|mc|quilt).*$/i, '').replace(/\.jar$/i, '');
      if (stem.length >= 3) sourceToFilename.set(stem.toLowerCase(), name);
    } catch {
      /* skip unreadable */
    }
  }

  return sourceToFilename;
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
const SYSTEM_SOURCES = new Set([
  'minecraft',
  'mojang',
  'forge',
  'fml',
  'mixin',
  'modlauncher',
  'cpw.mods',
  'STDOUT',
  'ne.mi.co.Co.placebo', // Placebo coremod patching
  'de.ar.ne.fo.NetworkManagerImpl', // Architectury network registration
  'de.ar.re.re.fo.RegistrarManagerImpl', // Architectury registry
  'ne.mi.co.ForgeMod',
  'ne.mi.co.MinecraftForge',
  'ne.mi.fm.lo.mo.ModFileParser',
  'ne.mi.ja.se.JarSelector',
  'ne.mi.fm.lo.RuntimeDistCleaner',
  'ne.mi.co.ForgeConfigSpec',
  'mojang',
  'cp.mo.mo.Launcher',
  'cp.mo.mo.LaunchServiceHandler',
  'MixinExtras|Service',
  'de.gi.js.th.pa.SoundEventParser',
  'de.gi.js.th.pa.FluidParser',
  'de.gi.js.th.pa.BlockParser',
  'de.gi.js.th.pa.ItemParser',
  'de.gi.js.th.pa.EnchantmentParser',
  'de.gi.js.th.pa.CreativeModeTabParser',
  'de.gi.js.th.pa.FluidTypeParser',
]);

/**
 * Mod startup status parser. Processes log lines and tracks per-mod status.
 * Buffers lines while waiting for the mod ID map, then replays them.
 */
export class ModStartupParser {
  constructor() {
    this.modIdMap = new Map(); // source name -> filename (comprehensive)
    this.statuses = new Map(); // filename -> { status, messages[] }
    this._collecting = null; // { filename, messageIndex } when collecting stack trace
    this._started = false;
    this._finalized = false;
    this._mapReady = false;
    this._buffer = []; // buffered lines waiting for map
    this._onMapReady = null; // callback for broadcasting buffered results
  }

  /** Set the source-to-filename mapping and replay buffered lines. */
  setModIdMap(map, onEvent) {
    this.modIdMap = map;
    this._mapReady = true;
    this._onMapReady = onEvent || null;
    // Replay buffered lines
    const events = [];
    for (const line of this._buffer) {
      const event = this._parseLineInternal(line);
      if (event) events.push(event);
    }
    this._buffer = [];
    return events;
  }

  /** Reset all state for a new server start. */
  reset() {
    this.statuses.clear();
    this._collecting = null;
    this._started = true;
    this._finalized = false;
    this._mapReady = false;
    this._buffer = [];
  }

  /**
   * Parse a single log line. Returns a change event if status changed, or null.
   * If the map isn't ready yet, buffers the line and returns null.
   */
  parseLine(line) {
    if (!this._started || this._finalized) return null;

    if (!this._mapReady) {
      this._buffer.push(line);
      // Still check for Done pattern even while buffering
      if (DONE_PATTERN.test(line)) {
        this._buffer.push(line);
      }
      return null;
    }

    return this._parseLineInternal(line);
  }

  _parseLineInternal(line) {
    if (this._finalized) return null;

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
          return this._addMessage(filename, modId, 'critical', 'ERROR', modName, line);
        }
      }
    }

    // Stack trace continuation
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
      this._collecting = null;
    }

    // Parse structured log line
    const match = LOG_PATTERN.exec(line);
    if (!match) return null;

    const [, , level, source, text] = match;
    const sourceLower = source.toLowerCase();
    const isSystemSource = SYSTEM_SOURCES.has(source) || SYSTEM_SOURCES.has(sourceLower);

    // For system sources: only process WARN/ERROR by extracting mod refs from the message text
    if (isSystemSource) {
      if (level === 'ERROR' || level === 'FATAL' || level === 'WARN') {
        const modRef = this._extractModRefFromText(text);
        if (modRef) {
          const status = level === 'ERROR' || level === 'FATAL' ? 'error' : 'warning';
          return this._addMessage(modRef.filename, modRef.modId, status, level, source, text);
        }
      }
      return null; // system source INFO or no mod ref found
    }

    // Resolve non-system source to filename
    const resolved = this._resolveSource(source, sourceLower);
    if (!resolved) return null;

    const { filename, modId } = resolved;

    // Skip version check INFO lines (noise)
    if (source === VERSION_CHECK_SOURCE && level === 'INFO') return null;

    // Determine status level
    if (level === 'ERROR' || level === 'FATAL') {
      return this._addMessage(filename, modId, 'error', level, source, text);
    } else if (level === 'WARN') {
      return this._addMessage(filename, modId, 'warning', level, source, text);
    } else {
      // INFO — track as loaded (only if no worse status exists)
      const existing = this.statuses.get(filename);
      if (!existing) {
        this.statuses.set(filename, { status: 'loaded', messages: [] });
        return { type: 'status', filename, modId, status: 'loaded', message: null };
      }
      return null;
    }
  }

  /**
   * Try multiple strategies to map a log source to a filename.
   * Returns { filename, modId } or null.
   */
  _resolveSource(source, sourceLower) {
    // 1. Direct lookup (mod ID or display name)
    let filename = this.modIdMap.get(sourceLower);
    if (filename) return { filename, modId: sourceLower };

    // 2. Source without spaces (e.g., "Create Deco" -> "createdeco")
    const noSpaces = sourceLower.replace(/\s+/g, '');
    if (noSpaces !== sourceLower) {
      filename = this.modIdMap.get(noSpaces);
      if (filename) return { filename, modId: noSpaces };
    }

    // 3. For abbreviated class paths like "co.si.cr.Create", extract the last segment
    if (source.includes('.')) {
      const lastSegment = source.split('.').pop().toLowerCase();
      if (lastSegment && lastSegment.length >= 3) {
        filename = this.modIdMap.get(lastSegment);
        if (filename) return { filename, modId: lastSegment };
      }
    }

    // 4. Fuzzy: check if source contains a known mod ID or vice versa (min 4 chars to avoid false matches)
    for (const [knownId, knownFile] of this.modIdMap) {
      if (knownId.length < 4) continue;
      if (sourceLower.includes(knownId) || knownId.includes(sourceLower)) {
        return { filename: knownFile, modId: knownId };
      }
    }

    return null;
  }

  /**
   * Extract a mod reference from a system-sourced error/warning message.
   * Looks for patterns like:
   *   - "modid:path/to/resource" (namespace references)
   *   - "modid.mixins.json" (mixin config references)
   *   - "mod:modid" (Missing data pack references)
   */
  _extractModRefFromText(text) {
    // Pattern 1: "mod:modid" from "Missing data pack mod:modid"
    const dataPack = text.match(/Missing data pack mod:(\w+)/);
    if (dataPack) {
      const id = dataPack[1].toLowerCase();
      const filename = this.modIdMap.get(id);
      if (filename) return { filename, modId: id };
    }

    // Pattern 2: "modid.mixins.json" or "modid-common.mixins.json"
    const mixinRef = text.match(/(\w[\w-]*?)(?:[-_.](?:common|forge|client|server))?\.mixins\.json/);
    if (mixinRef) {
      const id = mixinRef[1].toLowerCase().replace(/[-_]/g, '');
      // Try with and without separators
      const filename = this.modIdMap.get(id) || this.modIdMap.get(mixinRef[1].toLowerCase());
      if (filename) return { filename, modId: mixinRef[1].toLowerCase() };
    }

    // Pattern 3: "modid:resource_path" (Minecraft namespace like "create:crushed_ores")
    const nsRef = text.match(/\b([a-z_][\w-]*):[\w/.-]+/);
    if (nsRef && nsRef[1] !== 'minecraft' && nsRef[1] !== 'forge' && nsRef[1] !== 'java' && nsRef[1] !== 'net') {
      const id = nsRef[1].toLowerCase();
      const filename = this.modIdMap.get(id);
      if (filename) return { filename, modId: id };
    }

    // Pattern 4: "modid.refmap.json" (reference map files)
    const refmapRef = text.match(/(\w[\w-]*?)(?:[-.].*)?\.refmap\.json/);
    if (refmapRef) {
      const id = refmapRef[1].toLowerCase();
      const filename = this.modIdMap.get(id);
      if (filename) return { filename, modId: id };
    }

    return null;
  }

  _addMessage(filename, modId, status, level, source, text) {
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
   * Finalize: mark all mapped mods as "loaded" if they weren't seen in logs.
   * Mods not in the modIdMap (e.g., missing mods.toml) are left without status
   * so they can be investigated.
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
