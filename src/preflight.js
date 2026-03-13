// Preflight checks — runtime diagnostics for common misconfigurations.
// Returns an array of { level, id, title, detail } objects.
// level: 'error' (will break), 'warn' (may cause issues), 'ok' (passed)

import { existsSync } from 'fs';
import { access, stat, constants } from 'fs/promises';
import { execFile } from 'child_process';
import path from 'path';

/**
 * Run all preflight checks against the current config and environment.
 * Returns { checks: [...], passed, warned, failed }.
 */
export async function runPreflight(config) {
  const checks = [];

  // Skip most checks in demo mode — only flag that demo is on
  if (config.demoMode) {
    checks.push({
      level: 'warn',
      id: 'demo-mode',
      title: 'Demo mode is enabled',
      detail:
        'The panel is showing seed data, not a real server. Disable demo mode in Settings \u2192 App Config when ready for production.',
    });
    return summarize(checks);
  }

  // ---- Server path ----
  if (config.serverPath) {
    if (existsSync(config.serverPath)) {
      try {
        const s = await stat(config.serverPath);
        if (!s.isDirectory()) {
          checks.push({
            level: 'error',
            id: 'server-path-not-dir',
            title: 'serverPath is not a directory',
            detail: `"${config.serverPath}" exists but is a file, not a directory.`,
          });
        } else {
          checks.push({ level: 'ok', id: 'server-path', title: 'Server path exists', detail: config.serverPath });
        }
      } catch {
        checks.push({
          level: 'error',
          id: 'server-path-access',
          title: 'Cannot access serverPath',
          detail: `"${config.serverPath}" exists but is not accessible. Check permissions.`,
        });
      }
    } else {
      checks.push({
        level: 'error',
        id: 'server-path-missing',
        title: 'Server path does not exist',
        detail: `"${config.serverPath}" was not found. Create the directory or update serverPath in config.json.`,
      });
    }
  }

  // ---- Launch config ----
  if (config.launch?.executable) {
    const found = await isExecutableOnPath(config.launch.executable);
    if (found) {
      checks.push({
        level: 'ok',
        id: 'launch-executable',
        title: 'Launch executable found',
        detail: `"${config.launch.executable}" is available.`,
      });
    } else {
      checks.push({
        level: 'error',
        id: 'launch-executable-missing',
        title: 'Launch executable not found',
        detail: `"${config.launch.executable}" was not found on PATH. Install it or use an absolute path in launch.executable.`,
      });
    }
  }

  // ---- RCON ----
  if (!config.rconPassword || config.rconPassword === 'your-rcon-password-here') {
    checks.push({
      level: 'warn',
      id: 'rcon-password',
      title: 'RCON password not configured',
      detail:
        'Set rconPassword in config.json to match rcon.password in server.properties. Without RCON, the panel cannot send commands to the server.',
    });
  } else {
    checks.push({ level: 'ok', id: 'rcon-password', title: 'RCON password configured', detail: '' });
  }

  // ---- Backup path ----
  if (config.backupEnabled) {
    const bp = config.backupPath;
    if (!bp) {
      checks.push({
        level: 'warn',
        id: 'backup-path-empty',
        title: 'Backup path not set',
        detail:
          'Scheduled backups are enabled but no backup path is configured. Backups will use the default ./backups directory.',
      });
    } else if (!existsSync(bp)) {
      checks.push({
        level: 'error',
        id: 'backup-path-missing',
        title: 'Backup path does not exist',
        detail: `"${bp}" was not found. Create the directory or update backupPath in config.json.`,
      });
    } else {
      try {
        await access(bp, constants.W_OK);
        checks.push({ level: 'ok', id: 'backup-path', title: 'Backup path is writable', detail: bp });
      } catch {
        checks.push({
          level: 'error',
          id: 'backup-path-readonly',
          title: 'Backup path is not writable',
          detail: `"${bp}" exists but the process cannot write to it. Check directory permissions.`,
        });
      }
    }
  } else {
    checks.push({
      level: 'warn',
      id: 'backup-disabled',
      title: 'Scheduled backups are disabled',
      detail: 'Enable scheduled backups in Settings \u2192 App Config for automatic disaster recovery.',
    });
  }

  // ---- Bind host ----
  const bindHost = process.env.BIND_HOST || config.bindHost || '127.0.0.1';
  if (bindHost === '0.0.0.0') {
    checks.push({
      level: 'warn',
      id: 'bind-insecure',
      title: 'Panel is bound to all interfaces',
      detail:
        'bindHost is 0.0.0.0 \u2014 the panel is accessible from the network without HTTPS. Use 127.0.0.1 behind a reverse proxy for production.',
    });
  } else {
    checks.push({
      level: 'ok',
      id: 'bind-host',
      title: 'Panel bound to localhost',
      detail: `Listening on ${bindHost} (requires reverse proxy for external access).`,
    });
  }

  // ---- SESSION_SECRET ----
  if (!process.env.SESSION_SECRET) {
    checks.push({
      level: 'error',
      id: 'session-secret',
      title: 'SESSION_SECRET is not set',
      detail:
        'Session cookies are signed with a temporary secret and will not survive restarts. Set SESSION_SECRET in your environment.',
    });
  } else {
    checks.push({ level: 'ok', id: 'session-secret', title: 'SESSION_SECRET is set', detail: '' });
  }

  // ---- APP_URL ----
  if (!process.env.APP_URL) {
    checks.push({
      level: 'warn',
      id: 'app-url',
      title: 'APP_URL is not set',
      detail:
        'WebSocket origin checks fall back to the Host header. OIDC callbacks will not work. Set APP_URL to your public base URL.',
    });
  } else {
    checks.push({ level: 'ok', id: 'app-url', title: 'APP_URL is set', detail: process.env.APP_URL });
  }

  // ---- Auth providers ----
  const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const hasMicrosoft = !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
  const hasLocalPw = !!process.env.LOCAL_PASSWORD;

  if (!hasGoogle && !hasMicrosoft && !hasLocalPw) {
    checks.push({
      level: 'warn',
      id: 'no-auth',
      title: 'No authentication provider configured',
      detail:
        'Neither OIDC (Google/Microsoft) nor LOCAL_PASSWORD is set. Users will not be able to log in. Configure at least one provider.',
    });
  } else {
    const providers = [];
    if (hasGoogle) providers.push('Google');
    if (hasMicrosoft) providers.push('Microsoft');
    if (hasLocalPw) providers.push('Local password');
    checks.push({
      level: 'ok',
      id: 'auth-providers',
      title: 'Authentication configured',
      detail: providers.join(', '),
    });
  }

  // ---- ALLOWED_EMAILS ----
  if ((hasGoogle || hasMicrosoft) && !process.env.ALLOWED_EMAILS) {
    checks.push({
      level: 'warn',
      id: 'allowed-emails',
      title: 'ALLOWED_EMAILS is not set',
      detail:
        'Anyone with a Google or Microsoft account can log in. Set ALLOWED_EMAILS to restrict access to specific email addresses.',
    });
  }

  // ---- TRUST_PROXY ----
  if (bindHost === '127.0.0.1' && process.env.TRUST_PROXY !== '1') {
    checks.push({
      level: 'warn',
      id: 'trust-proxy',
      title: 'TRUST_PROXY is not set',
      detail:
        'The panel is bound to localhost (likely behind a reverse proxy) but TRUST_PROXY is not "1". Client IP detection and secure cookies may not work correctly.',
    });
  }

  // ---- server.properties RCON check ----
  if (config.serverPath) {
    const propsPath = path.join(config.serverPath, 'server.properties');
    if (existsSync(propsPath)) {
      try {
        const { readFile } = await import('fs/promises');
        const props = await readFile(propsPath, 'utf8');
        if (!props.includes('enable-rcon=true')) {
          checks.push({
            level: 'warn',
            id: 'rcon-disabled-props',
            title: 'RCON may not be enabled in server.properties',
            detail:
              'enable-rcon=true was not found in server.properties. The panel needs RCON to send commands to the server.',
          });
        }
      } catch {
        /* can't read server.properties — not fatal */
      }
    }
  }

  return summarize(checks);
}

function summarize(checks) {
  return {
    checks,
    passed: checks.filter((c) => c.level === 'ok').length,
    warned: checks.filter((c) => c.level === 'warn').length,
    failed: checks.filter((c) => c.level === 'error').length,
  };
}

/** Check if an executable is available on PATH. */
function isExecutableOnPath(name) {
  // If it's an absolute path, just check existence
  if (path.isAbsolute(name)) {
    return Promise.resolve(existsSync(name));
  }
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(cmd, [name], (err) => resolve(!err));
  });
}
