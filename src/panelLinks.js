// Panel-user-to-Minecraft account linking.
// Uses PostgreSQL when available, falls back to in-memory for demo/no-DB setups.
// Each link maps a panel user email to a Minecraft player name.

import { audit } from './audit.js';
import {
  isConnected,
  upsertPanelLink,
  getPanelLink,
  listPanelLinks,
  getPanelLinkByMinecraftName,
  deletePanelLink,
} from './db.js';

// In-memory fallback for when no database is configured
/** @type {Map<string, { minecraftName: string, linkedBy: string, verified: boolean, linkedAt: string }>} */
const memoryLinks = new Map();

// ============================================================
// Link CRUD
// ============================================================

/**
 * Link a panel user to a Minecraft player name.
 * @param {string} email - Panel user email
 * @param {string} minecraftName - Minecraft player name
 * @param {string} linkedBy - Who created the link (e.g. "self", "self:verified", "admin:admin@example.com")
 * @param {boolean} [verified=false] - Whether the link has been verified via challenge
 */
export async function setLink(email, minecraftName, linkedBy, verified = false) {
  if (isConnected()) {
    await upsertPanelLink(email, minecraftName, linkedBy, verified);
  } else {
    memoryLinks.set(email, {
      minecraftName,
      linkedBy,
      verified,
      linkedAt: new Date().toISOString(),
    });
  }
  audit('PANEL_LINK', { email, minecraftName, linkedBy, verified });
}

/**
 * Remove a panel user's link.
 * @param {string} email - Panel user email
 * @returns {boolean} Whether a link existed
 */
export async function removeLink(email) {
  let existed;
  if (isConnected()) {
    existed = await deletePanelLink(email);
  } else {
    existed = memoryLinks.delete(email);
  }
  if (existed) {
    audit('PANEL_UNLINK', { email });
  }
  return existed;
}

/**
 * Get the linked Minecraft name for a panel user.
 * @param {string} email - Panel user email
 * @returns {Promise<{ minecraftName: string, linkedBy: string, verified: boolean, linkedAt: string } | null>}
 */
export async function getLink(email) {
  if (isConnected()) {
    const row = await getPanelLink(email);
    if (!row) return null;
    return {
      minecraftName: row.minecraft_name,
      linkedBy: row.linked_by,
      verified: row.verified,
      linkedAt: row.linked_at,
    };
  }
  return memoryLinks.get(email) || null;
}

/**
 * Get all links (for admin listing).
 * @returns {Promise<Array<{ email: string, minecraftName: string, linkedBy: string, verified: boolean, linkedAt: string }>>}
 */
export async function getAllLinks() {
  if (isConnected()) {
    const rows = await listPanelLinks();
    return rows.map((r) => ({
      email: r.user_email,
      minecraftName: r.minecraft_name,
      linkedBy: r.linked_by,
      verified: r.verified,
      linkedAt: r.linked_at,
    }));
  }
  return [...memoryLinks.entries()].map(([email, entry]) => ({
    email,
    ...entry,
  }));
}

/**
 * Find a link by Minecraft name.
 * @param {string} minecraftName
 * @returns {Promise<{ email: string, minecraftName: string, linkedBy?: string, verified?: boolean, linkedAt?: string } | null>}
 */
export async function getLinkByMinecraftName(minecraftName) {
  if (isConnected()) {
    const row = await getPanelLinkByMinecraftName(minecraftName);
    if (!row) return null;
    return {
      email: row.user_email,
      minecraftName: row.minecraft_name,
      linkedBy: row.linked_by,
      verified: row.verified,
      linkedAt: row.linked_at,
    };
  }
  for (const [email, entry] of memoryLinks) {
    if (entry.minecraftName.toLowerCase() === minecraftName.toLowerCase()) {
      return { email, minecraftName: entry.minecraftName, verified: entry.verified };
    }
  }
  return null;
}

/**
 * Seed demo panel links into the in-memory store.
 * @param {Array<{ email: string, minecraftName: string, linkedBy: string, verified: boolean, linkedAt: string }>} links
 */
export function loadDemoLinks(links) {
  for (const link of links) {
    memoryLinks.set(link.email, {
      minecraftName: link.minecraftName,
      linkedBy: link.linkedBy,
      verified: link.verified,
      linkedAt: link.linkedAt,
    });
  }
}
