// Discord integration configuration.
// Reads from environment variables (secrets) and config.json (non-secrets).
// Returns a validated, frozen config object or null if disabled.
//
// Role concepts:
//   allowedRoleIds      — restricts who may use the bot at all
//   botAdminRoleIds     — Discord-side bot admin (manage bot features, NOT Minecraft server authority)
//   ownerOverrideRoleIds — dangerous: bypasses MC op-level checks for server commands (off by default)

import { info, warn } from '../../audit.js';

/**
 * Build and validate Discord configuration from env vars + app config.
 * Returns { enabled: true, ...fields } or { enabled: false }.
 */
export function buildDiscordConfig(appConfig) {
  const discord = appConfig.discord || {};

  // Bot token MUST come from env var — never stored in config.json
  const botToken = process.env.DISCORD_BOT_TOKEN || '';
  const applicationId = process.env.DISCORD_APPLICATION_ID || discord.applicationId || '';

  // If no token, integration is disabled regardless of config flag
  if (!botToken || !applicationId) {
    if (discord.enabled) {
      warn('Discord integration enabled in config but DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID is missing');
    }
    return { enabled: false };
  }

  // Explicitly disabled in config
  if (discord.enabled === false) {
    info('Discord integration disabled in config');
    return { enabled: false };
  }

  // Migration: support old DISCORD_ADMIN_ROLE_IDS env var as botAdminRoleIds
  const botAdminEnv = process.env.DISCORD_BOT_ADMIN_ROLE_IDS || process.env.DISCORD_ADMIN_ROLE_IDS || '';
  const ownerOverrideEnv = process.env.DISCORD_OWNER_OVERRIDE_ROLE_IDS || '';

  const config = {
    enabled: true,
    botToken,
    applicationId,
    guildId: process.env.DISCORD_GUILD_ID || discord.guildId || '',
    botAdminRoleIds: parseList(botAdminEnv) || toArray(discord.botAdminRoleIds || discord.adminRoleIds),
    allowedRoleIds: parseList(process.env.DISCORD_ALLOWED_ROLE_IDS || '') || toArray(discord.allowedRoleIds),
    ownerOverrideRoleIds: parseList(ownerOverrideEnv) || toArray(discord.ownerOverrideRoleIds),
    notificationChannelId: process.env.DISCORD_NOTIFICATION_CHANNEL_ID || discord.notificationChannelId || '',
    commandChannelIds: parseList(process.env.DISCORD_COMMAND_CHANNEL_IDS || '') || toArray(discord.commandChannelIds),
    allowDMs: discord.allowDMs ?? false,
    registerCommandsOnStartup: discord.registerCommandsOnStartup ?? true,
    linkChallengeTimeoutMinutes: Number(discord.linkChallengeTimeoutMinutes) || 10,
  };

  const errors = validateDiscordConfig(config);
  if (errors.length > 0) {
    for (const err of errors) warn(`Discord config: ${err}`);
    return { enabled: false };
  }

  return Object.freeze(config);
}

/**
 * Validate a Discord config object. Returns array of error strings.
 */
export function validateDiscordConfig(config) {
  const errors = [];
  if (!config.botToken) errors.push('botToken is required');
  if (!config.applicationId) errors.push('applicationId is required');
  if (config.guildId && !/^\d{17,20}$/.test(config.guildId)) {
    errors.push(`guildId must be a Discord snowflake ID (got "${config.guildId}")`);
  }
  if (config.applicationId && !/^\d{17,20}$/.test(config.applicationId)) {
    errors.push(`applicationId must be a Discord snowflake ID (got "${config.applicationId}")`);
  }
  for (const id of config.botAdminRoleIds || []) {
    if (!/^\d{17,20}$/.test(id)) errors.push(`Invalid bot admin role ID: "${id}"`);
  }
  for (const id of config.ownerOverrideRoleIds || []) {
    if (!/^\d{17,20}$/.test(id)) errors.push(`Invalid owner override role ID: "${id}"`);
  }
  for (const id of config.allowedRoleIds || []) {
    if (!/^\d{17,20}$/.test(id)) errors.push(`Invalid allowed role ID: "${id}"`);
  }
  if (config.notificationChannelId && !/^\d{17,20}$/.test(config.notificationChannelId)) {
    errors.push(`notificationChannelId must be a Discord snowflake ID`);
  }
  return errors;
}

/** Parse a comma-separated string into a trimmed array, filtering empties. */
function parseList(str) {
  if (!str) return null;
  const items = str
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/** Ensure a value is an array. */
function toArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.trim()) return [val.trim()];
  return [];
}
