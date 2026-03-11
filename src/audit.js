// Structured audit and application logging.
// Writes JSON lines to stdout — captured by systemd/journald in production.
// When PostgreSQL is available, audit entries are also persisted to the audit_logs table.
// NEVER log passwords, tokens, raw cookie values, or RCON passwords here.

import { insertAuditLog } from './db.js';

export function audit(action, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    level: 'AUDIT',
    action,
    ...details,
  };
  console.log(JSON.stringify(entry));

  // Fire-and-forget write to DB (never blocks the caller)
  insertAuditLog(action, details);
}

export function info(message, details = {}) {
  const entry = { time: new Date().toISOString(), level: 'INFO', message, ...details };
  console.log(JSON.stringify(entry));
}

export function warn(message, details = {}) {
  const entry = { time: new Date().toISOString(), level: 'WARN', message, ...details };
  console.warn(JSON.stringify(entry));
}
