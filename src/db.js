// PostgreSQL persistence layer.
// Requires DATABASE_URL env var (e.g. postgres://user:pass@localhost:5432/mcmanager).
// When DATABASE_URL is not set the app continues without a database (demo-friendly).

import pg from 'pg';
import { info, warn } from './audit.js';

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

/** List all users ordered by admin_level desc, email asc. */
export async function listUsers() {
  if (!pool) return [];
  const { rows } = await pool.query('SELECT id, email, name, provider, admin_level, created_at, last_login_at FROM users ORDER BY admin_level DESC, email ASC');
  return rows;
}

/** Set a user's admin level (0 = regular, 1 = admin). */
export async function setAdminLevel(email, level) {
  if (!pool) return null;
  const { rows } = await pool.query(
    'UPDATE users SET admin_level = $2 WHERE email = $1 RETURNING *',
    [email, level],
  );
  return rows[0] || null;
}

/** Count the number of admin users (admin_level >= 1). */
export async function countAdmins() {
  if (!pool) return 0;
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM users WHERE admin_level >= 1');
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
    await pool.query(
      'INSERT INTO audit_logs (action, user_email, ip, details) VALUES ($1, $2, $3, $4)',
      [action, userEmail, ip || null, JSON.stringify(rest)],
    );
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
    `SELECT * FROM audit_logs ${where} ORDER BY timestamp DESC LIMIT $${idx++} OFFSET $${idx++}`,
    params,
  );
  return rows;
}

export async function shutdownDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
