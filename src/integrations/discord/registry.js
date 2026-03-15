// Slash command registry.
// Defines all Discord slash commands with metadata, permission levels, and builders.
// Keeps command definitions separate from handler logic.

import { PermissionLevel } from './permissions.js';

const commands = new Map();

/**
 * Register a slash command.
 */
export function registerCommand(name, def) {
  commands.set(name, def);
}

/** Get all registered commands. */
export function getCommands() {
  return commands;
}

/** Get commands filtered by permission level. */
export function getCommandsByPermission(level) {
  const result = [];
  for (const [name, def] of commands) {
    if (level === PermissionLevel.ADMIN || def.permission === PermissionLevel.READ_ONLY) {
      result.push({ name, permission: def.permission });
    }
  }
  return result;
}

/** Get the JSON payload for registering commands with Discord. */
export function getCommandsJSON() {
  return [...commands.values()].map((c) => c.builder.toJSON());
}
