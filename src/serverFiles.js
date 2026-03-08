// Read/write Minecraft server data files: ops.json, whitelist.json,
// banned-players.json, banned-ips.json, server.properties, and mods folder.
// All file operations that accept user-influenced filenames use safeJoin to
// prevent path traversal attacks.

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createReadStream } from 'fs';
import { safeJoin } from './pathUtils.js';

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
  try { existing = await fs.readFile(filePath, 'utf8'); } catch { /* ok */ }

  const lines = existing.split('\n');
  const handled = new Set();
  const updated = lines.map(line => {
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
    try { await fs.unlink(p); return; } catch { /* try next */ }
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
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function hashMods(serverPath, modsFolder = 'mods', disabledFolder = 'mods_disabled') {
  const result = {};
  for (const [folder, enabled] of [[modsFolder, true], [disabledFolder, false]]) {
    const dir = path.join(serverPath, folder);
    try {
      const entries = await fs.readdir(dir);
      for (const name of entries) {
        if (!name.endsWith('.jar')) continue;
        try {
          result[name] = { hash: await hashFile(path.join(dir, name)), enabled };
        } catch { /* skip unreadable */ }
      }
    } catch { /* folder missing */ }
  }
  return result;
}
