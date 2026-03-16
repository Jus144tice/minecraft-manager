// /stop — stop the Minecraft server gracefully (admin only).

import pkg from 'discord.js';
const { SlashCommandBuilder } = pkg;
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { audit } from '../../../audit.js';

export function register(ctx) {
  registerCommand('stop', {
    permission: PermissionLevel.OWNER,
    capability: 'server.stop',
    builder: new SlashCommandBuilder().setName('stop').setDescription('Stop the Minecraft server'),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: 64 });

      const user = interaction.user.tag || interaction.user.username;

      if (ctx.config.demoMode) {
        if (!ctx.demoState.running) {
          return interaction.editReply('Server is not running.');
        }
        ctx.demoState.running = false;
        ctx.demoState.startTime = null;
        ctx.stopDemoActivityTimer();
        ctx.broadcastStatus();
        audit('SERVER_STOP', { user: `discord:${user}`, source: 'discord' });
        return interaction.editReply('Server stopped. (demo mode)');
      }

      if (!ctx.mc.running) {
        return interaction.editReply('Server is not running.');
      }

      try {
        ctx.markIntentionalStop();
        if (ctx.rconConnected) {
          await ctx.rconCmd('stop');
        } else {
          ctx.mc.stop();
        }
        audit('SERVER_STOP', { user: `discord:${user}`, source: 'discord' });
        await interaction.editReply('Stop signal sent. Server is shutting down...');
      } catch (err) {
        await interaction.editReply(`Failed to stop server: ${err.message}`);
      }
    },
  });
}
