// /link — begin a code-based challenge to link your Discord account to a Minecraft player.
// Self-linking only. No admin-linking of other users.
//
// Flow:
// 1. User runs /link name:PlayerName
// 2. Bot generates a short challenge code and replies ephemerally
// 3. User joins the MC server as PlayerName and types: !link CODE
// 4. The chat monitor (in index.js) detects the message, verifies, and creates the link

import pkg from 'discord.js';
const { SlashCommandBuilder } = pkg;
import { PermissionLevel } from '../permissions.js';
import { registerCommand } from '../registry.js';
import { getLink, getLinkByMinecraftName, createChallenge, getChallengeTimeout } from '../links.js';
import { isValidMinecraftName } from '../../../validate.js';

export function register(ctx) {
  registerCommand('link', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Discord account to your Minecraft player')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Your Minecraft player name').setRequired(true),
      ),
    handler: async (interaction) => {
      await interaction.deferReply({ flags: 64 });

      const name = interaction.options.getString('name');
      const caller = interaction.user;

      if (!isValidMinecraftName(name)) {
        return interaction.editReply('Invalid Minecraft player name. Names must be 3–16 characters, alphanumeric or underscores.');
      }

      // Check if caller already has a link
      const existingLink = await getLink(caller.id);
      if (existingLink) {
        return interaction.editReply(
          `You are already linked to **${existingLink.minecraftName}**. Use \`/unlink\` first to remove the existing link.`,
        );
      }

      // Check if this MC name is already linked to a different Discord user
      const existingClaim = await getLinkByMinecraftName(name);
      if (existingClaim && existingClaim.discordId !== caller.id) {
        return interaction.editReply(
          `The Minecraft account **${name}** is already linked to another Discord user. If this is an error, the other user must \`/unlink\` first.`,
        );
      }

      // Check if the server is online (we need it for the verification step)
      if (!ctx.config.demoMode && !ctx.mc.running) {
        return interaction.editReply(
          'The Minecraft server is currently offline. Start the server first, then try again — you\'ll need to type a verification code in Minecraft chat.',
        );
      }

      // Create a challenge (replaces any existing pending challenge for this user)
      const challenge = createChallenge(caller.id, name);
      const timeoutMinutes = Math.round(getChallengeTimeout() / 60_000);

      return interaction.editReply(
        `Link request created for Minecraft account \`${name}\`.\n\n` +
          `Join the server as **${name}** and type this in Minecraft chat:\n` +
          `\`\`\`\n!link ${challenge.code}\n\`\`\`\n` +
          `This code expires in ${timeoutMinutes} minutes.`,
      );
    },
  });
}
