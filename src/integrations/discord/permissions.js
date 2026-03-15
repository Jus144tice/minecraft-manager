// Discord permission model.
// Centralizes all permission checks so command handlers stay clean.
// Two tiers: READ_ONLY (anyone in guild) and ADMIN (configured admin roles).

import { audit } from '../../audit.js';

export const PermissionLevel = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  ADMIN: 'ADMIN',
});

/**
 * Check whether a Discord interaction has the required permission level.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function checkPermission(interaction, requiredLevel, discordConfig) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username;
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const commandName = interaction.commandName;

  // DM check — block unless allowDMs is enabled
  if (!guildId) {
    if (!discordConfig.allowDMs) {
      logDenied({ userId, username, guildId, channelId, commandName, reason: 'DMs not allowed' });
      return { allowed: false, reason: 'This bot only works in a server, not in DMs.' };
    }
  }

  // Guild check — if guildId is configured, restrict to that guild
  if (discordConfig.guildId && guildId && guildId !== discordConfig.guildId) {
    logDenied({ userId, username, guildId, channelId, commandName, reason: 'wrong guild' });
    return { allowed: false, reason: 'This bot is not configured for this server.' };
  }

  // Channel restriction — if commandChannelIds is set, only allow those channels
  if (discordConfig.commandChannelIds.length > 0 && channelId) {
    if (!discordConfig.commandChannelIds.includes(channelId)) {
      logDenied({ userId, username, guildId, channelId, commandName, reason: 'wrong channel' });
      return { allowed: false, reason: 'Commands are not allowed in this channel.' };
    }
  }

  // READ_ONLY — everyone with basic access is allowed
  if (requiredLevel === PermissionLevel.READ_ONLY) {
    return { allowed: true };
  }

  // ADMIN — check role membership
  if (requiredLevel === PermissionLevel.ADMIN) {
    if (discordConfig.adminRoleIds.length === 0) {
      logDenied({ userId, username, guildId, channelId, commandName, reason: 'no admin roles configured' });
      return {
        allowed: false,
        reason: 'No admin roles are configured. An administrator must set up Discord admin role IDs.',
      };
    }

    const member = interaction.member;
    if (!member || !member.roles) {
      logDenied({ userId, username, guildId, channelId, commandName, reason: 'no member/roles data (possibly a DM)' });
      return { allowed: false, reason: 'Cannot verify your roles. Admin commands must be used in a server.' };
    }

    const memberRoles = member.roles.cache ? [...member.roles.cache.keys()] : [];
    const hasAdminRole = discordConfig.adminRoleIds.some((roleId) => memberRoles.includes(roleId));

    if (!hasAdminRole) {
      logDenied({ userId, username, guildId, channelId, commandName, reason: 'missing admin role' });
      return { allowed: false, reason: 'You do not have permission to use this command. An admin role is required.' };
    }

    return { allowed: true };
  }

  return { allowed: false, reason: 'Unknown permission level.' };
}

function logDenied({ userId, username, guildId, channelId, commandName, reason }) {
  audit('DISCORD_CMD_DENIED', {
    userId,
    username,
    guildId: guildId || 'DM',
    channelId: channelId || 'DM',
    command: commandName,
    reason,
  });
}
