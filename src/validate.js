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
  return reason.replace(/\0/g, '').replace(/[\r\n]/g, ' ').slice(0, 200) || 'Banned by admin';
}
