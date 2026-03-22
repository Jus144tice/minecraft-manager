// Dynamic mod config discovery, parsing, and editing.
// Scans config/ and world/serverconfig/ for mod config files (TOML, SNBT, properties).
// Parses values and extracts metadata from comments (descriptions, ranges, defaults, enums).
// Writes changes back preserving file structure and comments.

import { readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { safeJoin } from './pathUtils.js';

// Allowed config directories (relative to serverPath)
const SCAN_DIRS = ['config', path.join('world', 'serverconfig')];
const ALLOWED_EXTENSIONS = new Set(['.toml', '.snbt', '.properties']);

// Skip client-only configs and internal Forge configs
const SKIP_PATTERNS = [/-client\.toml$/i, /^forge-/, /^fml/];

// ---- Discovery ----

/**
 * Discover all mod config files in the server directory.
 * Returns an array of { configId, fileName, format, modId, displayName }.
 */
export async function discoverModConfigs(serverPath) {
  const configs = [];

  for (const dir of SCAN_DIRS) {
    let fullDir;
    try {
      fullDir = safeJoin(serverPath, dir);
    } catch {
      continue;
    }

    try {
      await scanDir(serverPath, dir, fullDir, configs);
    } catch {
      /* directory doesn't exist */
    }
  }

  // Sort by display name
  configs.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return configs;
}

async function scanDir(serverPath, relDir, fullDir, configs) {
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      if (SKIP_PATTERNS.some((p) => p.test(entry.name))) continue;

      const configId = path.join(relDir, entry.name).replace(/\\/g, '/');
      const modId = deriveModId(entry.name);
      configs.push({
        configId,
        fileName: entry.name,
        format: ext.slice(1), // 'toml', 'snbt', 'properties'
        modId,
        displayName: humanizeName(modId),
      });
    } else if (entry.isDirectory()) {
      // Scan one level of subdirectories (e.g., config/voicechat/)
      try {
        const subDir = path.join(relDir, entry.name);
        const fullSubDir = path.join(fullDir, entry.name);
        const subEntries = await readdir(fullSubDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isFile()) continue;
          const ext = path.extname(sub.name).toLowerCase();
          if (!ALLOWED_EXTENSIONS.has(ext)) continue;
          if (SKIP_PATTERNS.some((p) => p.test(sub.name))) continue;

          const configId = path.join(subDir, sub.name).replace(/\\/g, '/');
          const modId = deriveModId(entry.name); // use parent dir as modId
          configs.push({
            configId,
            fileName: sub.name,
            format: ext.slice(1),
            modId,
            displayName: humanizeName(modId),
          });
        }
      } catch {
        /* skip unreadable subdirs */
      }
    }
  }
}

function deriveModId(fileName) {
  return fileName
    .replace(/\.(toml|snbt|properties)$/i, '')
    .replace(/-(common|server|world|client)$/i, '')
    .replace(/[-_]/g, '')
    .toLowerCase();
}

function humanizeName(modId) {
  // Convert modId to display name: "ftbchunks" → "FTB Chunks", "voicechat" → "Voicechat"
  return modId.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

// ---- Parsing ----

/**
 * Read and parse a mod config file.
 * Returns { configId, format, entries: [...], filePath }.
 */
export async function readModConfig(serverPath, configId) {
  validateConfigId(configId);
  const filePath = safeJoin(serverPath, configId);
  const text = await readFile(filePath, 'utf8');
  const format = path.extname(configId).slice(1).toLowerCase();

  let entries;
  if (format === 'toml') {
    entries = parseToml(text);
  } else if (format === 'snbt') {
    entries = parseSnbt(text);
  } else if (format === 'properties') {
    entries = parseProperties(text);
  } else {
    throw new Error(`Unsupported format: ${format}`);
  }

  return { configId, format, entries, filePath: configId };
}

/**
 * Write changed values back to a mod config file, preserving structure.
 */
export async function writeModConfig(serverPath, configId, values) {
  validateConfigId(configId);
  const filePath = safeJoin(serverPath, configId);
  const text = await readFile(filePath, 'utf8');
  const format = path.extname(configId).slice(1).toLowerCase();

  let updated;
  if (format === 'toml') {
    updated = writeToml(text, values);
  } else if (format === 'snbt') {
    updated = writeSnbt(text, values);
  } else if (format === 'properties') {
    updated = writeProperties(text, values);
  } else {
    throw new Error(`Unsupported format: ${format}`);
  }

  await writeFile(filePath, updated, 'utf8');
}

function validateConfigId(configId) {
  // Must be within allowed directories
  const normalized = configId.replace(/\\/g, '/');
  const valid = SCAN_DIRS.some((dir) => normalized.startsWith(dir.replace(/\\/g, '/') + '/'));
  if (!valid) throw new Error('Invalid config path');
  // Must have allowed extension
  const ext = path.extname(normalized).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error('Invalid config file type');
}

// ---- TOML Parser ----

function parseToml(text) {
  const entries = [];
  let currentSection = null;
  let pendingComments = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    // Section header
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      pendingComments = [];
      continue;
    }

    // Comment
    if (trimmed.startsWith('#')) {
      pendingComments.push(trimmed.slice(1).trim());
      continue;
    }

    // Blank line clears pending comments
    if (!trimmed) {
      pendingComments = [];
      continue;
    }

    // Key-value pair
    const kvMatch = trimmed.match(/^([\w.]+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const rawValue = kvMatch[2].trim();
      const { value, type } = parseTomlValue(rawValue);
      const meta = extractMetadata(pendingComments);

      entries.push({
        section: currentSection,
        key,
        fullKey: currentSection ? `${currentSection}.${key}` : key,
        value,
        rawValue,
        type,
        ...meta,
      });
      pendingComments = [];
    }
  }

  return entries;
}

function parseTomlValue(raw) {
  if (raw === 'true') return { value: true, type: 'boolean' };
  if (raw === 'false') return { value: false, type: 'boolean' };
  if (/^-?\d+$/.test(raw)) return { value: parseInt(raw, 10), type: 'integer' };
  if (/^-?\d+\.\d+$/.test(raw)) return { value: parseFloat(raw), type: 'double' };
  if (raw.startsWith('"') && raw.endsWith('"')) return { value: raw.slice(1, -1), type: 'string' };
  if (raw.startsWith('[')) {
    // Simple list parsing
    const items = raw
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter((s) => s);
    return { value: items, type: 'list' };
  }
  return { value: raw, type: 'string' };
}

// ---- SNBT Parser ----

function parseSnbt(text) {
  const entries = [];
  let pendingComments = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed === '{' || trimmed === '}') {
      pendingComments = [];
      continue;
    }

    // Comment (SNBT uses # or //)
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      const comment = trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed.slice(2).trim();
      pendingComments.push(comment);
      continue;
    }

    // Key: value
    const kvMatch = trimmed.match(/^(\w+)\s*:\s*(.+?)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let rawValue = kvMatch[2].trim();
      if (rawValue.endsWith(',')) rawValue = rawValue.slice(0, -1).trim();

      const { value, type } = parseSnbtValue(rawValue);
      const meta = extractMetadata(pendingComments);

      entries.push({
        section: null,
        key,
        fullKey: key,
        value,
        rawValue,
        type,
        ...meta,
      });
      pendingComments = [];
    }
  }

  return entries;
}

function parseSnbtValue(raw) {
  if (raw === 'true') return { value: true, type: 'boolean' };
  if (raw === 'false') return { value: false, type: 'boolean' };
  if (/^-?\d+$/.test(raw)) return { value: parseInt(raw, 10), type: 'integer' };
  if (/^-?\d+\.\d+[dDfF]?$/.test(raw)) return { value: parseFloat(raw), type: 'double' };
  if (raw.startsWith('"') && raw.endsWith('"')) return { value: raw.slice(1, -1), type: 'string' };
  if (raw.startsWith('[')) {
    const items = raw
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter((s) => s);
    return { value: items, type: 'list' };
  }
  return { value: raw, type: 'string' };
}

// ---- Properties Parser ----

function parseProperties(text) {
  const entries = [];
  let pendingComments = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed) {
      pendingComments = [];
      continue;
    }

    if (trimmed.startsWith('#')) {
      pendingComments.push(trimmed.slice(1).trim());
      continue;
    }

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    const { value, type } = parsePropertiesValue(rawValue);
    const meta = extractMetadata(pendingComments);

    entries.push({
      section: null,
      key,
      fullKey: key,
      value,
      rawValue,
      type,
      ...meta,
    });
    pendingComments = [];
  }

  return entries;
}

function parsePropertiesValue(raw) {
  if (raw === 'true') return { value: true, type: 'boolean' };
  if (raw === 'false') return { value: false, type: 'boolean' };
  if (/^-?\d+$/.test(raw)) return { value: parseInt(raw, 10), type: 'integer' };
  if (/^-?\d+\.\d+$/.test(raw)) return { value: parseFloat(raw), type: 'double' };
  return { value: raw, type: 'string' };
}

// ---- Metadata Extraction from Comments ----

function extractMetadata(comments) {
  let description = '';
  let range = null;
  let defaultValue = null;
  let allowedValues = null;

  for (const c of comments) {
    const rangeMatch = c.match(/Range:\s*(.+)/i);
    if (rangeMatch) {
      const parts = rangeMatch[1].match(/([-\d.]+)\s*[~-]\s*([-\d.]+)/);
      if (parts) range = { min: parseFloat(parts[1]), max: parseFloat(parts[2]) };
      continue;
    }

    const defaultMatch = c.match(/Default:\s*(.+)/i);
    if (defaultMatch) {
      defaultValue = defaultMatch[1].trim();
      continue;
    }

    const allowedMatch = c.match(/(?:Allowed|Valid)\s*[Vv]alues?:\s*(.+)/i);
    if (allowedMatch) {
      allowedValues = allowedMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter((s) => s);
      continue;
    }

    // Accumulate description lines
    if (c && !c.startsWith('Range:') && !c.startsWith('Default:')) {
      description += (description ? ' ' : '') + c;
    }
  }

  return { description, range, defaultValue, allowedValues };
}

// ---- Write-back (preserve structure) ----

function writeToml(text, values) {
  let currentSection = null;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const sectionMatch = trimmed.match(/^\[(.+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        return line;
      }
      const kvMatch = trimmed.match(/^([\w.]+)\s*=\s*(.+)$/);
      if (kvMatch) {
        const fullKey = currentSection ? `${currentSection}.${kvMatch[1]}` : kvMatch[1];
        if (fullKey in values) {
          const indent = line.match(/^(\s*)/)[1];
          return `${indent}${kvMatch[1]} = ${formatTomlValue(values[fullKey])}`;
        }
      }
      return line;
    })
    .join('\n');
}

function formatTomlValue(val) {
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) return `[${val.map((v) => `"${v}"`).join(', ')}]`;
  return `"${val}"`;
}

function writeSnbt(text, values) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const kvMatch = trimmed.match(/^(\w+)\s*:\s*(.+?)$/);
      if (kvMatch && kvMatch[1] in values) {
        const indent = line.match(/^(\s*)/)[1];
        const oldVal = kvMatch[2].trim();
        const hasComma = oldVal.endsWith(',');
        const formatted = formatSnbtValue(values[kvMatch[1]]);
        return `${indent}${kvMatch[1]}: ${formatted}${hasComma ? ',' : ''}`;
      }
      return line;
    })
    .join('\n');
}

function formatSnbtValue(val) {
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) return `[${val.map((v) => `"${v}"`).join(', ')}]`;
  if (/^-?\d+$/.test(String(val)) || val === 'true' || val === 'false') return String(val);
  return `"${val}"`;
}

function writeProperties(text, values) {
  const handled = new Set();
  const lines = text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in values) {
      handled.add(key);
      return `${key}=${values[key]}`;
    }
    return line;
  });

  // Append any new keys not already in the file
  for (const [k, v] of Object.entries(values)) {
    if (!handled.has(k)) lines.push(`${k}=${v}`);
  }

  return lines.join('\n');
}
