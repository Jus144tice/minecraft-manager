// /status — show server status, uptime, TPS, player count, health summary.

import pkg from 'discord.js';
const { SlashCommandBuilder, EmbedBuilder } = pkg;
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { collectMetrics, collectDemoMetrics } from '../../../metrics.js';
import * as Demo from '../../../demoData.js';

export function register(ctx) {
  registerCommand('status', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder().setName('status').setDescription('Show Minecraft server status'),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: interaction.client._discordConfig?.ephemeralReplies ? 64 : undefined });

      let data;
      if (ctx.config.demoMode) {
        const m = collectDemoMetrics();
        data = {
          ...Demo.getDemoStatus(ctx.demoState.running, ctx.getDemoUptime()),
          ...m,
        };
      } else {
        const m = await collectMetrics({
          mc: ctx.mc,
          rconCmd: ctx.rconCmd,
          rconConnected: ctx.rconConnected,
          config: ctx.config,
        });
        data = {
          running: ctx.mc.running,
          uptime: ctx.mc.getUptime(),
          rconConnected: ctx.rconConnected,
          ...m,
        };
      }

      const embed = new EmbedBuilder()
        .setTitle('Server Status')
        .setColor(data.running ? 0x57f287 : 0xed4245)
        .setTimestamp();

      const status = data.running ? '🟢 Online' : '🔴 Offline';
      embed.addFields({ name: 'Status', value: status, inline: true });

      if (data.uptime != null) {
        embed.addFields({ name: 'Uptime', value: formatUptime(data.uptime), inline: true });
      }

      if (data.tps != null) {
        const tpsStr = `${data.tps.toFixed(1)} TPS`;
        embed.addFields({ name: 'TPS', value: tpsStr, inline: true });
      }

      if (data.playerCount != null) {
        embed.addFields({ name: 'Players', value: `${data.playerCount}`, inline: true });
      } else if (data.onlinePlayers) {
        embed.addFields({ name: 'Players', value: `${data.onlinePlayers.length}`, inline: true });
      }

      if (data.cpuPercent != null) {
        embed.addFields({ name: 'CPU', value: `${data.cpuPercent.toFixed(1)}%`, inline: true });
      }

      if (data.memoryMb != null) {
        embed.addFields({ name: 'RAM', value: `${data.memoryMb} MB`, inline: true });
      }

      if (ctx.config.minecraftVersion) {
        embed.addFields({ name: 'Version', value: ctx.config.minecraftVersion, inline: true });
      }

      if (ctx.config.serverAddress) {
        embed.addFields({ name: 'Address', value: ctx.config.serverAddress, inline: true });
      }

      await interaction.editReply({ embeds: [embed] });
    },
  });
}

function formatUptime(seconds) {
  if (seconds == null) return 'N/A';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m}m`;
}
