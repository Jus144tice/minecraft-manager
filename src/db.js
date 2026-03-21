// PostgreSQL persistence layer.
// Requires DATABASE_URL env var (e.g. postgres://user:pass@localhost:5432/mcmanager).
// When DATABASE_URL is not set the app continues without a database (demo-friendly).

import pg from 'pg';
import { info, warn } from './audit.js';
import { adminLevelToRole, roleToAdminLevel, ROLE_ORDER } from './permissions.js';

const { Pool } = pg;

let pool = null;

// ---- Schema ----

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT 'local',
  admin_level   INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL DEFAULT 'viewer',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         SERIAL PRIMARY KEY,
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action     TEXT NOT NULL,
  user_email TEXT,
  ip         TEXT,
  details    JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action    ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user      ON audit_logs (user_email);

CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);

CREATE TABLE IF NOT EXISTS discord_links (
  discord_id     TEXT NOT NULL PRIMARY KEY,
  minecraft_name TEXT NOT NULL,
  linked_by      TEXT NOT NULL DEFAULT 'self',
  linked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_discord_links_mc_name ON discord_links (minecraft_name);

CREATE TABLE IF NOT EXISTS panel_links (
  user_email      TEXT NOT NULL PRIMARY KEY,
  minecraft_name  TEXT NOT NULL,
  linked_by       TEXT NOT NULL DEFAULT 'self',
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_panel_links_mc_name ON panel_links (minecraft_name);

CREATE TABLE IF NOT EXISTS mod_cache (
  sha1       TEXT NOT NULL PRIMARY KEY,
  found      BOOLEAN NOT NULL,
  metadata   JSONB,
  cached_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// ---- Lifecycle ----

export async function initDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    warn('DATABASE_URL not set — running without PostgreSQL (sessions stay in-memory, audit logs go to stdout only)');
    return false;
  }

  pool = new Pool({ connectionString: url });

  // Verify connectivity
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);

    // --- Migration: add `role` column if missing (upgrades from pre-RBAC schema) ---
    const { rows: cols } = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'role'`,
    );
    if (cols.length === 0) {
      await client.query(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'`);
      // Migrate existing admin_level values to role names
      await client.query(`UPDATE users SET role = 'admin' WHERE admin_level >= 1`);
      info('Migrated users table: added role column from admin_level');
    }

    info('PostgreSQL connected and schema initialised');
  } finally {
    client.release();
  }

  return true;
}

export function getPool() {
  return pool;
}

export function isConnected() {
  return pool !== null;
}

// ---- User helpers ----

/** Upsert a user on login — creates if new, updates name/provider/last_login_at if existing. */
export async function upsertUser(email, name, provider) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, provider, last_login_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           provider = EXCLUDED.provider,
           last_login_at = NOW()
     RETURNING *`,
    [email, name, provider],
  );
  return rows[0];
}

/** Get a single user by email. */
export async function getUser(email) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

/** List all users ordered by role level desc, email asc. */
export async function listUsers() {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, email, name, provider, admin_level, role, created_at, last_login_at
     FROM users ORDER BY admin_level DESC, email ASC`,
  );
  return rows;
}

/** Set a user's admin level (0 = regular, 1 = admin). Also updates role for consistency. */
export async function setAdminLevel(email, level) {
  if (!pool) return null;
  const role = adminLevelToRole(level);
  const { rows } = await pool.query('UPDATE users SET admin_level = $2, role = $3 WHERE email = $1 RETURNING *', [
    email,
    level,
    role,
  ]);
  return rows[0] || null;
}

/** Set a user's role directly. Also updates admin_level for backward compatibility. */
export async function setUserRole(email, roleName) {
  if (!pool) return null;
  if (!ROLE_ORDER.includes(roleName)) return null;
  const adminLevel = roleToAdminLevel(roleName);
  const { rows } = await pool.query('UPDATE users SET role = $2, admin_level = $3 WHERE email = $1 RETURNING *', [
    email,
    roleName,
    adminLevel,
  ]);
  return rows[0] || null;
}

/** Count the number of admin-or-above users. */
export async function countAdmins() {
  if (!pool) return 0;
  const { rows } = await pool.query("SELECT COUNT(*) AS count FROM users WHERE role IN ('admin', 'owner')");
  return parseInt(rows[0].count, 10);
}

/** Delete a user by email. */
export async function deleteUser(email) {
  if (!pool) return false;
  const { rowCount } = await pool.query('DELETE FROM users WHERE email = $1', [email]);
  return rowCount > 0;
}

// ---- Audit log helpers ----

/** Insert an audit log entry into the database. */
export async function insertAuditLog(action, details = {}) {
  if (!pool) return;
  const { user, email, ip, ...rest } = details;
  const userEmail = user || email || null;
  try {
    await pool.query('INSERT INTO audit_logs (action, user_email, ip, details) VALUES ($1, $2, $3, $4)', [
      action,
      userEmail,
      ip || null,
      JSON.stringify(rest),
    ]);
  } catch (err) {
    // Never let a DB write failure break the app — fall back to stdout-only
    console.error('[DB] Failed to write audit log:', err.message);
  }
}

/** Query audit logs with optional filters. */
export async function queryAuditLogs({ action, email, limit = 100, offset = 0 } = {}) {
  if (!pool) return [];
  const conditions = [];
  const params = [];
  let idx = 1;

  if (action) {
    conditions.push(`action = $${idx++}`);
    params.push(action);
  }
  if (email) {
    conditions.push(`user_email = $${idx++}`);
    params.push(email);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT * FROM audit_logs ${where} ORDER BY timestamp DESC LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );
  return rows;
}

// ---- Discord link helpers ----

/** Upsert a Discord-to-Minecraft account link. */
export async function upsertDiscordLink(discordId, minecraftName, linkedBy) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO discord_links (discord_id, minecraft_name, linked_by, linked_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (discord_id) DO UPDATE
       SET minecraft_name = EXCLUDED.minecraft_name,
           linked_by = EXCLUDED.linked_by,
           linked_at = NOW()
     RETURNING *`,
    [discordId, minecraftName, linkedBy],
  );
  return rows[0];
}

/** Get a Discord link by Discord user ID. */
export async function getDiscordLink(discordId) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT * FROM discord_links WHERE discord_id = $1', [discordId]);
  return rows[0] || null;
}

/** Get all Discord links. */
export async function listDiscordLinks() {
  if (!pool) return [];
  const { rows } = await pool.query('SELECT * FROM discord_links ORDER BY linked_at DESC');
  return rows;
}

/** Find a Discord link by Minecraft name. */
export async function getDiscordLinkByMinecraftName(minecraftName) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT * FROM discord_links WHERE LOWER(minecraft_name) = LOWER($1)', [
    minecraftName,
  ]);
  return rows[0] || null;
}

/** Delete a Discord link. Returns true if a row was deleted. */
export async function deleteDiscordLink(discordId) {
  if (!pool) return false;
  const { rowCount } = await pool.query('DELETE FROM discord_links WHERE discord_id = $1', [discordId]);
  return rowCount > 0;
}

// ---- Panel link helpers ----

/** Upsert a panel-user-to-Minecraft account link. */
export async function upsertPanelLink(email, minecraftName, linkedBy, verified = false) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO panel_links (user_email, minecraft_name, linked_by, verified, linked_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_email) DO UPDATE
       SET minecraft_name = EXCLUDED.minecraft_name,
           linked_by = EXCLUDED.linked_by,
           verified = EXCLUDED.verified,
           linked_at = NOW()
     RETURNING *`,
    [email, minecraftName, linkedBy, verified],
  );
  return rows[0];
}

/** Get a panel link by user email. */
export async function getPanelLink(email) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT * FROM panel_links WHERE user_email = $1', [email]);
  return rows[0] || null;
}

/** Get all panel links. */
export async function listPanelLinks() {
  if (!pool) return [];
  const { rows } = await pool.query('SELECT * FROM panel_links ORDER BY linked_at DESC');
  return rows;
}

/** Find a panel link by Minecraft name. */
export async function getPanelLinkByMinecraftName(minecraftName) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT * FROM panel_links WHERE LOWER(minecraft_name) = LOWER($1)', [
    minecraftName,
  ]);
  return rows[0] || null;
}

/** Delete a panel link. Returns true if a row was deleted. */
export async function deletePanelLink(email) {
  if (!pool) return false;
  const { rowCount } = await pool.query('DELETE FROM panel_links WHERE user_email = $1', [email]);
  return rowCount > 0;
}

// ---- Mod Cache ----

/** Batch-lookup cached mod metadata by SHA1 hashes. Returns rows for hashes that exist in cache. */
export async function getModCacheBatch(hashes) {
  if (!pool || hashes.length === 0) return [];
  const { rows } = await pool.query('SELECT sha1, found, metadata, cached_at FROM mod_cache WHERE sha1 = ANY($1)', [
    hashes,
  ]);
  return rows;
}

/** Upsert a single mod cache entry. */
export async function upsertModCache(sha1, found, metadata) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO mod_cache (sha1, found, metadata, cached_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (sha1) DO UPDATE SET found = $2, metadata = $3, cached_at = NOW()`,
    [sha1, found, metadata ? JSON.stringify(metadata) : null],
  );
}

/** Upsert multiple mod cache entries in a single transaction. */
export async function upsertModCacheBatch(entries) {
  if (!pool || entries.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { sha1, found, metadata } of entries) {
      await client.query(
        `INSERT INTO mod_cache (sha1, found, metadata, cached_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (sha1) DO UPDATE SET found = $2, metadata = $3, cached_at = NOW()`,
        [sha1, found, metadata ? JSON.stringify(metadata) : null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Delete a single mod cache entry. */
export async function deleteModCache(sha1) {
  if (!pool) return;
  await pool.query('DELETE FROM mod_cache WHERE sha1 = $1', [sha1]);
}

/** Clear all mod cache entries. */
export async function clearModCache() {
  if (!pool) return;
  await pool.query('DELETE FROM mod_cache');
}

export async function shutdownDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
