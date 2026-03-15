// Outbound Discord notifications.
// Sends structured embeds to a configured channel for server events.
// No-ops safely if Discord is disabled, disconnected, or channel is missing.

import pkg from 'discord.js';
const { EmbedBuilder } = pkg;
import { warn } from '../../audit.js';

const COLORS = {
  green: 0x57f287,
  red: 0xed4245,
  orange: 0xe67e22,
  blue: 0x3498db,
  yellow: 0xfee75c,
};

const EVENT_TEMPLATES = {
  SERVER_START: { title: 'Server Started', color: COLORS.green, format: (d) => `Started by **${d.user || 'system'}**` },
  SERVER_STOP: { title: 'Server Stopped', color: COLORS.orange, format: (d) => `Stopped by **${d.user || 'system'}**` },
  SERVER_CRASH: {
    title: 'Server Crashed',
    color: COLORS.red,
    format: (d) => {
      const parts = [`Exit code: **${d.code}**`];
      if (d.uptimeSeconds != null) parts.push(`Uptime: ${formatSeconds(d.uptimeSeconds)}`);
      return parts.join('\n');
    },
  },
  SERVER_AUTO_RESTART: {
    title: 'Auto-Restart Triggered',
    color: COLORS.orange,
    format: (d) => `Attempt **${d.attempt}** — recovering from exit code ${d.code}`,
  },
  SERVER_RESTART: {
    title: 'Server Restarted',
    color: COLORS.blue,
    format: (d) => `Restarted by **${d.user || 'system'}**`,
  },
  BACKUP_CREATE: {
    title: 'Backup Created',
    color: COLORS.green,
    format: (d) => {
      const parts = [`**${d.name || d.filename}**`];
      if (d.size) parts.push(`Size: ${(d.size / 1048576).toFixed(1)} MB`);
      if (d.type) parts.push(`Type: ${d.type}`);
      return parts.join('\n');
    },
  },
  BACKUP_FAILED: {
    title: 'Backup Failed',
    color: COLORS.red,
    format: (d) => `Error: ${d.error || 'unknown'}`,
  },
  LAG_SPIKE: {
    title: 'Lag Spike Detected',
    color: COLORS.red,
    format: (d) => `TPS dropped to **${d.tps}** (threshold: ${d.threshold})`,
  },
};

let discordClient = null;
let channelId = null;

/**
 * Initialize the notification system with a connected Discord client.
 */
export function initDiscordNotifications(client, notificationChannelId) {
  discordClient = client;
  channelId = notificationChannelId;
}

/**
 * Tear down — called on shutdown.
 */
export function stopDiscordNotifications() {
  discordClient = null;
  channelId = null;
}

/**
 * Send a notification for a server event.
 * No-ops if Discord is not connected or channel is not configured.
 */
export async function sendDiscordNotification(event, details = {}) {
  if (!discordClient || !channelId) return;

  const template = EVENT_TEMPLATES[event];
  if (!template) return;

  try {
    const channel = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.send) {
      warn('Discord notification channel not found or not a text channel', { channelId, event });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(template.title)
      .setDescription(template.format(details))
      .setColor(template.color)
      .setTimestamp()
      .setFooter({ text: 'Minecraft Manager' });

    await channel.send({ embeds: [embed] });
  } catch (err) {
    warn('Discord notification send failed', { event, error: err.message });
  }
}

function formatSeconds(seconds) {
  if (seconds == null) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Exported for testing
export { EVENT_TEMPLATES };
