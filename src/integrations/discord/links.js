// Discord-to-Minecraft account linking.
// Uses PostgreSQL when available, falls back to in-memory for demo/no-DB setups.
// Each link maps a Discord user ID to a Minecraft player name.

import { audit } from '../../audit.js';
import {
  isConnected,
  upsertDiscordLink,
  getDiscordLink,
  listDiscordLinks,
  getDiscordLinkByMinecraftName,
  deleteDiscordLink,
} from '../../db.js';

// In-memory fallback for when no database is configured
/** @type {Map<string, { minecraftName: string, linkedBy: string, linkedAt: string }>} */
const memoryLinks = new Map();

/**
 * Link a Discord user to a Minecraft player name.
 * @param {string} discordId - Discord user ID (snowflake)
 * @param {string} minecraftName - Minecraft player name
 * @param {string} linkedBy - Who created the link (e.g. "self" or "discord:Admin#1234")
 */
export async function setLink(discordId, minecraftName, linkedBy) {
  if (isConnected()) {
    await upsertDiscordLink(discordId, minecraftName, linkedBy);
  } else {
    memoryLinks.set(discordId, {
      minecraftName,
      linkedBy,
      linkedAt: new Date().toISOString(),
    });
  }
  audit('DISCORD_LINK', { discordId, minecraftName, linkedBy });
}

/**
 * Remove a Discord user's link.
 * @param {string} discordId - Discord user ID
 * @returns {boolean} Whether a link existed
 */
export async function removeLink(discordId) {
  let existed;
  if (isConnected()) {
    existed = await deleteDiscordLink(discordId);
  } else {
    existed = memoryLinks.delete(discordId);
  }
  if (existed) {
    audit('DISCORD_UNLINK', { discordId });
  }
  return existed;
}

/**
 * Get the linked Minecraft name for a Discord user.
 * @param {string} discordId - Discord user ID
 * @returns {Promise<{ minecraftName: string, linkedBy: string, linkedAt: string } | null>}
 */
export async function getLink(discordId) {
  if (isConnected()) {
    const row = await getDiscordLink(discordId);
    if (!row) return null;
    return {
      minecraftName: row.minecraft_name,
      linkedBy: row.linked_by,
      linkedAt: row.linked_at,
    };
  }
  return memoryLinks.get(discordId) || null;
}

/**
 * Get all links (for admin listing / duplicate checks).
 * @returns {Promise<Array<{ discordId: string, minecraftName: string, linkedBy: string, linkedAt: string }>>}
 */
export async function getAllLinks() {
  if (isConnected()) {
    const rows = await listDiscordLinks();
    return rows.map((r) => ({
      discordId: r.discord_id,
      minecraftName: r.minecraft_name,
      linkedBy: r.linked_by,
      linkedAt: r.linked_at,
    }));
  }
  return [...memoryLinks.entries()].map(([discordId, entry]) => ({
    discordId,
    ...entry,
  }));
}

/**
 * Find a link by Minecraft name (to prevent duplicate claims).
 * @param {string} minecraftName
 * @returns {Promise<{ discordId: string, minecraftName: string } | null>}
 */
export async function getLinkByMinecraftName(minecraftName) {
  if (isConnected()) {
    const row = await getDiscordLinkByMinecraftName(minecraftName);
    if (!row) return null;
    return { discordId: row.discord_id, minecraftName: row.minecraft_name };
  }
  for (const [discordId, entry] of memoryLinks) {
    if (entry.minecraftName.toLowerCase() === minecraftName.toLowerCase()) {
      return { discordId, minecraftName: entry.minecraftName };
    }
  }
  return null;
}
