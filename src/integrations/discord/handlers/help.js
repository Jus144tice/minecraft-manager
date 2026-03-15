// /help — list available commands based on the caller's permission level.

import pkg from 'discord.js';
const { SlashCommandBuilder, EmbedBuilder } = pkg;
import { PermissionLevel, TIER_NAMES, getEffectiveLevel } from '../permissions.js';
import { registerCommand, getCommandsByPermission } from '../registry.js';

export function register(ctx) {
  registerCommand('help', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder().setName('help').setDescription('Show available commands'),
    handler: async (interaction) => {
      await interaction.deferReply();

      const discordConfig = interaction.client._discordConfig;
      const effective = await getEffectiveLevel(interaction, discordConfig, ctx);
      const cmds = getCommandsByPermission(effective.level);

      // Group commands by permission tier
      const readOnly = cmds.filter((c) => c.permission === PermissionLevel.READ_ONLY);
      const moderator = cmds.filter((c) => c.permission === PermissionLevel.MODERATOR);
      const gameMaster = cmds.filter((c) => c.permission === PermissionLevel.GAME_MASTER);
      const admin = cmds.filter((c) => c.permission === PermissionLevel.ADMIN);
      const owner = cmds.filter((c) => c.permission === PermissionLevel.OWNER);

      const embed = new EmbedBuilder().setTitle('Minecraft Manager — Commands').setColor(0x3498db).setTimestamp();

      if (readOnly.length > 0) {
        embed.addFields({
          name: 'General Commands',
          value: readOnly.map((c) => `\`/${c.name}\``).join(', '),
        });
      }

      if (moderator.length > 0) {
        embed.addFields({
          name: 'Moderator Commands (Op 1+)',
          value: moderator.map((c) => `\`/${c.name}\``).join(', '),
        });
      }

      if (gameMaster.length > 0) {
        embed.addFields({
          name: 'Game Master Commands (Op 2+)',
          value: gameMaster.map((c) => `\`/${c.name}\``).join(', '),
        });
      }

      if (admin.length > 0) {
        embed.addFields({
          name: 'Admin Commands (Op 3+)',
          value: admin.map((c) => `\`/${c.name}\``).join(', '),
        });
      }

      if (owner.length > 0) {
        embed.addFields({
          name: 'Owner Commands (Op 4)',
          value: owner.map((c) => `\`/${c.name}\``).join(', '),
        });
      }

      const tierName = TIER_NAMES[effective.level] || 'Unknown';
      embed.setFooter({ text: `Your access level: ${tierName}` });

      await interaction.editReply({ embeds: [embed] });
    },
  });
}
