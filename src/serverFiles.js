// Read/write Minecraft server data files: ops.json, whitelist.json,
// banned-players.json, banned-ips.json, server.properties, and mods folder.
// All file operations that accept user-influenced filenames use safeJoin to
// prevent path traversal attacks.

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createReadStream } from 'fs';
import { safeJoin } from './pathUtils.js';

// --- SHA1 hash cache (avoids re-hashing unchanged files) ---
// Key: filePath, Value: { mtimeMs, size, hash }
const hashCache = new Map();

async function hashFileCached(filePath) {
  const stat = await fs.stat(filePath);
  const cached = hashCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.hash;
  }
  const hash = await hashFile(filePath);
  hashCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

// --- JSON data files ---

async function readJson(filePath, fallback = []) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function getOps(serverPath) {
  return readJson(path.join(serverPath, 'ops.json'));
}

export async function setOps(serverPath, ops) {
  await writeJson(path.join(serverPath, 'ops.json'), ops);
}

export async function getWhitelist(serverPath) {
  return readJson(path.join(serverPath, 'whitelist.json'));
}

export async function setWhitelist(serverPath, list) {
  await writeJson(path.join(serverPath, 'whitelist.json'), list);
}

export async function getUsercache(serverPath) {
  return readJson(path.join(serverPath, 'usercache.json'));
}

export async function getBannedPlayers(serverPath) {
  return readJson(path.join(serverPath, 'banned-players.json'));
}

export async function setBannedPlayers(serverPath, list) {
  await writeJson(path.join(serverPath, 'banned-players.json'), list);
}

export async function getBannedIps(serverPath) {
  return readJson(path.join(serverPath, 'banned-ips.json'));
}

// --- server.properties ---

export async function getServerProperties(serverPath) {
  const filePath = path.join(serverPath, 'server.properties');
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const props = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      props[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return props;
  } catch {
    return {};
  }
}

export async function setServerProperties(serverPath, props) {
  const filePath = path.join(serverPath, 'server.properties');
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch {
    /* ok */
  }

  const lines = existing.split('\n');
  const handled = new Set();
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq);
    if (key in props) {
      handled.add(key);
      return `${key}=${props[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(props)) {
    if (!handled.has(k)) updated.push(`${k}=${v}`);
  }

  await fs.writeFile(filePath, updated.join('\n'), 'utf8');
}

// --- Simple Voice Chat config ---

const VOICECHAT_CONFIG = path.join('config', 'voicechat', 'voicechat-server.properties');

export async function getVoicechatProperties(serverPath) {
  const filePath = path.join(serverPath, VOICECHAT_CONFIG);
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const props = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      props[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return props;
  } catch (err) {
    if (err.code === 'ENOENT') return null; // mod not installed
    return {};
  }
}

export async function setVoicechatProperties(serverPath, props) {
  const filePath = path.join(serverPath, VOICECHAT_CONFIG);
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch {
    /* ok */
  }

  const lines = existing.split('\n');
  const handled = new Set();
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq);
    if (key in props) {
      handled.add(key);
      return `${key}=${props[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(props)) {
    if (!handled.has(k)) updated.push(`${k}=${v}`);
  }

  await fs.writeFile(filePath, updated.join('\n'), 'utf8');
}

// --- FTB Chunks config (SNBT format in world/serverconfig/) ---

const FTBCHUNKS_CONFIG = path.join('world', 'serverconfig', 'ftbchunks-world.snbt');
const FTBRANKS_JAR_PATTERN = /^ftb-?ranks/i;

// FTB Chunks SNBT keys we care about
const FTBCHUNKS_KEYS = [
  'max_claimed_chunks',
  'max_force_loaded_chunks',
  'hard_team_claim_limit',
  'hard_team_force_limit',
  'party_limit_mode',
];

/**
 * Parse a simple SNBT config file (key: value pairs, possibly nested).
 * FTB Chunks uses a flat-ish format with lines like: `max_claimed_chunks: 500`
 */
function parseSnbt(text) {
  const props = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed === '{' || trimmed === '}') continue;
    // Match key: value (SNBT uses colon separator)
    const match = trimmed.match(/^(\w+)\s*:\s*(.+?)$/);
    if (match) {
      let value = match[2].trim();
      // Remove trailing comma if present
      if (value.endsWith(',')) value = value.slice(0, -1).trim();
      // Remove quotes if string
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      props[match[1]] = value;
    }
  }
  return props;
}

/**
 * Update values in an SNBT file, preserving structure and comments.
 */
function updateSnbt(text, updates) {
  const handled = new Set();
  const lines = text.split('\n');
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed === '{' || trimmed === '}') return line;
    const match = trimmed.match(/^(\w+)\s*:\s*(.+?)$/);
    if (match && match[1] in updates) {
      const key = match[1];
      handled.add(key);
      const indent = line.match(/^(\s*)/)[1];
      const oldValue = match[2].trim();
      const hasComma = oldValue.endsWith(',');
      const newValue = updates[key];
      // Preserve type formatting: integers stay bare, strings get quotes
      const formatted = /^\d+$/.test(String(newValue)) ? newValue : `"${newValue}"`;
      return `${indent}${key}: ${formatted}${hasComma ? ',' : ''}`;
    }
    return line;
  });
  return updated.join('\n');
}

export async function getFtbChunksConfig(serverPath) {
  const filePath = path.join(serverPath, FTBCHUNKS_CONFIG);
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const all = parseSnbt(text);
    // Return only the keys we care about
    const result = {};
    for (const key of FTBCHUNKS_KEYS) {
      if (key in all) result[key] = all[key];
    }
    result._path = FTBCHUNKS_CONFIG;
    return result;
  } catch (err) {
    if (err.code === 'ENOENT') return null; // mod not installed or world not generated
    return null;
  }
}

export async function setFtbChunksConfig(serverPath, props) {
  const filePath = path.join(serverPath, FTBCHUNKS_CONFIG);
  const existing = await fs.readFile(filePath, 'utf8');

  // Only allow known keys
  const updates = {};
  for (const key of FTBCHUNKS_KEYS) {
    if (key in props) updates[key] = props[key];
  }

  const updated = updateSnbt(existing, updates);
  await fs.writeFile(filePath, updated, 'utf8');
}

export async function isFtbRanksInstalled(serverPath, modsFolder = 'mods') {
  try {
    const entries = await fs.readdir(path.join(serverPath, modsFolder));
    return entries.some((e) => FTBRANKS_JAR_PATTERN.test(e) && e.endsWith('.jar'));
  } catch {
    return false;
  }
}

// --- Mods folder ---

export async function listMods(serverPath, modsFolder = 'mods', disabledFolder = 'mods_disabled') {
  const modsPath = path.join(serverPath, modsFolder);
  const disabledPath = path.join(serverPath, disabledFolder);
  const mods = [];

  async function scanDir(dir, enabled) {
    try {
      const entries = await fs.readdir(dir);
      for (const name of entries) {
        if (!name.endsWith('.jar')) continue;
        const fullPath = path.join(dir, name);
        const stat = await fs.stat(fullPath);
        mods.push({ filename: name, size: stat.size, enabled, modrinthData: null });
      }
    } catch {
      // folder doesn't exist yet, that's fine
    }
  }

  await scanDir(modsPath, true);
  await scanDir(disabledPath, false);
  mods.sort((a, b) => a.filename.localeCompare(b.filename));
  return mods;
}

export async function toggleMod(serverPath, filename, enable, modsFolder = 'mods', disabledFolder = 'mods_disabled') {
  const modsPath = path.join(serverPath, modsFolder);
  const disabledPath = path.join(serverPath, disabledFolder);

  if (enable) {
    await fs.mkdir(modsPath, { recursive: true });
    // safeJoin verifies filename cannot escape the expected directory
    const src = safeJoin(disabledPath, filename);
    const dst = safeJoin(modsPath, filename);
    await fs.rename(src, dst);
  } else {
    await fs.mkdir(disabledPath, { recursive: true });
    const src = safeJoin(modsPath, filename);
    const dst = safeJoin(disabledPath, filename);
    await fs.rename(src, dst);
  }
}

export async function deleteMod(serverPath, filename, modsFolder = 'mods', disabledFolder = 'mods_disabled') {
  // safeJoin on both candidate paths — throws if filename escapes the directory
  const candidates = [
    safeJoin(path.join(serverPath, modsFolder), filename),
    safeJoin(path.join(serverPath, disabledFolder), filename),
  ];
  for (const p of candidates) {
    try {
      await fs.unlink(p);
      return;
    } catch {
      /* try next */
    }
  }
  throw new Error(`Mod file not found: ${filename}`);
}

export async function saveMod(serverPath, filename, buffer, modsFolder = 'mods') {
  const modsPath = path.join(serverPath, modsFolder);
  await fs.mkdir(modsPath, { recursive: true });
  const filePath = safeJoin(modsPath, filename);
  await fs.writeFile(filePath, buffer);
}

// --- SHA1 hash for Modrinth lookup ---

export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function hashFileSha512(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const stream = createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Write an override file to a relative path under serverPath, creating directories as needed.
 * Uses safeJoin to prevent path traversal.
 */
export async function writeOverrideFile(serverPath, relativePath, buffer) {
  const target = safeJoin(serverPath, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  return target;
}

export async function hashMods(serverPath, modsFolder = 'mods', disabledFolder = 'mods_disabled') {
  const result = {};
  for (const [folder, enabled] of [
    [modsFolder, true],
    [disabledFolder, false],
  ]) {
    const dir = path.join(serverPath, folder);
    try {
      const entries = await fs.readdir(dir);
      for (const name of entries) {
        if (!name.endsWith('.jar')) continue;
        try {
          result[name] = { hash: await hashFileCached(path.join(dir, name)), enabled };
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* folder missing */
    }
  }
  return result;
}
