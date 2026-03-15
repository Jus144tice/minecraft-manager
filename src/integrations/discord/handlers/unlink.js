// /unlink — remove a Discord-to-Minecraft account link.
// Users can unlink themselves. Discord admins can unlink anyone.

import pkg from 'discord.js';
const { SlashCommandBuilder } = pkg;
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { removeLink, getLink } from '../links.js';

export function register() {
  registerCommand('unlink', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Unlink your Discord account from your Minecraft player')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('(Admin) Discord user to unlink').setRequired(false),
      ),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: 64 });

      const targetUser = interaction.options.getUser('user');
      const caller = interaction.user;
      const isAdminUnlink = targetUser && targetUser.id !== caller.id;

      if (isAdminUnlink) {
        const discordConfig = interaction.client._discordConfig;
        if (!hasAdminRole(interaction, discordConfig)) {
          return interaction.editReply('Only Discord admins can unlink other users.');
        }

        const link = await getLink(targetUser.id);
        if (!link) {
          return interaction.editReply(`<@${targetUser.id}> does not have a linked account.`);
        }

        await removeLink(targetUser.id);
        return interaction.editReply(
          `Unlinked <@${targetUser.id}> from Minecraft player **${link.minecraftName}**.`,
        );
      }

      // Self-unlink
      const link = await getLink(caller.id);
      if (!link) {
        return interaction.editReply('You do not have a linked Minecraft account.');
      }

      await removeLink(caller.id);
      return interaction.editReply(
        `Unlinked from Minecraft player **${link.minecraftName}**. You now have read-only access.`,
      );
    },
  });
}

/** Check if interaction member has Discord admin role. */
function hasAdminRole(interaction, discordConfig) {
  if (discordConfig.adminRoleIds.length === 0) return false;
  const member = interaction.member;
  if (!member || !member.roles) return false;
  const memberRoles = member.roles.cache ? [...member.roles.cache.keys()] : [];
  return discordConfig.adminRoleIds.some((roleId) => memberRoles.includes(roleId));
}
