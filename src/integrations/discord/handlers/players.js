// /players — show online players.

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import * as Demo from '../../../demoData.js';

export function register(ctx) {
  registerCommand('players', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder().setName('players').setDescription('Show online players'),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: interaction.client._discordConfig?.ephemeralReplies ? 64 : undefined });

      const embed = new EmbedBuilder().setTitle('Online Players').setTimestamp();

      if (ctx.config.demoMode) {
        const players = ctx.demoState.running ? Demo.DEMO_ONLINE_PLAYERS : [];
        if (players.length === 0) {
          embed.setDescription('No players online.').setColor(0x95a5a6);
        } else {
          embed.setDescription(players.map((p) => `• ${p}`).join('\n')).setColor(0x57f287);
          embed.setFooter({ text: `${players.length} player${players.length !== 1 ? 's' : ''} online` });
        }
        return interaction.editReply({ embeds: [embed] });
      }

      if (!ctx.mc.running) {
        embed.setDescription('Server is offline.').setColor(0xed4245);
        return interaction.editReply({ embeds: [embed] });
      }

      try {
        const result = await ctx.rconCmd('list');
        const m = result.match(/There are \d+ of a max of \d+ players online: (.*)/);
        const names = m && m[1].trim() ? m[1].split(', ').map((n) => n.trim()) : [];

        if (names.length === 0) {
          embed.setDescription('No players online.').setColor(0x95a5a6);
        } else {
          embed.setDescription(names.map((p) => `• ${p}`).join('\n')).setColor(0x57f287);
          embed.setFooter({ text: `${names.length} player${names.length !== 1 ? 's' : ''} online` });
        }
      } catch {
        embed.setDescription('Could not retrieve player list. RCON may not be connected.').setColor(0xe67e22);
      }

      await interaction.editReply({ embeds: [embed] });
    },
  });
}
