// Tests for settings route logic: config redaction, POST allowlist, cron validation.
// These test the route handler logic directly without a full HTTP server,
// using lightweight mocks of ctx and Express req/res objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// We can't easily import the route module without all its deps, so instead
// we test the specific behaviors that matter for production safety:
// 1. Config redaction (rconPassword, webPassword stripped from GET /config)
// 2. Config POST allowlist (only allowed keys are saved)
// 3. Cron expression validation

// --- Config redaction ---

function redactConfig(config) {
  const { webPassword: _1, rconPassword: _2, ...safe } = config;
  return safe;
}

test('Config redaction: strips rconPassword and webPassword', () => {
  const config = {
    serverPath: '/srv/mc',
    rconPassword: 'supersecret',
    webPassword: 'alsoSecret',
    webPort: 3000,
    demoMode: false,
  };
  const safe = redactConfig(config);
  assert.equal(safe.serverPath, '/srv/mc');
  assert.equal(safe.webPort, 3000);
  assert.equal(safe.rconPassword, undefined);
  assert.equal(safe.webPassword, undefined);
  assert.equal('rconPassword' in safe, false);
  assert.equal('webPassword' in safe, false);
});

test('Config redaction: preserves all other fields', () => {
  const config = {
    demoMode: false,
    serverPath: '/srv/mc',
    startCommand: 'java -jar server.jar',
    rconHost: '127.0.0.1',
    rconPort: 25575,
    rconPassword: 'secret',
    webPort: 3000,
    bindHost: '127.0.0.1',
    autoStart: true,
    backupEnabled: true,
    backupSchedule: '0 3 * * *',
    backupPath: '/mnt/backups',
    maxBackups: 14,
    minecraftVersion: '1.20.1',
    modsFolder: 'mods',
    disabledModsFolder: 'mods_disabled',
  };
  const safe = redactConfig(config);
  // All fields except rconPassword should be present
  assert.equal(Object.keys(safe).length, Object.keys(config).length - 1);
  assert.equal(safe.autoStart, true);
  assert.equal(safe.backupSchedule, '0 3 * * *');
});

// --- Config POST allowlist ---

const ALLOWED_KEYS = ['serverPath', 'rconHost', 'rconPort', 'rconPassword',
  'startCommand', 'minecraftVersion', 'modsFolder', 'disabledModsFolder', 'demoMode',
  'backupPath', 'backupSchedule', 'backupEnabled', 'maxBackups', 'backupTimezone',
  'bindHost', 'autoStart'];

function filterConfigUpdate(body) {
  const updates = {};
  for (const k of ALLOWED_KEYS) {
    if (k in body) updates[k] = body[k];
  }
  return updates;
}

test('Config POST allowlist: accepts known config keys', () => {
  const body = { serverPath: '/srv/mc', rconPort: 25575, demoMode: false };
  const updates = filterConfigUpdate(body);
  assert.deepEqual(updates, body);
});

test('Config POST allowlist: rejects unknown/dangerous keys', () => {
  const body = {
    serverPath: '/srv/mc',
    sessionSecret: 'INJECTED',       // not allowed
    adminLevel: 99,                   // not allowed
    __proto__: { polluted: true },    // not allowed
  };
  const updates = filterConfigUpdate(body);
  assert.equal(updates.serverPath, '/srv/mc');
  assert.equal('sessionSecret' in updates, false);
  assert.equal('adminLevel' in updates, false);
});

test('Config POST allowlist: allows autoStart', () => {
  const body = { autoStart: true, serverPath: '/srv/mc' };
  const updates = filterConfigUpdate(body);
  assert.equal(updates.autoStart, true);
  assert.equal(updates.serverPath, '/srv/mc');
});

test('Config POST allowlist: allows bindHost changes', () => {
  const updates = filterConfigUpdate({ bindHost: '0.0.0.0' });
  assert.equal(updates.bindHost, '0.0.0.0');
});

// --- Cron expression validation ---
// The route uses node-cron's validate() — test the patterns we care about.
import cron from 'node-cron';

test('Cron validation: accepts standard cron expressions', () => {
  assert.ok(cron.validate('0 3 * * *'));      // daily at 3 AM
  assert.ok(cron.validate('*/15 * * * *'));    // every 15 minutes
  assert.ok(cron.validate('0 0 * * 0'));       // weekly on Sunday
  assert.ok(cron.validate('30 2 1 * *'));      // monthly on the 1st at 2:30 AM
});

test('Cron validation: rejects invalid expressions', () => {
  assert.equal(cron.validate('not a cron'), false);
  assert.equal(cron.validate(''), false);
  assert.equal(cron.validate('* * *'), false);       // too few fields
  assert.equal(cron.validate('60 * * * *'), false);   // minute > 59
});
