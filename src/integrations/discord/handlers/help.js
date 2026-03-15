// /help — list available commands based on the caller's permission level.

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { PermissionLevel } from '../permissions.js';
import { registerCommand, getCommandsByPermission } from '../registry.js';

export function register() {
  registerCommand('help', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder().setName('help').setDescription('Show available commands'),
    handler: async (interaction) => {
      // Determine caller's effective permission level
      const discordConfig = interaction.client._discordConfig;
      const member = interaction.member;
      let level = PermissionLevel.READ_ONLY;

      if (member && member.roles && discordConfig.adminRoleIds.length > 0) {
        const memberRoles = member.roles.cache ? [...member.roles.cache.keys()] : [];
        if (discordConfig.adminRoleIds.some((roleId) => memberRoles.includes(roleId))) {
          level = PermissionLevel.ADMIN;
        }
      }

      const cmds = getCommandsByPermission(level);
      const readOnly = cmds.filter((c) => c.permission === PermissionLevel.READ_ONLY);
      const admin = cmds.filter((c) => c.permission === PermissionLevel.ADMIN);

      const embed = new EmbedBuilder().setTitle('Minecraft Manager — Commands').setColor(0x3498db).setTimestamp();

      if (readOnly.length > 0) {
        embed.addFields({
          name: 'General Commands',
          value: readOnly.map((c) => `\`/${c.name}\``).join(', '),
        });
      }

      if (admin.length > 0) {
        embed.addFields({
          name: 'Admin Commands',
          value: admin.map((c) => `\`/${c.name}\``).join(', '),
        });
      }

      if (level === PermissionLevel.READ_ONLY && discordConfig.adminRoleIds.length > 0) {
        embed.setFooter({ text: 'Some commands require an admin role.' });
      }

      await interaction.reply({
        embeds: [embed],
        flags: discordConfig?.ephemeralReplies ? 64 : undefined,
      });
    },
  });
}
