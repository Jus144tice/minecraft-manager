// Discord permission model.
// Discord roles and Minecraft op levels are clearly separate concepts:
//   - Discord roles control bot access (allowedRoleIds, botAdminRoleIds)
//   - Minecraft op levels control server operation permissions (via account linking)
//   - ownerOverrideRoleIds is an explicit, optional, dangerous escape hatch
//
// Read-only commands are available to everyone in the guild.
// Elevated commands require linking your Discord account to a Minecraft player
// and having the appropriate op level.

import { audit } from '../../audit.js';
import { getLink } from './links.js';
import * as SF from '../../serverFiles.js';

/**
 * Permission levels mapped to Minecraft op levels.
 * READ_ONLY (0) requires no linking.
 * Higher levels require the user's linked MC account to have that op level.
 */
export const PermissionLevel = Object.freeze({
  READ_ONLY: 0,
  MODERATOR: 1,
  GAME_MASTER: 2,
  ADMIN: 3,
  OWNER: 4,
});

/** Human-readable names for each tier. */
export const TIER_NAMES = Object.freeze({
  [PermissionLevel.READ_ONLY]: 'Everyone',
  [PermissionLevel.MODERATOR]: 'Moderator (Op 1+)',
  [PermissionLevel.GAME_MASTER]: 'Game Master (Op 2+)',
  [PermissionLevel.ADMIN]: 'Admin (Op 3+)',
  [PermissionLevel.OWNER]: 'Owner (Op 4)',
});

/**
 * Check whether a Discord interaction has the required permission level.
 * Returns { allowed: true, opLevel?: number } or { allowed: false, reason: string }.
 *
 * Permission resolution:
 * 1. DM / guild / channel restrictions
 * 2. Allowed-role check (if configured)
 * 3. READ_ONLY → allow everyone
 * 4. Owner override role → allow (if explicitly configured)
 * 5. Linked MC account + op level check
 * 6. Deny
 */
export async function checkPermission(interaction, requiredLevel, discordConfig, ctx) {
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

  // Owner override role — explicit, dangerous, off by default
  if (hasOwnerOverrideRole(interaction, discordConfig)) {
    audit('DISCORD_OWNER_OVERRIDE', {
      userId,
      username,
      command: commandName,
    });
    return { allowed: true, opLevel: 4 };
  }

  // For elevated commands, look up linked Minecraft account + op level
  const link = await getLink(userId);
  if (!link) {
    logDenied({ userId, username, guildId, channelId, commandName, reason: 'no linked Minecraft account' });
    return {
      allowed: false,
      reason:
        'You need to link your Minecraft account to use this command. Use `/link` to get started.',
    };
  }

  const opLevel = await getOpLevel(link.minecraftName, ctx);

  if (opLevel >= requiredLevel) {
    return { allowed: true, opLevel };
  }

  logDenied({
    userId,
    username,
    guildId,
    channelId,
    commandName,
    reason: `op level ${opLevel} < required ${requiredLevel}`,
    minecraftName: link.minecraftName,
  });
  return {
    allowed: false,
    reason: `This command requires **${TIER_NAMES[requiredLevel]}** access. Your linked account (${link.minecraftName}) has op level ${opLevel}.`,
  };
}

/**
 * Check if the interaction member has an owner override role.
 * This is an explicit, dangerous escape hatch — off by default.
 */
function hasOwnerOverrideRole(interaction, discordConfig) {
  if (!discordConfig.ownerOverrideRoleIds || discordConfig.ownerOverrideRoleIds.length === 0) return false;
  const member = interaction.member;
  if (!member || !member.roles) return false;
  const memberRoles = member.roles.cache ? [...member.roles.cache.keys()] : [];
  return discordConfig.ownerOverrideRoleIds.some((roleId) => memberRoles.includes(roleId));
}

/**
 * Check if the interaction member has a bot admin role.
 * Bot admin roles grant Discord-side bot management privileges,
 * NOT Minecraft server authority.
 */
export function hasBotAdminRole(interaction, discordConfig) {
  if (!discordConfig.botAdminRoleIds || discordConfig.botAdminRoleIds.length === 0) return false;
  const member = interaction.member;
  if (!member || !member.roles) return false;
  const memberRoles = member.roles.cache ? [...member.roles.cache.keys()] : [];
  return discordConfig.botAdminRoleIds.some((roleId) => memberRoles.includes(roleId));
}

/**
 * Look up a Minecraft player's op level from ops.json.
 * Returns 0 if not an operator.
 */
async function getOpLevel(minecraftName, ctx) {
  try {
    if (ctx.config.demoMode) {
      const { DEMO_OPS } = await import('../../demoData.js');
      const op = DEMO_OPS.find((o) => o.name.toLowerCase() === minecraftName.toLowerCase());
      return op ? op.level : 0;
    }
    const ops = await SF.getOps(ctx.config.serverPath);
    const op = ops.find((o) => o.name.toLowerCase() === minecraftName.toLowerCase());
    return op ? op.level : 0;
  } catch {
    return 0;
  }
}

/**
 * Get the effective permission level for a Discord user.
 * Used by /help and /whoami to show what the user can do.
 */
export async function getEffectiveLevel(interaction, discordConfig, ctx) {
  // Owner override role
  if (hasOwnerOverrideRole(interaction, discordConfig)) {
    return { level: PermissionLevel.OWNER, source: 'owner-override-role' };
  }

  const link = await getLink(interaction.user.id);
  if (!link) {
    return { level: PermissionLevel.READ_ONLY, source: 'not-linked' };
  }

  const opLevel = await getOpLevel(link.minecraftName, ctx);
  const level = Math.min(opLevel, PermissionLevel.OWNER);
  return { level, source: 'linked', minecraftName: link.minecraftName, opLevel };
}

function logDenied({ userId, username, guildId, channelId, commandName, reason, minecraftName }) {
  audit('DISCORD_CMD_DENIED', {
    userId,
    username,
    guildId: guildId || 'DM',
    channelId: channelId || 'DM',
    command: commandName,
    reason,
    ...(minecraftName ? { minecraftName } : {}),
  });
}
