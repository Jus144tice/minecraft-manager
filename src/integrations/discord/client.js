// Discord bot client lifecycle.
// Creates, connects, and shuts down the Discord.js client.
// Registers slash commands with Discord API on startup if configured.

import pkg from 'discord.js';
const { Client, GatewayIntentBits, REST, Routes } = pkg;
import { info, warn } from '../../audit.js';
import { handleInteraction } from './commands.js';
import { getCommandsJSON } from './registry.js';

let client = null;

/**
 * Create and connect the Discord bot.
 * Returns the connected Client instance, or null on failure.
 */
export async function connectDiscord(discordConfig) {
  try {
    client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    // Attach config to client so handlers can read it
    client._discordConfig = discordConfig;

    // Register slash commands before connecting if configured
    if (discordConfig.registerCommandsOnStartup) {
      await registerSlashCommands(discordConfig);
    }

    // Set up interaction handler
    client.on('interactionCreate', handleInteraction);

    client.on('error', (err) => {
      warn('Discord client error', { error: err.message });
    });

    client.once('ready', () => {
      info('Discord bot connected', {
        username: client.user?.tag,
        guildId: discordConfig.guildId || 'all',
      });
    });

    await client.login(discordConfig.botToken);
    return client;
  } catch (err) {
    warn('Discord bot failed to connect', { error: err.message });
    client = null;
    return null;
  }
}

/**
 * Register slash commands with the Discord API.
 * Uses guild-scoped commands if guildId is set (instant), otherwise global (up to 1h propagation).
 */
async function registerSlashCommands(discordConfig) {
  const rest = new REST({ version: '10' }).setToken(discordConfig.botToken);
  const commandsJSON = getCommandsJSON();

  try {
    if (discordConfig.guildId) {
      await rest.put(Routes.applicationGuildCommands(discordConfig.applicationId, discordConfig.guildId), {
        body: commandsJSON,
      });
      info('Discord slash commands registered (guild-scoped)', {
        guildId: discordConfig.guildId,
        count: commandsJSON.length,
      });
    } else {
      await rest.put(Routes.applicationCommands(discordConfig.applicationId), {
        body: commandsJSON,
      });
      info('Discord slash commands registered (global)', { count: commandsJSON.length });
    }
  } catch (err) {
    warn('Failed to register Discord slash commands', { error: err.message });
  }
}

/**
 * Disconnect and destroy the Discord client.
 */
export async function disconnectDiscord() {
  if (client) {
    try {
      client.destroy();
      info('Discord bot disconnected');
    } catch (err) {
      warn('Error disconnecting Discord bot', { error: err.message });
    }
    client = null;
  }
}

/** Get the current client instance (for notifications). */
export function getDiscordClient() {
  return client;
}
