// Discord-to-Minecraft account linking and challenge-based verification.
// Uses PostgreSQL when available, falls back to in-memory for demo/no-DB setups.
// Each link maps a Discord user ID to a Minecraft player name.
// Pending challenges are always in-memory (they don't survive restarts).

import { audit } from '../../audit.js';
import crypto from 'crypto';
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

// Pending link challenges (always in-memory, keyed by discordUserId)
/** @type {Map<string, PendingChallenge>} */
const pendingChallenges = new Map();

/** Default challenge timeout in milliseconds (10 minutes). */
let challengeTimeoutMs = 10 * 60 * 1000;

/** Cleanup timer for expired challenges. */
let cleanupTimer = null;

/**
 * @typedef {object} PendingChallenge
 * @property {string} sourceType - 'discord' or 'panel'
 * @property {string} sourceId - Discord user ID or panel email
 * @property {string} discordUserId - Alias for sourceId (backward compat, set when sourceType is 'discord')
 * @property {string} minecraftName
 * @property {string} code
 * @property {number} createdAt
 * @property {number} expiresAt
 */

// ============================================================
// Link CRUD
// ============================================================

/**
 * Link a Discord user to a Minecraft player name.
 * @param {string} discordId - Discord user ID (snowflake)
 * @param {string} minecraftName - Minecraft player name
 * @param {string} linkedBy - Who created the link (e.g. "self" or "web:admin@example.com")
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
 * @returns {Promise<{ discordId: string, minecraftName: string, linkedBy?: string, linkedAt?: string } | null>}
 */
export async function getLinkByMinecraftName(minecraftName) {
  if (isConnected()) {
    const row = await getDiscordLinkByMinecraftName(minecraftName);
    if (!row) return null;
    return {
      discordId: row.discord_id,
      minecraftName: row.minecraft_name,
      linkedBy: row.linked_by,
      linkedAt: row.linked_at,
    };
  }
  for (const [discordId, entry] of memoryLinks) {
    if (entry.minecraftName.toLowerCase() === minecraftName.toLowerCase()) {
      return { discordId, minecraftName: entry.minecraftName };
    }
  }
  return null;
}

// ============================================================
// Challenge system
// ============================================================

/**
 * Set the challenge timeout (for testing or config override).
 * @param {number} ms - Timeout in milliseconds
 */
export function setChallengeTimeout(ms) {
  challengeTimeoutMs = ms;
}

/** Get the current challenge timeout in ms. */
export function getChallengeTimeout() {
  return challengeTimeoutMs;
}

/**
 * Generate a unique, human-readable challenge code.
 * Format: XXXX-XXXX (8 alphanumeric chars, uppercase).
 */
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I for readability
  let code;
  do {
    const bytes = crypto.randomBytes(8);
    const part1 = Array.from(bytes.slice(0, 4))
      .map((b) => chars[b % chars.length])
      .join('');
    const part2 = Array.from(bytes.slice(4, 8))
      .map((b) => chars[b % chars.length])
      .join('');
    code = `${part1}-${part2}`;
  } while (hasPendingCode(code)); // ensure uniqueness among pending challenges
  return code;
}

/**
 * Check if a code is already in use by a pending challenge.
 */
function hasPendingCode(code) {
  for (const challenge of pendingChallenges.values()) {
    if (challenge.code === code) return true;
  }
  return false;
}

/**
 * Create a pending link challenge.
 * Replaces any existing pending challenge for that source.
 *
 * @param {string} sourceId - Discord user ID or panel email
 * @param {string} minecraftName - The MC name they claim to own
 * @param {'discord'|'panel'} [sourceType='discord'] - Which system initiated the challenge
 * @returns {PendingChallenge} The created challenge
 */
export function createChallenge(sourceId, minecraftName, sourceType = 'discord') {
  const key = `${sourceType}:${sourceId}`;
  // Replace any existing challenge for this source
  pendingChallenges.delete(key);

  const now = Date.now();
  const challenge = {
    sourceType,
    sourceId,
    discordUserId: sourceType === 'discord' ? sourceId : undefined,
    minecraftName,
    code: generateCode(),
    createdAt: now,
    expiresAt: now + challengeTimeoutMs,
  };

  pendingChallenges.set(key, challenge);

  audit('LINK_CHALLENGE', {
    sourceType,
    sourceId,
    minecraftName,
    expiresInMs: challengeTimeoutMs,
  });

  // Start cleanup timer if not already running
  startCleanupTimer();

  return challenge;
}

/**
 * Get the pending challenge for a source.
 * Returns null if no challenge or if expired.
 * @param {string} sourceId - Discord user ID or panel email
 * @param {'discord'|'panel'} [sourceType='discord']
 */
export function getPendingChallenge(sourceId, sourceType = 'discord') {
  const key = `${sourceType}:${sourceId}`;
  const challenge = pendingChallenges.get(key);
  if (!challenge) return null;
  if (Date.now() > challenge.expiresAt) {
    pendingChallenges.delete(key);
    return null;
  }
  return challenge;
}

/**
 * Verify a challenge code submitted from Minecraft chat.
 * Returns the matching challenge if code + player name match, or null.
 *
 * @param {string} minecraftName - The player who typed the command in MC chat
 * @param {string} code - The code they submitted
 * @returns {PendingChallenge | null}
 */
export function verifyChallenge(minecraftName, code) {
  const upperCode = code.toUpperCase();

  for (const [userId, challenge] of pendingChallenges) {
    // Expired?
    if (Date.now() > challenge.expiresAt) {
      pendingChallenges.delete(userId);
      continue;
    }

    // Code match?
    if (challenge.code !== upperCode) continue;

    // Player name must match (case-insensitive)
    if (challenge.minecraftName.toLowerCase() !== minecraftName.toLowerCase()) {
      audit('LINK_WRONG_PLAYER', {
        sourceType: challenge.sourceType,
        sourceId: challenge.sourceId,
        expectedPlayer: challenge.minecraftName,
        actualPlayer: minecraftName,
        code: upperCode,
      });
      return null; // wrong player — don't consume the code
    }

    // Match! Remove the challenge (one-time use)
    pendingChallenges.delete(userId);
    return challenge;
  }

  return null;
}

/**
 * Remove any pending challenge for a source.
 * @param {string} sourceId - Discord user ID or panel email
 * @param {'discord'|'panel'} [sourceType='discord']
 */
export function cancelChallenge(sourceId, sourceType = 'discord') {
  return pendingChallenges.delete(`${sourceType}:${sourceId}`);
}

/**
 * Clean up all expired challenges.
 */
export function cleanupExpiredChallenges() {
  const now = Date.now();
  for (const [userId, challenge] of pendingChallenges) {
    if (now > challenge.expiresAt) {
      pendingChallenges.delete(userId);
    }
  }
  if (pendingChallenges.size === 0) {
    stopCleanupTimer();
  }
}

/** Get the count of pending (non-expired) challenges. */
export function getPendingChallengeCount() {
  cleanupExpiredChallenges();
  return pendingChallenges.size;
}

function startCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupExpiredChallenges, 60_000); // every minute
  cleanupTimer.unref?.(); // don't keep process alive
}

function stopCleanupTimer() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
