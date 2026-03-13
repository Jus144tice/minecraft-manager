// Input validation helpers for user-supplied values.

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

// Startup config validation — returns an array of error strings (empty = valid).
const VALID_HOST_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^::[\d]*$|^localhost$/;

export function validateConfig(config) {
  const errors = [];
  if (config.demoMode) return errors; // demo mode needs no server config

  if (!config.serverPath || typeof config.serverPath !== 'string' || !config.serverPath.trim()) {
    errors.push('serverPath is missing or empty — set the absolute path to your Minecraft server folder.');
  }
  if (!config.startCommand || typeof config.startCommand !== 'string' || !config.startCommand.trim()) {
    errors.push('startCommand is missing or empty — set the command used to launch the Minecraft server.');
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

  return errors;
}
