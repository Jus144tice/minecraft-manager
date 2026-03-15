// /say — broadcast a message to the Minecraft server (admin only).

import pkg from 'discord.js';
const { SlashCommandBuilder } = pkg;
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { isSafeCommand } from '../../../validate.js';

export function register(ctx) {
  registerCommand('say', {
    permission: PermissionLevel.ADMIN,
    builder: new SlashCommandBuilder()
      .setName('say')
      .setDescription('Broadcast a message to the Minecraft server')
      .addStringOption((opt) => opt.setName('message').setDescription('Message to broadcast').setRequired(true)),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: interaction.client._discordConfig?.ephemeralReplies ? 64 : undefined });

      const message = interaction.options.getString('message');

      if (!isSafeCommand(message)) {
        return interaction.editReply('Invalid message content.');
      }

      if (ctx.config.demoMode) {
        ctx.broadcast({
          type: 'log',
          time: Date.now(),
          line: `[Server thread/INFO] [minecraft/MinecraftServer]: [Server] ${message}`,
        });
        return interaction.editReply(`Message sent: "${message}" (demo mode)`);
      }

      if (!ctx.mc.running) {
        return interaction.editReply('Server is not running.');
      }

      try {
        await ctx.rconCmd(`say ${message}`);
        await interaction.editReply(`Message sent: "${message}"`);
      } catch (err) {
        await interaction.editReply(`Failed to send message: ${err.message}`);
      }
    },
  });
}
