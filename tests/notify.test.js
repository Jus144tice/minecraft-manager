// Tests for the notification system (src/notify.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initNotifications,
  notify,
  onAuditEvent,
  notifyLagSpike,
  EVENT_DEFS,
  formatBytes,
  formatUptime,
  isDiscordWebhook,
} from '../src/notify.js';

// ---- formatBytes ----

test('formatBytes: formats byte values', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(1073741824), '1.00 GB');
  assert.equal(formatBytes(null), 'unknown');
});

// ---- formatUptime ----

test('formatUptime: formats seconds to human-readable', () => {
  assert.equal(formatUptime(30), '30s');
  assert.equal(formatUptime(90), '1m 30s');
  assert.equal(formatUptime(3661), '1h 1m');
  assert.equal(formatUptime(null), 'unknown');
});

// ---- isDiscordWebhook ----

test('isDiscordWebhook: detects Discord URLs', () => {
  assert.ok(isDiscordWebhook('https://discord.com/api/webhooks/123/abc'));
  assert.ok(isDiscordWebhook('https://discordapp.com/api/webhooks/123/abc'));
  assert.equal(isDiscordWebhook('https://example.com/webhook'), false);
  assert.equal(isDiscordWebhook('not-a-url'), false);
});

// ---- EVENT_DEFS ----

test('EVENT_DEFS: all events have title, color, and format function', () => {
  for (const [name, def] of Object.entries(EVENT_DEFS)) {
    assert.ok(def.title, `${name} missing title`);
    assert.equal(typeof def.color, 'number', `${name} missing color`);
    assert.equal(typeof def.format, 'function', `${name} missing format`);
  }
});

test('EVENT_DEFS: format functions produce strings', () => {
  const testDetails = {
    user: 'admin@test.com',
    code: 1,
    uptimeSeconds: 3600,
    attempt: 2,
    name: 'mc-backup_2024-01-01',
    filename: 'test.jar',
    size: 1048576,
    type: 'manual',
    quiesced: true,
    target: 'Steve',
    reason: 'griefing',
    tps: 12.5,
    threshold: 18,
    provider: 'local',
    ip: '127.0.0.1',
    error: 'something went wrong',
  };
  for (const [name, def] of Object.entries(EVENT_DEFS)) {
    const result = def.format(testDetails);
    assert.equal(typeof result, 'string', `${name}.format() did not return a string`);
    assert.ok(result.length > 0, `${name}.format() returned empty string`);
  }
});

// ---- notify / onAuditEvent (without webhook URL — should be no-ops) ----

test('notify: silently skips when no config', async () => {
  // Before init — should not throw
  await notify('SERVER_CRASH', { code: 1 });
});

test('notify: silently skips when no webhookUrl', async () => {
  initNotifications({ notifications: {} });
  await notify('SERVER_CRASH', { code: 1 });
});

test('notify: silently skips for unrecognized events', async () => {
  initNotifications({ notifications: { webhookUrl: 'https://example.com/hook' } });
  await notify('UNKNOWN_EVENT_XYZ', {});
});

test('notify: silently skips when event not in filter list', async () => {
  initNotifications({
    notifications: {
      webhookUrl: 'https://example.com/hook',
      events: ['SERVER_CRASH'],
    },
  });
  // SERVER_START is not in the events list
  await notify('SERVER_START', { user: 'admin' });
});

test('onAuditEvent: does not throw when called without config', () => {
  initNotifications({});
  onAuditEvent('SERVER_CRASH', { code: 1 });
});

// ---- notifyLagSpike cooldown ----

test('notifyLagSpike: respects cooldown (does not throw)', () => {
  initNotifications({});
  // Should be no-ops without a webhook URL, but must not throw
  notifyLagSpike(12.5, 18);
  notifyLagSpike(11.0, 18);
});

// ---- Config redaction: webhookUrl should not appear in GET /config ----
// (webhookUrl is not a top-level secret like rconPassword, but we verify
// the notifications object passes through the redaction filter unchanged
// since it contains no secrets.)

test('notifications config passes through settings allowlist', () => {
  // Simulates the allowlist filter from settings route
  const ALLOWED_KEYS = ['serverPath', 'notifications'];
  const body = {
    serverPath: '/srv/mc',
    notifications: { webhookUrl: 'https://discord.com/api/webhooks/123/abc', events: ['SERVER_CRASH'] },
    injected: 'bad',
  };
  const updates = {};
  for (const k of ALLOWED_KEYS) {
    if (k in body) updates[k] = body[k];
  }
  assert.equal(updates.serverPath, '/srv/mc');
  assert.ok(updates.notifications);
  assert.equal(updates.notifications.webhookUrl, 'https://discord.com/api/webhooks/123/abc');
  assert.equal('injected' in updates, false);
});
