// Discord integration entry point.
// Initializes the bot only when properly configured.
// Exposes start/stop/notify functions for the main app to call.

import { info } from '../../audit.js';
import { buildDiscordConfig } from './config.js';
import { connectDiscord, disconnectDiscord, getDiscordClient } from './client.js';
import { initDiscordNotifications, stopDiscordNotifications, sendDiscordNotification } from './notifications.js';

// Import command handler registrations
import { register as registerStatus } from './handlers/status.js';
import { register as registerPlayers } from './handlers/players.js';
import { register as registerHelp } from './handlers/help.js';
import { register as registerStart } from './handlers/start.js';
import { register as registerStop } from './handlers/stop.js';
import { register as registerRestart } from './handlers/restart.js';
import { register as registerSay } from './handlers/say.js';
import { register as registerBackup } from './handlers/backup.js';

let discordConfig = null;

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

  // Register all command handlers
  registerStatus(ctx);
  registerPlayers(ctx);
  registerHelp();
  registerStart(ctx);
  registerStop(ctx);
  registerRestart(ctx);
  registerSay(ctx);
  registerBackup(ctx);

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

  return true;
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
 * Get current Discord integration status (for settings API).
 */
export function getDiscordStatus() {
  const client = getDiscordClient();
  return {
    enabled: discordConfig?.enabled || false,
    connected: !!client?.isReady(),
    username: client?.user?.tag || null,
    guildCount: client?.guilds?.cache?.size || 0,
  };
}
