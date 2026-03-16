// Discord permission model — integrated with the app's granular RBAC engine.
//
// Discord authorization resolves the acting user's effective app role via:
//   1. Discord role → app role mappings (config.authorization.discordRoleMapping)
//   2. Linked MC account → op level → app role (config.authorization.opLevelMapping)
//   3. Owner override roles (explicit, dangerous, off by default)
//
// Each Discord command specifies the app capability it requires.
// The resolved role's capability set is checked against that requirement.

import { audit } from '../../audit.js';
import { getLink } from './links.js';
import * as SF from '../../serverFiles.js';
import {
  getCapabilitiesForRole,
  resolveOpLevelRole,
  resolveDiscordRoleMapping,
  resolveEffectivePermissions,
  mergeAuthorizationConfig,
  ROLES,
  getRoleLevel,
} from '../../permissions.js';

/**
 * Permission levels — kept for backward compatibility with existing handler
 * registrations.  New commands should use `capability` instead.
 */
export const PermissionLevel = Object.freeze({
  READ_ONLY: 0,
  MODERATOR: 1,
  GAME_MASTER: 2,
  ADMIN: 3,
  OWNER: 4,
});

/** Map legacy PermissionLevel to a capability string for fallback. */
const LEVEL_TO_CAPABILITY = {
  [PermissionLevel.READ_ONLY]: 'discord.use_commands',
  [PermissionLevel.MODERATOR]: 'chat.broadcast',
  [PermissionLevel.GAME_MASTER]: 'server.send_console_command',
  [PermissionLevel.ADMIN]: 'panel.configure',
  [PermissionLevel.OWNER]: 'server.start',
};

/** Human-readable names for each tier (used in deny messages). */
export const TIER_NAMES = Object.freeze({
  [PermissionLevel.READ_ONLY]: 'Everyone',
  [PermissionLevel.MODERATOR]: 'Moderator',
  [PermissionLevel.GAME_MASTER]: 'Game Master',
  [PermissionLevel.ADMIN]: 'Admin',
  [PermissionLevel.OWNER]: 'Owner',
});

/**
 * Check whether a Discord interaction has the required capability.
 * Returns { allowed: true, opLevel?, role? } or { allowed: false, reason }.
 *
 * Resolution order:
 *   1. DM / guild / channel restrictions
 *   2. READ_ONLY capability → allow everyone
 *   3. Owner override role → grant owner role
 *   4. Discord role → app role mappings
 *   5. Linked MC account → op level → mapped app role
 *   6. Apply permission policy for linked panel user
 *   7. Check if resolved role has required capability
 */
export async function checkPermission(interaction, requiredLevel, discordConfig, ctx) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username;
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const commandName = interaction.commandName;

  // Resolve the required capability from the command definition
  const commands = interaction.client._commands;
  const cmdDef = commands?.get(commandName);
  const requiredCapability = cmdDef?.capability || LEVEL_TO_CAPABILITY[requiredLevel] || 'discord.use_commands';

  // DM check
  if (!guildId) {
    if (!discordConfig.allowDMs) {
      logDenied({ userId, username, guildId, channelId, commandName, reason: 'DMs not allowed' });
      return { allowed: false, reason: 'This bot only works in a server, not in DMs.' };
    }
  }

  // Guild check
  if (discordConfig.guildId && guildId && guildId !== discordConfig.guildId) {
    logDenied({ userId, username, guildId, channelId, commandName, reason: 'wrong guild' });
    return { allowed: false, reason: 'This bot is not configured for this server.' };
  }

  // Channel restriction
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

  // Resolve the user's effective app role for this Discord channel
  const authConfig = mergeAuthorizationConfig(ctx.config.authorization);
  const { role, opLevel } = await resolveDiscordUserRole(interaction, discordConfig, authConfig, ctx);

  // Check capability
  const caps = getCapabilitiesForRole(role);
  if (caps.has(requiredCapability)) {
    return { allowed: true, opLevel, role };
  }

  logDenied({
    userId,
    username,
    guildId,
    channelId,
    commandName,
    reason: `role "${role}" lacks capability "${requiredCapability}"`,
  });

  const roleDef = ROLES[role];
  return {
    allowed: false,
    reason: `This command requires the **${requiredCapability}** capability. Your Discord role resolves to **${roleDef?.name || role}** which doesn't have it.`,
  };
}

/**
 * Resolve the effective app role for a Discord user.
 * Returns { role, opLevel, source }.
 */
async function resolveDiscordUserRole(interaction, discordConfig, authConfig, ctx) {
  const userId = interaction.user.id;

  // Owner override role — explicit, dangerous escape hatch
  if (hasOwnerOverrideRole(interaction, discordConfig)) {
    audit('DISCORD_OWNER_OVERRIDE', {
      userId,
      username: interaction.user.tag || interaction.user.username,
      command: interaction.commandName,
    });
    return { role: 'owner', opLevel: 4, source: 'owner-override-role' };
  }

  let bestRole = null;
  let bestLevel = -1;
  let opLevel = 0;

  // Check Discord role → app role mappings
  if (Object.keys(authConfig.discordRoleMapping).length > 0) {
    const member = interaction.member;
    if (member?.roles) {
      const memberRoleIds = member.roles.cache ? [...member.roles.cache.keys()] : [];
      const mappedRole = resolveDiscordRoleMapping(memberRoleIds, authConfig.discordRoleMapping);
      if (mappedRole) {
        const level = getRoleLevel(mappedRole);
        if (level > bestLevel) {
          bestLevel = level;
          bestRole = mappedRole;
        }
      }
    }
  }

  // Check linked MC account → op level → mapped app role
  const link = await getLink(userId);
  if (link) {
    opLevel = await getOpLevel(link.minecraftName, ctx);
    const opMappedRole = resolveOpLevelRole(opLevel, authConfig.opLevelMapping);
    if (opMappedRole) {
      const level = getRoleLevel(opMappedRole);
      if (level > bestLevel) {
        bestRole = opMappedRole;
      }
    }
  }

  // Apply permission policy — optionally inherit from linked panel user
  const channelRole = bestRole || 'viewer';
  let panelRole = null;

  if (link) {
    // Look up the panel user linked to the same MC account
    try {
      const { getLinkByMinecraftName } = await import('../../panelLinks.js');
      const panelLink = await getLinkByMinecraftName(link.minecraftName);
      if (panelLink) {
        const { getUser } = await import('../../db.js');
        const panelUser = await getUser(panelLink.email);
        if (panelUser) {
          panelRole = panelUser.role || 'viewer';
        }
      }
    } catch {
      // Panel link lookup is non-critical
    }
  }

  const effective = resolveEffectivePermissions({
    channel: 'discord',
    channelRole,
    panelRole,
    policy: authConfig.permissionPolicy,
  });

  return { role: effective.role, opLevel, source: bestRole ? 'mapping' : 'default' };
}

/**
 * Check if the interaction member has an owner override role.
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
 */
export async function getOpLevel(minecraftName, ctx) {
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
 * Get the effective app role and capabilities for a Discord user.
 * Used by /help and /whoami to show what the user can do.
 */
export async function getEffectiveLevel(interaction, discordConfig, ctx) {
  // Owner override role
  if (hasOwnerOverrideRole(interaction, discordConfig)) {
    return { level: PermissionLevel.OWNER, role: 'owner', source: 'owner-override-role' };
  }

  const authConfig = mergeAuthorizationConfig(ctx.config.authorization);
  const { role, opLevel } = await resolveDiscordUserRole(interaction, discordConfig, authConfig, ctx);

  const link = await getLink(interaction.user.id);
  return {
    level: getRoleLevel(role),
    role,
    source: link ? 'linked' : 'not-linked',
    minecraftName: link?.minecraftName,
    opLevel,
  };
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
