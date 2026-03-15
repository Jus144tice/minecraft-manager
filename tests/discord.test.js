// Tests for the Discord integration module.
// Covers config validation, permission checks, command routing,
// notification no-ops, and handler service delegation.
// All Discord APIs are mocked — no real Discord connection needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================
// Config validation
// ============================================================

import { buildDiscordConfig, validateDiscordConfig } from '../src/integrations/discord/config.js';

test('Discord config: disabled when no bot token', () => {
  // Clear env vars that might leak from the environment
  const saved = { ...process.env };
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;

  const result = buildDiscordConfig({});
  assert.equal(result.enabled, false);

  // Restore
  Object.assign(process.env, saved);
});

test('Discord config: disabled when enabled=false in config', () => {
  const saved = { ...process.env };
  process.env.DISCORD_BOT_TOKEN = 'test-token';
  process.env.DISCORD_APPLICATION_ID = '123456789012345678';

  const result = buildDiscordConfig({ discord: { enabled: false } });
  assert.equal(result.enabled, false);

  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;
  Object.assign(process.env, saved);
});

test('Discord config: enabled with valid token and application ID', () => {
  const saved = { ...process.env };
  process.env.DISCORD_BOT_TOKEN = 'test-token-value';
  process.env.DISCORD_APPLICATION_ID = '123456789012345678';

  const result = buildDiscordConfig({
    discord: {
      guildId: '987654321098765432',
      adminRoleIds: ['111111111111111111'],
      notificationChannelId: '222222222222222222',
    },
  });

  assert.equal(result.enabled, true);
  assert.equal(result.guildId, '987654321098765432');
  assert.deepEqual(result.adminRoleIds, ['111111111111111111']);
  assert.equal(result.notificationChannelId, '222222222222222222');
  assert.equal(result.ephemeralReplies, true); // default
  assert.equal(result.allowDMs, false); // default

  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;
  Object.assign(process.env, saved);
});

test('Discord config: validates snowflake IDs', () => {
  const errors = validateDiscordConfig({
    botToken: 'token',
    applicationId: 'not-a-snowflake',
    guildId: 'also-bad',
    adminRoleIds: ['bad-role'],
    allowedRoleIds: [],
    notificationChannelId: '123',
    commandChannelIds: [],
  });
  assert.ok(errors.length >= 3, `Expected at least 3 errors, got ${errors.length}: ${errors.join('; ')}`);
  assert.ok(errors.some((e) => e.includes('applicationId')));
  assert.ok(errors.some((e) => e.includes('guildId')));
  assert.ok(errors.some((e) => e.includes('admin role')));
});

test('Discord config: no errors for valid config', () => {
  const errors = validateDiscordConfig({
    botToken: 'valid-token',
    applicationId: '123456789012345678',
    guildId: '987654321098765432',
    adminRoleIds: ['111111111111111111'],
    allowedRoleIds: [],
    notificationChannelId: '222222222222222222',
    commandChannelIds: [],
  });
  assert.equal(errors.length, 0);
});

test('Discord config: env vars take precedence', () => {
  const saved = { ...process.env };
  process.env.DISCORD_BOT_TOKEN = 'env-token';
  process.env.DISCORD_APPLICATION_ID = '123456789012345678';
  process.env.DISCORD_GUILD_ID = '999999999999999999';
  process.env.DISCORD_ADMIN_ROLE_IDS = '111111111111111111,222222222222222222';

  const result = buildDiscordConfig({
    discord: {
      guildId: '000000000000000000', // should be overridden by env
      adminRoleIds: ['333333333333333333'], // should be overridden by env
    },
  });

  assert.equal(result.enabled, true);
  assert.equal(result.guildId, '999999999999999999');
  assert.deepEqual(result.adminRoleIds, ['111111111111111111', '222222222222222222']);

  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;
  delete process.env.DISCORD_GUILD_ID;
  delete process.env.DISCORD_ADMIN_ROLE_IDS;
  Object.assign(process.env, saved);
});

// ============================================================
// Permissions
// ============================================================

import { checkPermission, PermissionLevel } from '../src/integrations/discord/permissions.js';

function mockInteraction({
  userId = '123',
  username = 'testuser',
  guildId = '456',
  channelId = '789',
  commandName = 'status',
  roles = [],
} = {}) {
  return {
    user: { id: userId, tag: username, username },
    guildId,
    channelId,
    commandName,
    member: {
      roles: {
        cache: new Map(roles.map((r) => [r, { id: r }])),
      },
    },
  };
}

const baseDiscordConfig = {
  guildId: '456',
  adminRoleIds: ['admin-role-1'],
  allowedRoleIds: [],
  commandChannelIds: [],
  allowDMs: false,
};

test('Permissions: READ_ONLY allowed for any guild member', () => {
  const result = checkPermission(mockInteraction(), PermissionLevel.READ_ONLY, baseDiscordConfig);
  assert.equal(result.allowed, true);
});

test('Permissions: ADMIN denied without admin role', () => {
  const result = checkPermission(mockInteraction(), PermissionLevel.ADMIN, baseDiscordConfig);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('permission'));
});

test('Permissions: ADMIN allowed with admin role', () => {
  const result = checkPermission(
    mockInteraction({ roles: ['admin-role-1'] }),
    PermissionLevel.ADMIN,
    baseDiscordConfig,
  );
  assert.equal(result.allowed, true);
});

test('Permissions: DMs blocked by default', () => {
  const result = checkPermission(mockInteraction({ guildId: null }), PermissionLevel.READ_ONLY, baseDiscordConfig);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('DM'));
});

test('Permissions: DMs allowed when configured', () => {
  const result = checkPermission(mockInteraction({ guildId: null }), PermissionLevel.READ_ONLY, {
    ...baseDiscordConfig,
    allowDMs: true,
  });
  assert.equal(result.allowed, true);
});

test('Permissions: wrong guild blocked', () => {
  const result = checkPermission(mockInteraction({ guildId: '999' }), PermissionLevel.READ_ONLY, baseDiscordConfig);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('not configured'));
});

test('Permissions: wrong channel blocked', () => {
  const config = { ...baseDiscordConfig, commandChannelIds: ['allowed-channel'] };
  const result = checkPermission(mockInteraction({ channelId: '789' }), PermissionLevel.READ_ONLY, config);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('channel'));
});

test('Permissions: ADMIN denied when no admin roles configured', () => {
  const config = { ...baseDiscordConfig, adminRoleIds: [] };
  const result = checkPermission(mockInteraction(), PermissionLevel.ADMIN, config);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('No admin roles'));
});

// ============================================================
// Command registry
// ============================================================

import {
  registerCommand,
  getCommands,
  getCommandsByPermission,
  getCommandsJSON,
} from '../src/integrations/discord/registry.js';
import { SlashCommandBuilder } from 'discord.js';

test('Registry: can register and retrieve commands', () => {
  // Registry may have commands from handler imports, so just test our addition
  const testBuilder = new SlashCommandBuilder().setName('test-cmd').setDescription('Test');
  registerCommand('test-cmd', {
    permission: PermissionLevel.READ_ONLY,
    builder: testBuilder,
    handler: async () => {},
  });

  const cmds = getCommands();
  assert.ok(cmds.has('test-cmd'));
  assert.equal(cmds.get('test-cmd').permission, PermissionLevel.READ_ONLY);
});

test('Registry: getCommandsByPermission filters correctly', () => {
  registerCommand('test-read', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder().setName('test-read').setDescription('Read'),
    handler: async () => {},
  });
  registerCommand('test-admin', {
    permission: PermissionLevel.ADMIN,
    builder: new SlashCommandBuilder().setName('test-admin').setDescription('Admin'),
    handler: async () => {},
  });

  const readCmds = getCommandsByPermission(PermissionLevel.READ_ONLY);
  const adminCmds = getCommandsByPermission(PermissionLevel.ADMIN);

  // READ_ONLY filter should only include read-only commands
  assert.ok(readCmds.every((c) => c.permission === PermissionLevel.READ_ONLY));
  // ADMIN filter should include both
  assert.ok(adminCmds.length >= readCmds.length);
});

test('Registry: getCommandsJSON returns valid JSON array', () => {
  const json = getCommandsJSON();
  assert.ok(Array.isArray(json));
  assert.ok(json.length > 0);
  // Each entry should have a name
  for (const cmd of json) {
    assert.ok(typeof cmd.name === 'string');
    assert.ok(cmd.name.length > 0);
  }
});

// ============================================================
// Command routing (handleInteraction)
// ============================================================

import { handleInteraction } from '../src/integrations/discord/commands.js';

test('Command router: dispatches to registered handler', async () => {
  let handlerCalled = false;
  registerCommand('test-dispatch', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder().setName('test-dispatch').setDescription('Test dispatch'),
    handler: async () => {
      handlerCalled = true;
    },
  });

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'test-dispatch',
    user: { id: '123', tag: 'user#0001', username: 'user' },
    guildId: '456',
    channelId: '789',
    member: { roles: { cache: new Map() } },
    options: { data: [] },
    client: { _discordConfig: baseDiscordConfig },
    reply: async () => {},
    editReply: async () => {},
    deferred: false,
    replied: false,
  };

  await handleInteraction(interaction);
  assert.ok(handlerCalled, 'Handler should have been called');
});

test('Command router: denies admin command without role', async () => {
  registerCommand('test-admin-deny', {
    permission: PermissionLevel.ADMIN,
    builder: new SlashCommandBuilder().setName('test-admin-deny').setDescription('Admin deny test'),
    handler: async () => {
      assert.fail('Handler should not be called');
    },
  });

  let replyContent = '';
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'test-admin-deny',
    user: { id: '123', tag: 'user#0001', username: 'user' },
    guildId: '456',
    channelId: '789',
    member: { roles: { cache: new Map() } },
    options: { data: [] },
    client: { _discordConfig: baseDiscordConfig },
    reply: async (opts) => {
      replyContent = typeof opts === 'string' ? opts : opts.content;
    },
    deferred: false,
    replied: false,
  };

  await handleInteraction(interaction);
  assert.ok(replyContent.includes('permission'), `Expected permission denied message, got: "${replyContent}"`);
});

test('Command router: ignores non-chat-input interactions', async () => {
  const interaction = {
    isChatInputCommand: () => false,
    commandName: 'anything',
  };
  // Should not throw
  await handleInteraction(interaction);
});

// ============================================================
// Notifications
// ============================================================

import {
  sendDiscordNotification,
  initDiscordNotifications,
  stopDiscordNotifications,
  EVENT_TEMPLATES,
} from '../src/integrations/discord/notifications.js';

test('Notifications: no-op when not initialized', async () => {
  stopDiscordNotifications();
  // Should not throw
  await sendDiscordNotification('SERVER_START', { user: 'test' });
});

test('Notifications: EVENT_TEMPLATES has expected events', () => {
  const expected = ['SERVER_START', 'SERVER_STOP', 'SERVER_CRASH', 'BACKUP_CREATE', 'BACKUP_FAILED'];
  for (const event of expected) {
    assert.ok(EVENT_TEMPLATES[event], `Missing event template: ${event}`);
    assert.ok(typeof EVENT_TEMPLATES[event].title === 'string');
    assert.ok(typeof EVENT_TEMPLATES[event].format === 'function');
    assert.ok(typeof EVENT_TEMPLATES[event].color === 'number');
  }
});

test('Notifications: format functions produce strings', () => {
  for (const [name, template] of Object.entries(EVENT_TEMPLATES)) {
    const result = template.format({
      user: 'test',
      code: 1,
      uptimeSeconds: 3600,
      error: 'test',
      tps: 15,
      threshold: 18,
      name: 'backup',
      size: 1048576,
      type: 'manual',
      attempt: 1,
    });
    assert.ok(typeof result === 'string', `${name} format should return a string, got ${typeof result}`);
    assert.ok(result.length > 0, `${name} format should return non-empty string`);
  }
});

test('Notifications: sends to channel when initialized', async () => {
  let sentEmbed = null;
  const mockChannel = {
    send: async ({ embeds }) => {
      sentEmbed = embeds[0];
    },
  };
  const mockClient = {
    channels: {
      fetch: async () => mockChannel,
    },
  };

  initDiscordNotifications(mockClient, '222222222222222222');
  await sendDiscordNotification('SERVER_START', { user: 'admin' });

  assert.ok(sentEmbed, 'Should have sent an embed');
  assert.ok(sentEmbed.data.title === 'Server Started');

  stopDiscordNotifications();
});

test('Notifications: handles missing channel gracefully', async () => {
  const mockClient = {
    channels: {
      fetch: async () => null,
    },
  };

  initDiscordNotifications(mockClient, '222222222222222222');
  // Should not throw
  await sendDiscordNotification('SERVER_START', { user: 'test' });
  stopDiscordNotifications();
});

test('Notifications: ignores unknown events', async () => {
  let sendCalled = false;
  const mockClient = {
    channels: {
      fetch: async () => ({
        send: async () => {
          sendCalled = true;
        },
      }),
    },
  };

  initDiscordNotifications(mockClient, '222222222222222222');
  await sendDiscordNotification('UNKNOWN_EVENT', {});
  assert.equal(sendCalled, false, 'Should not send for unknown events');
  stopDiscordNotifications();
});
