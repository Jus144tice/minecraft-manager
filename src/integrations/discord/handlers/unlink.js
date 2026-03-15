// /unlink — remove your own Discord-to-Minecraft account link.
// Self-unlink only. No admin-unlink of other users.

import pkg from 'discord.js';
const { SlashCommandBuilder } = pkg;
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { removeLink, getLink } from '../links.js';

export function register() {
  registerCommand('unlink', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Unlink your Discord account from your Minecraft player'),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: 64 });

      const caller = interaction.user;

      const link = await getLink(caller.id);
      if (!link) {
        return interaction.editReply('You do not have a linked Minecraft account.');
      }

      await removeLink(caller.id);
      return interaction.editReply(
        `Unlinked from Minecraft player **${link.minecraftName}**. You now have read-only access.`,
      );
    },
  });
}
