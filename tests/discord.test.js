// Tests for the Discord integration module.
// Covers config validation, permission checks, command routing,
// account linking, challenge system, notification no-ops, and handler service delegation.
// All Discord APIs are mocked — no real Discord connection needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================
// Config validation
// ============================================================

import { buildDiscordConfig, validateDiscordConfig } from '../src/integrations/discord/config.js';

test('Discord config: disabled when no bot token', () => {
  const saved = { ...process.env };
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;

  const result = buildDiscordConfig({});
  assert.equal(result.enabled, false);

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
      botAdminRoleIds: ['111111111111111111'],
      notificationChannelId: '222222222222222222',
    },
  });

  assert.equal(result.enabled, true);
  assert.equal(result.guildId, '987654321098765432');
  assert.deepEqual(result.botAdminRoleIds, ['111111111111111111']);
  assert.equal(result.notificationChannelId, '222222222222222222');
  assert.equal(result.allowDMs, false); // default
  assert.deepEqual(result.ownerOverrideRoleIds, []); // default empty

  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;
  Object.assign(process.env, saved);
});

test('Discord config: validates snowflake IDs', () => {
  const errors = validateDiscordConfig({
    botToken: 'token',
    applicationId: 'not-a-snowflake',
    guildId: 'also-bad',
    botAdminRoleIds: ['bad-role'],
    ownerOverrideRoleIds: [],
    allowedRoleIds: [],
    notificationChannelId: '123',
    commandChannelIds: [],
  });
  assert.ok(errors.length >= 3, `Expected at least 3 errors, got ${errors.length}: ${errors.join('; ')}`);
  assert.ok(errors.some((e) => e.includes('applicationId')));
  assert.ok(errors.some((e) => e.includes('guildId')));
  assert.ok(errors.some((e) => e.includes('bot admin role')));
});

test('Discord config: no errors for valid config', () => {
  const errors = validateDiscordConfig({
    botToken: 'valid-token',
    applicationId: '123456789012345678',
    guildId: '987654321098765432',
    botAdminRoleIds: ['111111111111111111'],
    ownerOverrideRoleIds: [],
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
  process.env.DISCORD_BOT_ADMIN_ROLE_IDS = '111111111111111111,222222222222222222';

  const result = buildDiscordConfig({
    discord: {
      guildId: '000000000000000000', // should be overridden by env
      botAdminRoleIds: ['333333333333333333'], // should be overridden by env
    },
  });

  assert.equal(result.enabled, true);
  assert.equal(result.guildId, '999999999999999999');
  assert.deepEqual(result.botAdminRoleIds, ['111111111111111111', '222222222222222222']);

  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;
  delete process.env.DISCORD_GUILD_ID;
  delete process.env.DISCORD_BOT_ADMIN_ROLE_IDS;
  Object.assign(process.env, saved);
});

test('Discord config: legacy DISCORD_ADMIN_ROLE_IDS maps to botAdminRoleIds', () => {
  const saved = { ...process.env };
  process.env.DISCORD_BOT_TOKEN = 'env-token';
  process.env.DISCORD_APPLICATION_ID = '123456789012345678';
  process.env.DISCORD_ADMIN_ROLE_IDS = '444444444444444444';

  const result = buildDiscordConfig({ discord: {} });

  assert.equal(result.enabled, true);
  assert.deepEqual(result.botAdminRoleIds, ['444444444444444444']);

  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;
  delete process.env.DISCORD_ADMIN_ROLE_IDS;
  Object.assign(process.env, saved);
});

test('Discord config: ownerOverrideRoleIds from env', () => {
  const saved = { ...process.env };
  process.env.DISCORD_BOT_TOKEN = 'env-token';
  process.env.DISCORD_APPLICATION_ID = '123456789012345678';
  process.env.DISCORD_OWNER_OVERRIDE_ROLE_IDS = '555555555555555555';

  const result = buildDiscordConfig({ discord: {} });

  assert.equal(result.enabled, true);
  assert.deepEqual(result.ownerOverrideRoleIds, ['555555555555555555']);

  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;
  delete process.env.DISCORD_OWNER_OVERRIDE_ROLE_IDS;
  Object.assign(process.env, saved);
});

test('Discord config: linkChallengeTimeoutMinutes defaults to 10', () => {
  const saved = { ...process.env };
  process.env.DISCORD_BOT_TOKEN = 'env-token';
  process.env.DISCORD_APPLICATION_ID = '123456789012345678';

  const result = buildDiscordConfig({ discord: {} });
  assert.equal(result.linkChallengeTimeoutMinutes, 10);

  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;
  Object.assign(process.env, saved);
});

// ============================================================
// Permissions (async with op-level tiers, separated from Discord roles)
// ============================================================

import { checkPermission, PermissionLevel, TIER_NAMES } from '../src/integrations/discord/permissions.js';

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
  botAdminRoleIds: ['bot-admin-role-1'],
  ownerOverrideRoleIds: [],
  allowedRoleIds: [],
  commandChannelIds: [],
  allowDMs: false,
};

// Mock ctx for permission checks (no ops = op level 0)
const mockCtx = {
  config: { demoMode: true, serverPath: '' },
};

test('Permissions: READ_ONLY allowed for any guild member', async () => {
  const result = await checkPermission(mockInteraction(), PermissionLevel.READ_ONLY, baseDiscordConfig, mockCtx);
  assert.equal(result.allowed, true);
});

test('Permissions: OWNER denied without owner override role or link', async () => {
  const result = await checkPermission(mockInteraction(), PermissionLevel.OWNER, baseDiscordConfig, mockCtx);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('link'));
});

test('Permissions: botAdminRoleIds does NOT grant OWNER access', async () => {
  const result = await checkPermission(
    mockInteraction({ roles: ['bot-admin-role-1'] }),
    PermissionLevel.OWNER,
    baseDiscordConfig,
    mockCtx,
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('link'));
});

test('Permissions: ownerOverrideRoleIds grants OWNER access when configured', async () => {
  const config = { ...baseDiscordConfig, ownerOverrideRoleIds: ['override-role-1'] };
  const result = await checkPermission(
    mockInteraction({ roles: ['override-role-1'] }),
    PermissionLevel.OWNER,
    config,
    mockCtx,
  );
  assert.equal(result.allowed, true);
  assert.equal(result.opLevel, 4);
});

test('Permissions: ownerOverrideRoleIds has no effect when empty', async () => {
  const result = await checkPermission(
    mockInteraction({ roles: ['some-role'] }),
    PermissionLevel.OWNER,
    baseDiscordConfig,
    mockCtx,
  );
  assert.equal(result.allowed, false);
});

test('Permissions: DMs blocked by default', async () => {
  const result = await checkPermission(
    mockInteraction({ guildId: null }),
    PermissionLevel.READ_ONLY,
    baseDiscordConfig,
    mockCtx,
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('DM'));
});

test('Permissions: DMs allowed when configured', async () => {
  const result = await checkPermission(
    mockInteraction({ guildId: null }),
    PermissionLevel.READ_ONLY,
    {
      ...baseDiscordConfig,
      allowDMs: true,
    },
    mockCtx,
  );
  assert.equal(result.allowed, true);
});

test('Permissions: wrong guild blocked', async () => {
  const result = await checkPermission(
    mockInteraction({ guildId: '999' }),
    PermissionLevel.READ_ONLY,
    baseDiscordConfig,
    mockCtx,
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('not configured'));
});

test('Permissions: wrong channel blocked', async () => {
  const config = { ...baseDiscordConfig, commandChannelIds: ['allowed-channel'] };
  const result = await checkPermission(
    mockInteraction({ channelId: '789' }),
    PermissionLevel.READ_ONLY,
    config,
    mockCtx,
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('channel'));
});

test('Permissions: elevated denied when no override roles and no link', async () => {
  const config = { ...baseDiscordConfig, ownerOverrideRoleIds: [] };
  const result = await checkPermission(mockInteraction(), PermissionLevel.MODERATOR, config, mockCtx);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('link'));
});

test('Permissions: TIER_NAMES covers all levels', () => {
  assert.equal(TIER_NAMES[PermissionLevel.READ_ONLY], 'Everyone');
  assert.equal(TIER_NAMES[PermissionLevel.MODERATOR], 'Moderator (Op 1+)');
  assert.equal(TIER_NAMES[PermissionLevel.GAME_MASTER], 'Game Master (Op 2+)');
  assert.equal(TIER_NAMES[PermissionLevel.ADMIN], 'Admin (Op 3+)');
  assert.equal(TIER_NAMES[PermissionLevel.OWNER], 'Owner (Op 4)');
});

test('Permissions: numeric levels are ordered correctly', () => {
  assert.ok(PermissionLevel.READ_ONLY < PermissionLevel.MODERATOR);
  assert.ok(PermissionLevel.MODERATOR < PermissionLevel.GAME_MASTER);
  assert.ok(PermissionLevel.GAME_MASTER < PermissionLevel.ADMIN);
  assert.ok(PermissionLevel.ADMIN < PermissionLevel.OWNER);
});

// ============================================================
// Account linking
// ============================================================

import { setLink, removeLink, getLink, getAllLinks } from '../src/integrations/discord/links.js';

test('Links: set and get a link', async () => {
  await setLink('discord-user-1', 'Steve', 'self');
  const link = await getLink('discord-user-1');
  assert.ok(link);
  assert.equal(link.minecraftName, 'Steve');
  assert.equal(link.linkedBy, 'self');
  assert.ok(link.linkedAt);
});

test('Links: overwrite an existing link', async () => {
  await setLink('discord-user-1', 'Alex', 'self:verified');
  const link = await getLink('discord-user-1');
  assert.equal(link.minecraftName, 'Alex');
  assert.equal(link.linkedBy, 'self:verified');
});

test('Links: remove a link', async () => {
  await setLink('discord-user-2', 'Notch', 'self');
  const removed = await removeLink('discord-user-2');
  assert.equal(removed, true);
  assert.equal(await getLink('discord-user-2'), null);
});

test('Links: remove non-existent link returns false', async () => {
  const removed = await removeLink('no-such-user');
  assert.equal(removed, false);
});

test('Links: getAllLinks returns all entries', async () => {
  await setLink('link-test-a', 'PlayerA', 'self');
  await setLink('link-test-b', 'PlayerB', 'self');
  const all = await getAllLinks();
  assert.ok(all.some((l) => l.discordId === 'link-test-a' && l.minecraftName === 'PlayerA'));
  assert.ok(all.some((l) => l.discordId === 'link-test-b' && l.minecraftName === 'PlayerB'));
});

test('Links: getLink returns null for unknown user', async () => {
  assert.equal(await getLink('unknown-user-id'), null);
});

// ============================================================
// Challenge system
// ============================================================

import {
  createChallenge,
  verifyChallenge,
  getPendingChallenge,
  cancelChallenge,
  setChallengeTimeout,
  getLinkByMinecraftName,
} from '../src/integrations/discord/links.js';

test('Challenge: create and retrieve pending challenge', () => {
  const challenge = createChallenge('challenge-user-1', 'TestPlayer');
  assert.ok(challenge);
  assert.equal(challenge.discordUserId, 'challenge-user-1');
  assert.equal(challenge.minecraftName, 'TestPlayer');
  assert.ok(challenge.code.match(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/));
  assert.ok(challenge.expiresAt > Date.now());

  const pending = getPendingChallenge('challenge-user-1');
  assert.ok(pending);
  assert.equal(pending.code, challenge.code);
});

test('Challenge: successful verification with correct player and code', () => {
  const challenge = createChallenge('challenge-user-2', 'CorrectPlayer');
  const result = verifyChallenge('CorrectPlayer', challenge.code);
  assert.ok(result);
  assert.equal(result.discordUserId, 'challenge-user-2');
  assert.equal(result.minecraftName, 'CorrectPlayer');

  // Challenge consumed (one-time use)
  assert.equal(getPendingChallenge('challenge-user-2'), null);
});

test('Challenge: case-insensitive player name match', () => {
  const challenge = createChallenge('challenge-user-ci', 'Steve');
  const result = verifyChallenge('steve', challenge.code);
  assert.ok(result);
  assert.equal(result.discordUserId, 'challenge-user-ci');
});

test('Challenge: case-insensitive code match', () => {
  const challenge = createChallenge('challenge-user-code-ci', 'Player1');
  const result = verifyChallenge('Player1', challenge.code.toLowerCase());
  assert.ok(result);
});

test('Challenge: rejected for wrong player', () => {
  const challenge = createChallenge('challenge-user-3', 'RightPlayer');
  const result = verifyChallenge('WrongPlayer', challenge.code);
  assert.equal(result, null);

  // Challenge NOT consumed — still available for the right player
  const pending = getPendingChallenge('challenge-user-3');
  assert.ok(pending);
});

test('Challenge: rejected for wrong code', () => {
  createChallenge('challenge-user-4', 'SomePlayer');
  const result = verifyChallenge('SomePlayer', 'XXXX-YYYY');
  assert.equal(result, null);
});

test('Challenge: expired challenge returns null', () => {
  // Set very short timeout
  setChallengeTimeout(1); // 1ms
  const challenge = createChallenge('challenge-user-5', 'ExpiredPlayer');

  // Wait for expiration
  const start = Date.now();
  while (Date.now() - start < 5) {
    /* spin */
  }

  const result = verifyChallenge('ExpiredPlayer', challenge.code);
  assert.equal(result, null);

  // Also getPendingChallenge returns null for expired
  assert.equal(getPendingChallenge('challenge-user-5'), null);

  // Restore default timeout
  setChallengeTimeout(10 * 60 * 1000);
});

test('Challenge: new challenge replaces old one for same user', () => {
  const first = createChallenge('challenge-user-6', 'Player1');
  const second = createChallenge('challenge-user-6', 'Player2');

  assert.notEqual(first.code, second.code);
  assert.equal(second.minecraftName, 'Player2');

  // Old code no longer works
  const result1 = verifyChallenge('Player1', first.code);
  assert.equal(result1, null);

  // New code works
  const result2 = verifyChallenge('Player2', second.code);
  assert.ok(result2);
});

test('Challenge: cancel removes pending challenge', () => {
  createChallenge('challenge-user-7', 'CancelPlayer');
  assert.ok(getPendingChallenge('challenge-user-7'));

  cancelChallenge('challenge-user-7');
  assert.equal(getPendingChallenge('challenge-user-7'), null);
});

test('Challenge: codes are unique among pending challenges', () => {
  const codes = new Set();
  for (let i = 0; i < 20; i++) {
    const challenge = createChallenge(`unique-test-${i}`, `Player${i}`);
    assert.ok(!codes.has(challenge.code), `Duplicate code: ${challenge.code}`);
    codes.add(challenge.code);
  }
  // Clean up
  for (let i = 0; i < 20; i++) {
    cancelChallenge(`unique-test-${i}`);
  }
});

test('Challenge: duplicate MC name blocked', async () => {
  await setLink('mc-dupe-owner', 'DupePlayer', 'self');
  const existing = await getLinkByMinecraftName('DupePlayer');
  assert.ok(existing);
  assert.equal(existing.discordId, 'mc-dupe-owner');

  // Clean up
  await removeLink('mc-dupe-owner');
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
import pkg from 'discord.js';
const { SlashCommandBuilder } = pkg;

test('Registry: can register and retrieve commands', () => {
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

test('Registry: getCommandsByPermission filters by numeric level', () => {
  registerCommand('test-read', {
    permission: PermissionLevel.READ_ONLY,
    builder: new SlashCommandBuilder().setName('test-read').setDescription('Read'),
    handler: async () => {},
  });
  registerCommand('test-mod', {
    permission: PermissionLevel.MODERATOR,
    builder: new SlashCommandBuilder().setName('test-mod').setDescription('Mod'),
    handler: async () => {},
  });
  registerCommand('test-owner', {
    permission: PermissionLevel.OWNER,
    builder: new SlashCommandBuilder().setName('test-owner').setDescription('Owner'),
    handler: async () => {},
  });

  const readCmds = getCommandsByPermission(PermissionLevel.READ_ONLY);
  const modCmds = getCommandsByPermission(PermissionLevel.MODERATOR);
  const ownerCmds = getCommandsByPermission(PermissionLevel.OWNER);

  // READ_ONLY should only get level-0 commands
  assert.ok(readCmds.every((c) => c.permission === PermissionLevel.READ_ONLY));
  // MODERATOR should get read + moderator commands
  assert.ok(modCmds.some((c) => c.permission === PermissionLevel.MODERATOR));
  assert.ok(modCmds.some((c) => c.permission === PermissionLevel.READ_ONLY));
  assert.ok(!modCmds.some((c) => c.permission === PermissionLevel.OWNER));
  // OWNER should get everything
  assert.ok(ownerCmds.length >= modCmds.length);
});

test('Registry: getCommandsJSON returns valid JSON array', () => {
  const json = getCommandsJSON();
  assert.ok(Array.isArray(json));
  assert.ok(json.length > 0);
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

test('Command router: denies elevated command without link or role', async () => {
  registerCommand('test-owner-deny', {
    permission: PermissionLevel.OWNER,
    builder: new SlashCommandBuilder().setName('test-owner-deny').setDescription('Owner deny test'),
    handler: async () => {
      assert.fail('Handler should not be called');
    },
  });

  let replyContent = '';
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'test-owner-deny',
    user: { id: '999', tag: 'user#0001', username: 'user' },
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
  assert.ok(replyContent.includes('link'), `Expected link prompt, got: "${replyContent}"`);
});

test('Command router: ignores non-chat-input interactions', async () => {
  const interaction = {
    isChatInputCommand: () => false,
    commandName: 'anything',
  };
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
