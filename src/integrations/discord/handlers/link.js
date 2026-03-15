// /link — link a Discord account to a Minecraft player name.
// Self-linking requires the player to be online for verification.
// Discord admins can link any user without the online check.

import pkg from 'discord.js';
const { SlashCommandBuilder } = pkg;
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { setLink, getLinkByMinecraftName } from '../links.js';
import { isValidMinecraftName } from '../../../validate.js';
import * as Demo from '../../../demoData.js';

export function register(ctx) {
  registerCommand('link', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Discord account to your Minecraft player')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Your Minecraft player name').setRequired(true),
      )
      .addUserOption((opt) =>
        opt.setName('user').setDescription('(Admin) Discord user to link').setRequired(false),
      ),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: 64 });

      const name = interaction.options.getString('name');
      const targetUser = interaction.options.getUser('user');
      const caller = interaction.user;
      const callerTag = caller.tag || caller.username;

      if (!isValidMinecraftName(name)) {
        return interaction.editReply('Invalid Minecraft player name.');
      }

      // Determine if this is a self-link or admin-linking-another-user
      const isAdminLink = targetUser && targetUser.id !== caller.id;

      if (isAdminLink) {
        // Only Discord admins can link other users
        const discordConfig = interaction.client._discordConfig;
        if (!hasAdminRole(interaction, discordConfig)) {
          return interaction.editReply(
            'Only Discord admins can link other users. To link yourself, use `/link name:<your_mc_name>`.',
          );
        }

        // Admin link — no online verification needed
        await setLink(targetUser.id, name, `discord:${callerTag}`);
        return interaction.editReply(
          `Linked <@${targetUser.id}> to Minecraft player **${name}**.`,
        );
      }

      // Self-link — verify player is online
      const onlinePlayers = await getOnlinePlayers(ctx);
      if (!onlinePlayers.some((p) => p.toLowerCase() === name.toLowerCase())) {
        return interaction.editReply(
          `Player **${name}** is not currently online. You must be logged into the Minecraft server to link your account.\n\n` +
            'Log in and try again, or ask a Discord admin to link you.',
        );
      }

      // Check if this MC name is already linked to someone else
      const existing = await getLinkByMinecraftName(name);
      if (existing && existing.discordId !== caller.id) {
        return interaction.editReply(
          `**${name}** is already linked to another Discord user. Ask a Discord admin if this is an error.`,
        );
      }

      await setLink(caller.id, name, 'self');
      return interaction.editReply(
        `Your Discord account is now linked to Minecraft player **${name}**. ` +
          'Your available commands are based on your server op level.',
      );
    },
  });
}

/** Get list of online player names. */
async function getOnlinePlayers(ctx) {
  if (ctx.config.demoMode) {
    return ctx.demoState.running ? Demo.DEMO_ONLINE_PLAYERS : [];
  }
  if (!ctx.mc.running) return [];
  try {
    const result = await ctx.rconCmd('list');
    const m = result.match(/There are \d+ of a max of \d+ players online: (.*)/);
    return m && m[1].trim() ? m[1].split(', ').map((n) => n.trim()) : [];
  } catch {
    return [];
  }
}

/** Check if interaction member has Discord admin role. */
function hasAdminRole(interaction, discordConfig) {
  if (discordConfig.adminRoleIds.length === 0) return false;
  const member = interaction.member;
  if (!member || !member.roles) return false;
  const memberRoles = member.roles.cache ? [...member.roles.cache.keys()] : [];
  return discordConfig.adminRoleIds.some((roleId) => memberRoles.includes(roleId));
}
