// Input validation helpers for user-supplied values.

import { ROLE_ORDER, PERMISSION_POLICIES } from './permissions.js';

// Minecraft player names: 1–16 characters, alphanumeric or underscore.
// (Mojang allows 1-16; NPC/Bedrock names may differ but this is conservative for server ops.)
const MC_NAME_RE = /^[a-zA-Z0-9_]{1,16}$/;

export function isValidMinecraftName(name) {
  return typeof name === 'string' && MC_NAME_RE.test(name);
}

// Safe mod filename: must end in .jar, no directory separators, no double-dot sequences.
// Allows the characters common in Forge/Fabric mod filenames.
const MOD_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-+]*\.jar$/i;

export function isSafeModFilename(name) {
  if (typeof name !== 'string') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return MOD_FILENAME_RE.test(name);
}

// Broader filename check for mrpack entries: mods (.jar, .jar.disabled), resource packs,
// shader packs, and config files. Allows spaces, parens, and other common characters.
// Still blocks path traversal and null bytes.
const MRPACK_FILENAME_RE = /\.(jar|jar\.disabled|zip)$/i;

export function isSafeMrpackFilename(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false;
  if (name === '..' || name.startsWith('../') || name.includes('/../')) return false;
  return MRPACK_FILENAME_RE.test(name);
}

// RCON / console commands: no null bytes, not empty, not absurdly long.
export function isSafeCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  if (cmd.length === 0 || cmd.length > 1000) return false;
  if (cmd.includes('\0')) return false;
  return true;
}

// Ban/kick reason: free text — strip null bytes and cap length.
export function sanitizeReason(reason) {
  if (typeof reason !== 'string') return 'Banned by admin';
  return (
    reason
      .replace(/\0/g, '')
      .replace(/[\r\n]/g, ' ')
      .slice(0, 200) || 'Banned by admin'
  );
}

// ---- Launch config helpers ----

// Parse a legacy startCommand string into a structured launch config.
// Handles quoted args and @arg files common in Forge launchers.
export function parseLaunchCommand(startCommand) {
  const parts = startCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (parts.length === 0) return null;
  const [executable, ...args] = parts;
  return { executable, args };
}

// Migrate legacy config: convert startCommand string → launch object.
// Returns true if a migration was performed.
export function migrateLaunchConfig(config) {
  if (config.launch?.executable) return false; // already structured
  if (!config.startCommand || typeof config.startCommand !== 'string') return false;

  const parsed = parseLaunchCommand(config.startCommand);
  if (parsed) {
    config.launch = parsed;
    delete config.startCommand;
    return true;
  }
  return false;
}

// Render a launch config as a single command-line string for display/logging.
export function launchToString(launch) {
  if (!launch?.executable) return '';
  const parts = [launch.executable, ...(launch.args || [])];
  return parts.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
}

// Startup config validation — returns an array of error strings (empty = valid).
const VALID_HOST_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^::[\d]*$|^localhost$/;

export function validateConfig(config) {
  const errors = [];
  if (config.demoMode) return errors; // demo mode needs no server config

  if (!config.serverPath || typeof config.serverPath !== 'string' || !config.serverPath.trim()) {
    errors.push('serverPath is missing or empty — set the absolute path to your Minecraft server folder.');
  }

  // Validate structured launch config
  if (!config.launch || typeof config.launch !== 'object') {
    errors.push('launch config is missing — set the executable and args used to launch the Minecraft server.');
  } else if (
    !config.launch.executable ||
    typeof config.launch.executable !== 'string' ||
    !config.launch.executable.trim()
  ) {
    errors.push('launch.executable is missing or empty — set the command used to launch the server (e.g. "java").');
  } else if (!Array.isArray(config.launch.args)) {
    errors.push('launch.args must be an array of command-line arguments.');
  }

  const rconPort = config.rconPort;
  if (
    rconPort !== undefined &&
    (typeof rconPort !== 'number' || !Number.isInteger(rconPort) || rconPort < 1 || rconPort > 65535)
  ) {
    errors.push(`rconPort must be an integer between 1 and 65535 (got ${JSON.stringify(rconPort)}).`);
  }

  const webPort = config.webPort;
  if (
    webPort !== undefined &&
    (typeof webPort !== 'number' || !Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
  ) {
    errors.push(`webPort must be an integer between 1 and 65535 (got ${JSON.stringify(webPort)}).`);
  }

  const bindHost = config.bindHost;
  if (bindHost !== undefined && (typeof bindHost !== 'string' || !VALID_HOST_RE.test(bindHost))) {
    errors.push(`bindHost must be a valid IP address (got ${JSON.stringify(bindHost)}).`);
  }

  // Validate authorization config if present
  if (config.authorization) {
    const auth = config.authorization;
    if (auth.permissionPolicy && !PERMISSION_POLICIES.includes(auth.permissionPolicy)) {
      errors.push(
        `authorization.permissionPolicy must be one of: ${PERMISSION_POLICIES.join(', ')} (got "${auth.permissionPolicy}").`,
      );
    }
    if (auth.opLevelMapping && typeof auth.opLevelMapping === 'object') {
      for (const [key, role] of Object.entries(auth.opLevelMapping)) {
        if (role !== null && !ROLE_ORDER.includes(role)) {
          errors.push(`authorization.opLevelMapping[${key}] must be a valid role or null (got "${role}").`);
        }
      }
    }
    if (auth.discordRoleMapping && typeof auth.discordRoleMapping === 'object') {
      for (const [roleId, role] of Object.entries(auth.discordRoleMapping)) {
        if (!ROLE_ORDER.includes(role)) {
          errors.push(`authorization.discordRoleMapping[${roleId}] must be a valid role (got "${role}").`);
        }
      }
    }
  }

  return errors;
}
