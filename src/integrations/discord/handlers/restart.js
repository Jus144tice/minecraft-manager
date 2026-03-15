// /restart — restart the Minecraft server (admin only).

import pkg from 'discord.js';
const { SlashCommandBuilder } = pkg;
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { audit } from '../../../audit.js';
import { getActiveOps } from '../../../operationLock.js';

export function register(ctx) {
  registerCommand('restart', {
    permission: PermissionLevel.ADMIN,
    builder: new SlashCommandBuilder().setName('restart').setDescription('Restart the Minecraft server'),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: 64 });

      const user = interaction.user.tag || interaction.user.username;

      if (ctx.config.demoMode) {
        ctx.demoState.running = false;
        ctx.stopDemoActivityTimer();
        ctx.broadcastStatus();
        setTimeout(() => {
          ctx.demoState.running = true;
          ctx.demoState.startTime = Date.now();
          ctx.startDemoActivityTimer();
          ctx.broadcastStatus();
        }, 1500);
        audit('SERVER_RESTART', { user: `discord:${user}`, source: 'discord' });
        return interaction.editReply('Server restarting... (demo mode)');
      }

      // Check lifecycle lock
      const conflict = getActiveOps().find((op) => op.scopes.includes('lifecycle'));
      if (conflict) {
        return interaction.editReply(`Cannot restart: **${conflict.name}** is already in progress.`);
      }

      if (!ctx.mc.running) {
        return interaction.editReply('Server is not running. Use `/start` instead.');
      }

      try {
        ctx.markIntentionalStop();
        const stopped = new Promise((resolve) => ctx.mc.once('stopped', resolve));
        if (ctx.rconConnected) {
          await ctx.rconCmd('stop');
        } else {
          ctx.mc.stop();
        }
        await Promise.race([stopped, new Promise((r) => setTimeout(r, 30000))]);
        ctx.mc.start(ctx.config.launch, ctx.config.serverPath);
        ctx.scheduleRconConnect(15000);
        ctx.broadcastStatus();
        audit('SERVER_RESTART', { user: `discord:${user}`, source: 'discord' });
        await interaction.editReply('Server restarting...');
      } catch (err) {
        await interaction.editReply(`Failed to restart server: ${err.message}`);
      }
    },
  });
}
