// Webhook notification system.
// Sends Discord embeds or generic JSON POSTs for server events.
// Hooks into audit() and explicit notify() calls from the app.

import { warn } from './audit.js';

// ---- State ----

let config = null; // reference to the live app config
let lastLagNotify = 0;
const LAG_COOLDOWN_MS = 300_000; // 5 minutes between lag alerts

// ---- Setup ----

export function initNotifications(appConfig) {
  config = appConfig;
}

export function updateNotificationsConfig(appConfig) {
  config = appConfig;
}

// ---- Event definitions ----
// Maps audit actions (and custom events) to human-friendly messages + Discord embed colors.

const COLORS = {
  red: 0xed4245,
  orange: 0xe67e22,
  green: 0x57f287,
  blue: 0x3498db,
  yellow: 0xfee75c,
  grey: 0x95a5a6,
};

const EVENT_DEFS = {
  // Server lifecycle
  SERVER_START: { title: 'Server Started', color: COLORS.green, format: (d) => `Started by **${d.user || 'system'}**` },
  SERVER_STOP: { title: 'Server Stopped', color: COLORS.orange, format: (d) => `Stopped by **${d.user || 'system'}**` },
  SERVER_KILL: {
    title: 'Server Force-Killed',
    color: COLORS.red,
    format: (d) => `Force-killed by **${d.user || 'system'}**`,
  },
  SERVER_RESTART: {
    title: 'Server Restarted',
    color: COLORS.blue,
    format: (d) => `Restarted by **${d.user || 'system'}**`,
  },
  SERVER_CRASH: {
    title: 'Server Crashed',
    color: COLORS.red,
    format: (d) => {
      const parts = [`Exit code: **${d.code}**`];
      if (d.uptimeSeconds != null) parts.push(`Uptime: ${formatUptime(d.uptimeSeconds)}`);
      return parts.join('\n');
    },
  },
  SERVER_AUTO_RESTART: {
    title: 'Auto-Restart Triggered',
    color: COLORS.orange,
    format: (d) => `Attempt **${d.attempt}** — recovering from exit code ${d.code}`,
  },

  // Backups
  BACKUP_CREATE: {
    title: 'Backup Created',
    color: COLORS.green,
    format: (d) => {
      const parts = [`**${d.name || d.filename}**`, `Type: ${d.type}`, `Size: ${formatBytes(d.size)}`];
      if (d.quiesced) parts.push('Server was quiesced for consistent snapshot');
      return parts.join('\n');
    },
  },
  BACKUP_RESTORE: {
    title: 'Backup Restored',
    color: COLORS.orange,
    format: (d) => `Restored **${d.filename}**`,
  },
  BACKUP_FAILED: {
    title: 'Backup Failed',
    color: COLORS.red,
    format: (d) => `Error: ${d.error || 'unknown'}`,
  },

  // Players
  PLAYER_BAN: {
    title: 'Player Banned',
    color: COLORS.red,
    format: (d) => `**${d.target}** banned by ${d.user}\nReason: ${d.reason || 'No reason given'}`,
  },
  PLAYER_UNBAN: {
    title: 'Player Unbanned',
    color: COLORS.green,
    format: (d) => `**${d.target}** unbanned by ${d.user}`,
  },
  PLAYER_KICK: {
    title: 'Player Kicked',
    color: COLORS.orange,
    format: (d) => `**${d.target}** kicked by ${d.user}\nReason: ${d.reason || 'No reason given'}`,
  },

  // Mods
  MOD_INSTALL: {
    title: 'Mod Installed',
    color: COLORS.blue,
    format: (d) => `**${d.filename}** installed by ${d.user}`,
  },
  MOD_DELETE: {
    title: 'Mod Deleted',
    color: COLORS.orange,
    format: (d) => `**${d.filename}** deleted by ${d.user}`,
  },
  MODPACK_IMPORT: {
    title: 'Modpack Imported',
    color: COLORS.blue,
    format: (d) => `Imported by ${d.user}`,
  },

  // Performance
  LAG_SPIKE: {
    title: 'Lag Spike Detected',
    color: COLORS.red,
    format: (d) => `TPS dropped to **${d.tps}** (threshold: ${d.threshold})`,
  },

  // Auth (security-relevant)
  LOGIN_FAILED: {
    title: 'Login Failed',
    color: COLORS.yellow,
    format: (d) => `Provider: ${d.provider}, IP: ${d.ip || 'unknown'}`,
  },
  LOGIN_DENIED: {
    title: 'Login Denied',
    color: COLORS.yellow,
    format: (d) => `Reason: ${d.reason}, Provider: ${d.provider}`,
  },
};

// ---- Public API ----

/**
 * Send a notification for a named event.
 * Called automatically from onAuditEvent, or explicitly for non-audit events (lag spikes).
 */
export async function notify(event, details = {}) {
  if (!config) return;
  const nconf = config.notifications;
  if (!nconf?.webhookUrl) return;

  // Check if this event is enabled
  if (nconf.events && !nconf.events.includes(event)) return;

  const def = EVENT_DEFS[event];
  if (!def) return; // unknown event, skip

  try {
    const url = nconf.webhookUrl;
    if (isDiscordWebhook(url)) {
      await sendDiscord(url, def, details);
    } else {
      await sendGenericWebhook(url, event, def, details);
    }
  } catch (err) {
    warn('Notification delivery failed', { event, error: err.message });
  }
}

/**
 * Hook for audit events — called from audit() in audit.js.
 * Forwards relevant audit actions to the notification system.
 */
export function onAuditEvent(action, details) {
  if (!config?.notifications?.webhookUrl) return;
  // Fire-and-forget — notifications should never block the caller
  notify(action, details).catch(() => {});
}

/**
 * Notify about lag spikes with cooldown to prevent spam.
 */
export function notifyLagSpike(tps, threshold) {
  if (!config?.notifications?.webhookUrl) return;
  const now = Date.now();
  if (now - lastLagNotify < LAG_COOLDOWN_MS) return;
  lastLagNotify = now;
  notify('LAG_SPIKE', { tps, threshold }).catch(() => {});
}

// ---- Discord webhook ----

function isDiscordWebhook(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'discord.com' || u.hostname === 'discordapp.com';
  } catch {
    return false;
  }
}

async function sendDiscord(url, def, details) {
  const embed = {
    title: def.title,
    description: def.format(details),
    color: def.color,
    timestamp: new Date().toISOString(),
    footer: { text: 'Minecraft Manager' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord webhook ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ---- Generic webhook ----

async function sendGenericWebhook(url, event, def, details) {
  const payload = {
    event,
    title: def.title,
    message: def.format(details).replace(/\*\*/g, ''), // strip markdown bold
    details,
    timestamp: new Date().toISOString(),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webhook ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ---- Formatting helpers ----

function formatBytes(bytes) {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatUptime(seconds) {
  if (seconds == null) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Exported for testing
export { EVENT_DEFS, formatBytes, formatUptime, isDiscordWebhook };
