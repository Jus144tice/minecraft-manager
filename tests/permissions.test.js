// Tests for the granular RBAC permission engine in src/permissions.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES,
  ROLES,
  ROLE_ORDER,
  getCapabilitiesForRole,
  getRoleLevel,
  getRoleByLevel,
  roleHasCapability,
  resolveOpLevelRole,
  resolveDiscordRoleMapping,
  resolveEffectivePermissions,
  adminLevelToRole,
  roleToAdminLevel,
  mergeAuthorizationConfig,
  DEFAULT_OP_LEVEL_MAPPING,
  PERMISSION_POLICIES,
} from '../src/permissions.js';

// --- Role definitions ---

test('ROLE_ORDER contains exactly 5 roles in ascending order', () => {
  assert.deepEqual(ROLE_ORDER, ['viewer', 'operator', 'moderator', 'admin', 'owner']);
});

test('each role in ROLE_ORDER is defined in ROLES', () => {
  for (const key of ROLE_ORDER) {
    assert.ok(ROLES[key], `Missing ROLES[${key}]`);
    assert.ok(ROLES[key].name, `ROLES[${key}].name is missing`);
    assert.ok(Array.isArray(ROLES[key].capabilities), `ROLES[${key}].capabilities is not an array`);
  }
});

test('roles have strictly increasing levels', () => {
  for (let i = 1; i < ROLE_ORDER.length; i++) {
    const prev = ROLES[ROLE_ORDER[i - 1]].level;
    const curr = ROLES[ROLE_ORDER[i]].level;
    assert.ok(curr > prev, `${ROLE_ORDER[i]} level (${curr}) should be > ${ROLE_ORDER[i - 1]} level (${prev})`);
  }
});

test('each role includes all capabilities from the role below it (cumulative)', () => {
  for (let i = 1; i < ROLE_ORDER.length; i++) {
    const prevCaps = getCapabilitiesForRole(ROLE_ORDER[i - 1]);
    const currCaps = getCapabilitiesForRole(ROLE_ORDER[i]);
    for (const cap of prevCaps) {
      assert.ok(currCaps.has(cap), `${ROLE_ORDER[i]} is missing capability "${cap}" from ${ROLE_ORDER[i - 1]}`);
    }
  }
});

test('all capability strings referenced in roles are defined in CAPABILITIES', () => {
  for (const [key, role] of Object.entries(ROLES)) {
    for (const cap of role.capabilities) {
      assert.ok(cap in CAPABILITIES, `Role "${key}" references undefined capability "${cap}"`);
    }
  }
});

// --- getCapabilitiesForRole ---

test('getCapabilitiesForRole returns a Set', () => {
  const caps = getCapabilitiesForRole('viewer');
  assert.ok(caps instanceof Set);
});

test('getCapabilitiesForRole returns viewer caps for unknown role', () => {
  const caps = getCapabilitiesForRole('nonexistent');
  const viewerCaps = getCapabilitiesForRole('viewer');
  assert.deepEqual([...caps].sort(), [...viewerCaps].sort());
});

test('owner has all capabilities', () => {
  const ownerCaps = getCapabilitiesForRole('owner');
  for (const cap of Object.keys(CAPABILITIES)) {
    assert.ok(ownerCaps.has(cap), `Owner is missing capability "${cap}"`);
  }
});

test('viewer cannot start server', () => {
  assert.equal(roleHasCapability('viewer', 'server.start'), false);
});

test('operator can start and stop server', () => {
  assert.ok(roleHasCapability('operator', 'server.start'));
  assert.ok(roleHasCapability('operator', 'server.stop'));
});

test('moderator can manage bans but not configure panel', () => {
  assert.ok(roleHasCapability('moderator', 'players.manage_bans'));
  assert.equal(roleHasCapability('moderator', 'panel.configure'), false);
});

test('admin can configure panel but not manage users', () => {
  assert.ok(roleHasCapability('admin', 'panel.configure'));
  assert.equal(roleHasCapability('admin', 'panel.manage_users'), false);
});

test('owner can manage users and world', () => {
  assert.ok(roleHasCapability('owner', 'panel.manage_users'));
  assert.ok(roleHasCapability('owner', 'server.manage_world'));
});

// --- getRoleLevel / getRoleByLevel ---

test('getRoleLevel returns correct levels', () => {
  assert.equal(getRoleLevel('viewer'), 0);
  assert.equal(getRoleLevel('operator'), 1);
  assert.equal(getRoleLevel('moderator'), 2);
  assert.equal(getRoleLevel('admin'), 3);
  assert.equal(getRoleLevel('owner'), 4);
});

test('getRoleLevel returns 0 for unknown role', () => {
  assert.equal(getRoleLevel('unknown'), 0);
});

test('getRoleByLevel round-trips', () => {
  for (const key of ROLE_ORDER) {
    assert.equal(getRoleByLevel(ROLES[key].level), key);
  }
});

// --- resolveOpLevelRole ---

test('default op level mapping: op 0 → null', () => {
  assert.equal(resolveOpLevelRole(0), null);
});

test('default op level mapping: op 4 → admin (not owner)', () => {
  assert.equal(resolveOpLevelRole(4), 'admin');
});

test('default op level mapping: op 1 → viewer', () => {
  assert.equal(resolveOpLevelRole(1), 'viewer');
});

test('custom op level mapping overrides defaults', () => {
  const custom = { 0: null, 1: 'moderator', 2: 'admin', 3: 'admin', 4: 'owner' };
  assert.equal(resolveOpLevelRole(1, custom), 'moderator');
  assert.equal(resolveOpLevelRole(4, custom), 'owner');
});

test('resolveOpLevelRole handles string keys', () => {
  const mapping = { 3: 'admin' };
  assert.equal(resolveOpLevelRole(3, mapping), 'admin');
});

// --- resolveDiscordRoleMapping ---

test('resolveDiscordRoleMapping returns null for empty mapping', () => {
  assert.equal(resolveDiscordRoleMapping(['123'], {}), null);
});

test('resolveDiscordRoleMapping returns null for no matching roles', () => {
  assert.equal(resolveDiscordRoleMapping(['123'], { 456: 'admin' }), null);
});

test('resolveDiscordRoleMapping returns mapped role', () => {
  assert.equal(resolveDiscordRoleMapping(['123'], { 123: 'moderator' }), 'moderator');
});

test('resolveDiscordRoleMapping picks highest role from multiple matches', () => {
  const mapping = { 100: 'viewer', 200: 'admin', 300: 'operator' };
  assert.equal(resolveDiscordRoleMapping(['100', '200', '300'], mapping), 'admin');
});

test('resolveDiscordRoleMapping ignores invalid role names in mapping', () => {
  const mapping = { 100: 'nonexistent', 200: 'viewer' };
  assert.equal(resolveDiscordRoleMapping(['100', '200'], mapping), 'viewer');
});

// --- resolveEffectivePermissions ---

test('panel channel uses panelRole directly', () => {
  const result = resolveEffectivePermissions({ channel: 'panel', panelRole: 'admin' });
  assert.equal(result.role, 'admin');
  assert.ok(result.capabilities.has('panel.configure'));
});

test('isolated policy: discord channel ignores panelRole', () => {
  const result = resolveEffectivePermissions({
    channel: 'discord',
    channelRole: 'viewer',
    panelRole: 'owner',
    policy: 'isolated',
  });
  assert.equal(result.role, 'viewer');
  assert.equal(result.capabilities.has('panel.configure'), false);
});

test('inherit-panel policy: discord channel uses panelRole', () => {
  const result = resolveEffectivePermissions({
    channel: 'discord',
    channelRole: 'viewer',
    panelRole: 'admin',
    policy: 'inherit-panel',
  });
  assert.equal(result.role, 'admin');
  assert.ok(result.capabilities.has('panel.configure'));
});

test('panel-ceiling policy: uses higher of channelRole and panelRole', () => {
  const r1 = resolveEffectivePermissions({
    channel: 'discord',
    channelRole: 'moderator',
    panelRole: 'viewer',
    policy: 'panel-ceiling',
  });
  assert.equal(r1.role, 'moderator');

  const r2 = resolveEffectivePermissions({
    channel: 'discord',
    channelRole: 'viewer',
    panelRole: 'admin',
    policy: 'panel-ceiling',
  });
  assert.equal(r2.role, 'admin');
});

test('default policy is isolated', () => {
  const result = resolveEffectivePermissions({
    channel: 'discord',
    channelRole: 'viewer',
    panelRole: 'owner',
  });
  assert.equal(result.role, 'viewer');
});

// --- Legacy compatibility ---

test('adminLevelToRole: 0 → viewer, 1 → admin', () => {
  assert.equal(adminLevelToRole(0), 'viewer');
  assert.equal(adminLevelToRole(1), 'admin');
  assert.equal(adminLevelToRole(2), 'admin');
});

test('roleToAdminLevel: viewer/operator/moderator → 0, admin/owner → 1', () => {
  assert.equal(roleToAdminLevel('viewer'), 0);
  assert.equal(roleToAdminLevel('operator'), 0);
  assert.equal(roleToAdminLevel('moderator'), 0);
  assert.equal(roleToAdminLevel('admin'), 1);
  assert.equal(roleToAdminLevel('owner'), 1);
});

// --- mergeAuthorizationConfig ---

test('mergeAuthorizationConfig returns defaults for null input', () => {
  const result = mergeAuthorizationConfig(null);
  assert.equal(result.permissionPolicy, 'isolated');
  assert.deepEqual(result.opLevelMapping, DEFAULT_OP_LEVEL_MAPPING);
  assert.deepEqual(result.discordRoleMapping, {});
});

test('mergeAuthorizationConfig merges partial config', () => {
  const result = mergeAuthorizationConfig({
    permissionPolicy: 'inherit-panel',
    opLevelMapping: { 4: 'owner' },
  });
  assert.equal(result.permissionPolicy, 'inherit-panel');
  assert.equal(result.opLevelMapping[4], 'owner');
  assert.equal(result.opLevelMapping[1], 'viewer'); // preserved from defaults
});

test('mergeAuthorizationConfig rejects invalid policy', () => {
  const result = mergeAuthorizationConfig({ permissionPolicy: 'invalid' });
  assert.equal(result.permissionPolicy, 'isolated');
});

test('PERMISSION_POLICIES contains expected values', () => {
  assert.deepEqual(PERMISSION_POLICIES, ['isolated', 'inherit-panel', 'panel-ceiling']);
});
