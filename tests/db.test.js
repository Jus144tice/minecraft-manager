// Tests for database helpers in src/db.js.
// These test the no-pool fallback paths (when DATABASE_URL is not set).
// Real PostgreSQL integration tests require a running database and are not included here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPool,
  isConnected,
  upsertUser,
  getUser,
  listUsers,
  setAdminLevel,
  setUserRole,
  countAdmins,
  deleteUser,
  insertAuditLog,
  queryAuditLogs,
  upsertDiscordLink,
  getDiscordLink,
  listDiscordLinks,
  getDiscordLinkByMinecraftName,
  deleteDiscordLink,
  upsertPanelLink,
  getPanelLink,
  listPanelLinks,
  getPanelLinkByMinecraftName,
  deletePanelLink,
} from '../src/db.js';

// ---- Pool state (no DATABASE_URL set in test env) ----

test('getPool: returns null when DATABASE_URL is not set', () => {
  assert.equal(getPool(), null);
});

test('isConnected: returns false when no pool', () => {
  assert.equal(isConnected(), false);
});

// ---- User helpers: no-pool fallback ----

test('upsertUser: returns null without pool', async () => {
  assert.equal(await upsertUser('a@b.com', 'Alice', 'google'), null);
});

test('getUser: returns null without pool', async () => {
  assert.equal(await getUser('a@b.com'), null);
});

test('listUsers: returns empty array without pool', async () => {
  assert.deepEqual(await listUsers(), []);
});

test('setAdminLevel: returns null without pool', async () => {
  assert.equal(await setAdminLevel('a@b.com', 1), null);
});

test('setUserRole: returns null without pool', async () => {
  assert.equal(await setUserRole('a@b.com', 'admin'), null);
});

test('setUserRole: returns null for invalid role name', async () => {
  assert.equal(await setUserRole('a@b.com', 'superadmin'), null);
});

test('countAdmins: returns 0 without pool', async () => {
  assert.equal(await countAdmins(), 0);
});

test('deleteUser: returns false without pool', async () => {
  assert.equal(await deleteUser('a@b.com'), false);
});

// ---- Audit log helpers: no-pool fallback ----

test('insertAuditLog: does not throw without pool', async () => {
  await insertAuditLog('TEST_ACTION', { user: 'test@test.com', ip: '127.0.0.1', extra: 'data' });
  // Should complete without error
});

test('queryAuditLogs: returns empty array without pool', async () => {
  assert.deepEqual(await queryAuditLogs(), []);
});

test('queryAuditLogs: returns empty with filters', async () => {
  assert.deepEqual(await queryAuditLogs({ action: 'LOGIN', email: 'a@b.com' }), []);
});

// ---- Discord link helpers: no-pool fallback ----

test('upsertDiscordLink: returns null without pool', async () => {
  assert.equal(await upsertDiscordLink('123', 'Steve', 'self'), null);
});

test('getDiscordLink: returns null without pool', async () => {
  assert.equal(await getDiscordLink('123'), null);
});

test('listDiscordLinks: returns empty array without pool', async () => {
  assert.deepEqual(await listDiscordLinks(), []);
});

test('getDiscordLinkByMinecraftName: returns null without pool', async () => {
  assert.equal(await getDiscordLinkByMinecraftName('Steve'), null);
});

test('deleteDiscordLink: returns false without pool', async () => {
  assert.equal(await deleteDiscordLink('123'), false);
});

// ---- Panel link helpers: no-pool fallback ----

test('upsertPanelLink: returns null without pool', async () => {
  assert.equal(await upsertPanelLink('a@b.com', 'Steve', 'self', true), null);
});

test('getPanelLink: returns null without pool', async () => {
  assert.equal(await getPanelLink('a@b.com'), null);
});

test('listPanelLinks: returns empty array without pool', async () => {
  assert.deepEqual(await listPanelLinks(), []);
});

test('getPanelLinkByMinecraftName: returns null without pool', async () => {
  assert.equal(await getPanelLinkByMinecraftName('Steve'), null);
});

test('deletePanelLink: returns false without pool', async () => {
  assert.equal(await deletePanelLink('a@b.com'), false);
});
