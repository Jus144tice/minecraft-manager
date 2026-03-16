// Slash command registry.
// Defines all Discord slash commands with metadata, permission levels, and builders.
// Keeps command definitions separate from handler logic.

import { getCapabilitiesForRole } from '../../permissions.js';

const commands = new Map();

/**
 * Register a slash command.
 * Command definitions include:
 *   - permission: legacy PermissionLevel (0-4)
 *   - capability: (optional) required app capability string
 *   - builder: SlashCommandBuilder
 *   - handler: async (interaction) => void
 */
export function registerCommand(name, def) {
  commands.set(name, def);
}

/** Get all registered commands. */
export function getCommands() {
  return commands;
}

/** Get commands filtered by the caller's effective app role. */
export function getCommandsByPermission(level, role) {
  const result = [];
  const caps = role ? getCapabilitiesForRole(role) : null;

  for (const [name, def] of commands) {
    // If we have a role, check capability; otherwise fall back to legacy level check
    if (caps && def.capability) {
      if (caps.has(def.capability)) {
        result.push({ name, permission: def.permission, capability: def.capability });
      }
    } else if (level >= def.permission) {
      result.push({ name, permission: def.permission, capability: def.capability });
    }
  }
  return result;
}

/** Get the JSON payload for registering commands with Discord. */
export function getCommandsJSON() {
  return [...commands.values()].map((c) => c.builder.toJSON());
}
