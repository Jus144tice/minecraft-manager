// /start — start the Minecraft server (admin only).

import pkg from 'discord.js';
const { SlashCommandBuilder } = pkg;
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { audit } from '../../../audit.js';
import { getActiveOps } from '../../../operationLock.js';

export function register(ctx) {
  registerCommand('start', {
    permission: PermissionLevel.OWNER,
    capability: 'server.start',
    builder: new SlashCommandBuilder().setName('start').setDescription('Start the Minecraft server'),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: 64 });

      const user = interaction.user.tag || interaction.user.username;

      if (ctx.config.demoMode) {
        if (ctx.demoState.running) {
          return interaction.editReply('Server is already running.');
        }
        ctx.demoState.running = true;
        ctx.demoState.startTime = Date.now();
        ctx.broadcastStatus();
        ctx.startDemoActivityTimer();
        audit('SERVER_START', { user: `discord:${user}`, source: 'discord' });
        return interaction.editReply('Server starting... (demo mode)');
      }

      // Check lifecycle lock
      const conflict = getActiveOps().find((op) => op.scopes.includes('lifecycle'));
      if (conflict) {
        return interaction.editReply(`Cannot start: **${conflict.name}** is already in progress.`);
      }

      if (ctx.mc.running) {
        return interaction.editReply('Server is already running.');
      }

      try {
        ctx.mc.start(ctx.config.launch, ctx.config.serverPath);
        ctx.scheduleRconConnect(15000);
        ctx.broadcastStatus();
        audit('SERVER_START', { user: `discord:${user}`, source: 'discord' });
        await interaction.editReply('Server starting...');
      } catch (err) {
        await interaction.editReply(`Failed to start server: ${err.message}`);
      }
    },
  });
}
