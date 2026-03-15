// Discord integration entry point.
// Initializes the bot only when properly configured.
// Exposes start/stop/notify functions for the main app to call.
// Monitors Minecraft chat for !link challenge codes.

import { info, audit } from '../../audit.js';
import { buildDiscordConfig } from './config.js';
import { connectDiscord, disconnectDiscord, getDiscordClient } from './client.js';
import { setCommandContext } from './commands.js';
import { initDiscordNotifications, stopDiscordNotifications, sendDiscordNotification } from './notifications.js';
import { verifyChallenge, setLink, setChallengeTimeout } from './links.js';

// Import command handler registrations
import { register as registerStatus } from './handlers/status.js';
import { register as registerPlayers } from './handlers/players.js';
import { register as registerHelp } from './handlers/help.js';
import { register as registerStart } from './handlers/start.js';
import { register as registerStop } from './handlers/stop.js';
import { register as registerRestart } from './handlers/restart.js';
import { register as registerSay } from './handlers/say.js';
import { register as registerBackup } from './handlers/backup.js';
import { register as registerLink } from './handlers/link.js';
import { register as registerUnlink } from './handlers/unlink.js';
import { register as registerWhoami } from './handlers/whoami.js';

let discordConfig = null;

// Regex to parse Minecraft chat messages from server log lines.
// Matches: [Server thread/INFO] ... <PlayerName> message
// The timestamp/prefix format varies, so we match <PlayerName> message anywhere in the line.
const MC_CHAT_REGEX = /<(\w{3,16})>\s+(.+)/;

// Regex to match the !link command in chat
const LINK_CMD_REGEX = /^!link\s+([A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/i;

/**
 * Initialize the Discord integration.
 * Call during app startup. No-ops if Discord is not configured.
 * @param {object} appConfig - The full app config object
 * @param {object} ctx - The app services context
 * @returns {boolean} Whether Discord was successfully initialized
 */
export async function initDiscord(appConfig, ctx) {
  discordConfig = buildDiscordConfig(appConfig);

  if (!discordConfig.enabled) {
    info('Discord integration is disabled');
    return false;
  }

  // Apply challenge timeout from config
  if (discordConfig.linkChallengeTimeoutMinutes > 0) {
    setChallengeTimeout(discordConfig.linkChallengeTimeoutMinutes * 60_000);
  }

  // Set app context for permission checks in command router
  setCommandContext(ctx);

  // Register all command handlers
  registerStatus(ctx);
  registerPlayers(ctx);
  registerHelp(ctx);
  registerStart(ctx);
  registerStop(ctx);
  registerRestart(ctx);
  registerSay(ctx);
  registerBackup(ctx);
  registerLink(ctx);
  registerUnlink();
  registerWhoami(ctx);

  // Connect the bot
  const client = await connectDiscord(discordConfig);
  if (!client) {
    info('Discord bot failed to connect — integration disabled');
    return false;
  }

  // Initialize notification system
  if (discordConfig.notificationChannelId) {
    initDiscordNotifications(client, discordConfig.notificationChannelId);
  }

  // Start monitoring Minecraft chat for !link challenge codes
  startChatMonitor(ctx, client);

  return true;
}

/**
 * Monitor Minecraft server log for !link challenge codes.
 * Listens for chat messages like: <PlayerName> !link XXXX-XXXX
 */
function startChatMonitor(ctx, client) {
  ctx.mc.on('log', async (entry) => {
    if (!entry.line) return;

    // Parse chat message
    const chatMatch = entry.line.match(MC_CHAT_REGEX);
    if (!chatMatch) return;

    const playerName = chatMatch[1];
    const message = chatMatch[2].trim();

    // Check if it's a !link command
    const linkMatch = message.match(LINK_CMD_REGEX);
    if (!linkMatch) return;

    const code = linkMatch[1].toUpperCase();

    // Verify the challenge
    const challenge = verifyChallenge(playerName, code);
    if (!challenge) {
      // Wrong player, wrong code, or expired — silently ignore
      // (verifyChallenge logs wrong-player attempts internally)
      return;
    }

    // Challenge verified — create the link
    try {
      await setLink(challenge.discordUserId, playerName, 'self:verified');
      audit('DISCORD_LINK_VERIFIED', {
        discordUserId: challenge.discordUserId,
        minecraftName: playerName,
      });

      // Try to notify the user in Discord
      try {
        const user = await client.users.fetch(challenge.discordUserId);
        if (user) {
          await user.send(
            `Your Discord account has been successfully linked to Minecraft player **${playerName}**. ` +
              'Your available commands are now based on your server op level. Use `/whoami` to check.',
          );
        }
      } catch {
        // DMs may be disabled — that's fine, the link is still created
      }

      // Send confirmation in Minecraft chat via RCON
      try {
        if (ctx.rconConnected) {
          await ctx.rconCmd(`tellraw ${playerName} {"text":"Discord account linked successfully!","color":"green"}`);
        }
      } catch {
        // RCON may not support tellraw — that's fine
      }
    } catch (err) {
      info(`Failed to create link after challenge verification: ${err.message}`);
    }
  });
}

/**
 * Shut down the Discord integration cleanly.
 */
export async function shutdownDiscord() {
  stopDiscordNotifications();
  await disconnectDiscord();
  info('Discord integration shut down');
}

/**
 * Send a notification to Discord for a server event.
 * No-ops if Discord is disabled.
 */
export async function notifyDiscord(event, details = {}) {
  if (!discordConfig?.enabled) return;
  await sendDiscordNotification(event, details).catch(() => {});
}

/**
 * Test the Discord connection. Returns { ok, error? }.
 */
export async function testDiscordConnection() {
  const client = getDiscordClient();
  if (!client) return { ok: false, error: 'Discord bot is not connected' };
  try {
    const user = client.user;
    return { ok: true, username: user?.tag, guilds: client.guilds.cache.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Test sending a notification. Returns { ok, error? }.
 */
export async function testDiscordNotification() {
  if (!discordConfig?.enabled) return { ok: false, error: 'Discord integration is not enabled' };
  if (!discordConfig.notificationChannelId) return { ok: false, error: 'No notification channel configured' };
  try {
    await sendDiscordNotification('SERVER_START', { user: 'test' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get current Discord integration status (for dashboard & settings).
 */
export function getDiscordStatus() {
  const client = getDiscordClient();
  const connected = !!client?.isReady();

  const status = {
    enabled: discordConfig?.enabled || false,
    connected,
    username: client?.user?.tag || null,
    guildCount: client?.guilds?.cache?.size || 0,
    notificationChannelId: discordConfig?.notificationChannelId || null,
  };

  // Add guild info if connected
  if (connected && client.guilds?.cache?.size > 0) {
    const guild = discordConfig?.guildId ? client.guilds.cache.get(discordConfig.guildId) : client.guilds.cache.first();
    if (guild) {
      status.guildName = guild.name;
      status.memberCount = guild.memberCount;
    }
  }

  // Add notification channel name if configured
  if (connected && discordConfig?.notificationChannelId) {
    try {
      const ch = client.channels?.cache?.get(discordConfig.notificationChannelId);
      if (ch) status.notificationChannelName = `#${ch.name}`;
    } catch {
      /* channel not cached yet */
    }
  }

  return status;
}

/**
 * Send a plain-text message to the notification channel.
 * Returns { ok, error? }.
 */
export async function sendDiscordMessage(message) {
  if (!discordConfig?.enabled) return { ok: false, error: 'Discord integration is not enabled' };
  if (!discordConfig.notificationChannelId) return { ok: false, error: 'No notification channel configured' };

  const client = getDiscordClient();
  if (!client?.isReady()) return { ok: false, error: 'Discord bot is not connected' };

  try {
    const channel = await client.channels.fetch(discordConfig.notificationChannelId);
    if (!channel || !channel.send) return { ok: false, error: 'Notification channel not found' };
    await channel.send(message);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
