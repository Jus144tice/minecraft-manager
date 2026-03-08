// Structured audit and application logging.
// Writes JSON lines to stdout — captured by systemd/journald in production.
// NEVER log passwords, tokens, raw cookie values, or RCON passwords here.

export function audit(action, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    level: 'AUDIT',
    action,
    ...details,
  };
  console.log(JSON.stringify(entry));
}

export function info(message, details = {}) {
  const entry = { time: new Date().toISOString(), level: 'INFO', message, ...details };
  console.log(JSON.stringify(entry));
}

export function warn(message, details = {}) {
  const entry = { time: new Date().toISOString(), level: 'WARN', message, ...details };
  console.warn(JSON.stringify(entry));
}
