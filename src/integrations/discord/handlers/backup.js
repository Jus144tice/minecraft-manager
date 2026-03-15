// /backup — trigger a backup (admin only).

import { SlashCommandBuilder } from 'discord.js';
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { createBackup } from '../../../backup.js';

export function register(ctx) {
  registerCommand('backup', {
    permission: PermissionLevel.ADMIN,
    builder: new SlashCommandBuilder()
      .setName('backup')
      .setDescription('Create a server backup')
      .addStringOption((opt) => opt.setName('note').setDescription('Optional backup note').setRequired(false)),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: interaction.client._discordConfig?.ephemeralReplies ? 64 : undefined });

      const user = interaction.user.tag || interaction.user.username;
      const note = interaction.options.getString('note') || '';

      if (ctx.config.demoMode) {
        return interaction.editReply('Backups are not available in demo mode.');
      }

      try {
        await interaction.editReply('Backup starting... this may take a while.');

        const result = await createBackup(ctx.config, {
          type: 'manual',
          note: String(note).slice(0, 200),
          user: `discord:${user}`,
          rconCmd: ctx.rconConnected ? ctx.rconCmd : null,
        });

        const sizeMb = (result.size / 1048576).toFixed(1);
        await interaction.editReply(
          `Backup complete: **${result.filename}** (${sizeMb} MB)` +
            (result.quiesced ? ' — server was quiesced for consistency' : ''),
        );
      } catch (err) {
        const msg = err.message.includes('already in progress')
          ? 'A backup or restore is already in progress. Please wait.'
          : `Backup failed: ${err.message}`;
        await interaction.editReply(msg);
      }
    },
  });
}
