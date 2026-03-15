// Slash command interaction router.
// Dispatches incoming interactions to the appropriate handler
// after checking permissions centrally.

import { audit, warn } from '../../audit.js';
import { checkPermission } from './permissions.js';
import { getCommands } from './registry.js';

let _ctx = null;

/** Set the app context for permission checks (called during init). */
export function setCommandContext(ctx) {
  _ctx = ctx;
}

/**
 * Handle an incoming interaction (called from client interactionCreate event).
 */
export async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const commands = getCommands();
  const def = commands.get(interaction.commandName);
  if (!def) return;

  const discordConfig = interaction.client._discordConfig;
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username;
  const guildId = interaction.guildId || 'DM';
  const channelId = interaction.channelId || 'DM';

  // Central permission check (async — looks up op levels)
  const perm = await checkPermission(interaction, def.permission, discordConfig, _ctx);
  if (!perm.allowed) {
    try {
      await interaction.reply({ content: perm.reason, flags: 64 }); // ephemeral
    } catch {
      /* interaction may have expired */
    }
    return;
  }

  // Execute handler
  try {
    audit('DISCORD_CMD', {
      userId,
      username,
      guildId,
      channelId,
      command: interaction.commandName,
      args: formatArgs(interaction),
      source: 'discord',
    });

    await def.handler(interaction);
  } catch (err) {
    warn('Discord command handler error', {
      command: interaction.commandName,
      userId,
      error: err.message,
    });

    // Try to respond if we haven't yet
    try {
      const msg = 'An error occurred while processing this command.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply({ content: msg, flags: 64 });
      }
    } catch {
      /* interaction may have expired */
    }
  }
}

/** Format interaction options into a loggable object. */
function formatArgs(interaction) {
  const args = {};
  for (const opt of interaction.options.data || []) {
    args[opt.name] = opt.value;
  }
  return Object.keys(args).length > 0 ? args : undefined;
}
