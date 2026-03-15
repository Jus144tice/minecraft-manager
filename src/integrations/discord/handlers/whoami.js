// /whoami — show your linked Minecraft account and permission level.

import pkg from 'discord.js';
const { SlashCommandBuilder, EmbedBuilder } = pkg;
import { PermissionLevel, TIER_NAMES, getEffectiveLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { getLink } from '../links.js';

export function register(ctx) {
  registerCommand('whoami', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder()
      .setName('whoami')
      .setDescription('Show your linked Minecraft account and permission level'),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: 64 });

      const discordConfig = interaction.client._discordConfig;
      const link = await getLink(interaction.user.id);
      const effective = await getEffectiveLevel(interaction, discordConfig, ctx);

      const embed = new EmbedBuilder()
        .setTitle('Your Permissions')
        .setColor(effective.level >= PermissionLevel.OWNER ? 0xe91e63 : effective.level > 0 ? 0x3498db : 0x95a5a6)
        .setTimestamp();

      if (link) {
        embed.addFields({ name: 'Linked Minecraft Account', value: link.minecraftName, inline: true });
      } else {
        embed.addFields({ name: 'Linked Minecraft Account', value: 'Not linked', inline: true });
      }

      embed.addFields({ name: 'Access Level', value: TIER_NAMES[effective.level] || 'Unknown', inline: true });

      if (effective.source === 'discord-admin-role') {
        embed.addFields({ name: 'Source', value: 'Discord admin role (full access)', inline: true });
      } else if (effective.source === 'linked' && effective.opLevel != null) {
        embed.addFields({ name: 'Op Level', value: `${effective.opLevel}`, inline: true });
      } else if (effective.source === 'not-linked') {
        embed.setFooter({ text: 'Use /link to connect your Minecraft account for elevated access.' });
      }

      await interaction.editReply({ embeds: [embed] });
    },
  });
}
