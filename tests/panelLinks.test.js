// Tests for the panel links module (in-memory mode).
// Covers CRUD operations, case-insensitive lookups, and edge cases.
// No database connection needed — all operations use the in-memory fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setLink, getLink, getLinkByMinecraftName, getAllLinks, removeLink } from '../src/panelLinks.js';

// ============================================================
// Helper: clean up all links created during tests
// ============================================================

async function removeAll() {
  const all = await getAllLinks();
  for (const link of all) {
    await removeLink(link.email);
  }
}

// ============================================================
// Basic CRUD
// ============================================================

test('Panel setLink: creates a link that can be retrieved', async () => {
  await removeAll();
  await setLink('alice@example.com', 'Alice_MC', 'self', false);
  const link = await getLink('alice@example.com');
  assert.ok(link);
  assert.equal(link.minecraftName, 'Alice_MC');
  assert.equal(link.linkedBy, 'self');
  assert.equal(link.verified, false);
  assert.ok(link.linkedAt);
  await removeAll();
});

test('Panel getLink: returns null for unknown email', async () => {
  await removeAll();
  const link = await getLink('nobody@example.com');
  assert.equal(link, null);
});

test('Panel getLinkByMinecraftName: finds link by MC name', async () => {
  await removeAll();
  await setLink('bob@example.com', 'BobMC', 'admin:admin@example.com', true);
  const link = await getLinkByMinecraftName('BobMC');
  assert.ok(link);
  assert.equal(link.email, 'bob@example.com');
  assert.equal(link.minecraftName, 'BobMC');
  await removeAll();
});

test('Panel getLinkByMinecraftName: case-insensitive lookup', async () => {
  await removeAll();
  await setLink('carol@example.com', 'CarolPlayer', 'self', false);

  const lower = await getLinkByMinecraftName('carolplayer');
  assert.ok(lower);
  assert.equal(lower.email, 'carol@example.com');

  const upper = await getLinkByMinecraftName('CAROLPLAYER');
  assert.ok(upper);
  assert.equal(upper.email, 'carol@example.com');

  const mixed = await getLinkByMinecraftName('cArOlPlAyEr');
  assert.ok(mixed);
  assert.equal(mixed.email, 'carol@example.com');

  await removeAll();
});

test('Panel getLinkByMinecraftName: returns null for unknown name', async () => {
  await removeAll();
  const link = await getLinkByMinecraftName('NonExistentPlayer');
  assert.equal(link, null);
});

test('Panel getAllLinks: returns all links', async () => {
  await removeAll();
  await setLink('p1@example.com', 'Player1', 'self', false);
  await setLink('p2@example.com', 'Player2', 'self', true);
  const all = await getAllLinks();
  assert.equal(all.length, 2);
  assert.ok(all.some((l) => l.email === 'p1@example.com' && l.minecraftName === 'Player1'));
  assert.ok(all.some((l) => l.email === 'p2@example.com' && l.minecraftName === 'Player2'));
  await removeAll();
});

test('Panel getAllLinks: returns empty array when no links exist', async () => {
  await removeAll();
  const all = await getAllLinks();
  assert.ok(Array.isArray(all));
  assert.equal(all.length, 0);
});

test('Panel removeLink: removes and returns true', async () => {
  await removeAll();
  await setLink('remove-me@example.com', 'RemoveMe', 'self', false);
  const result = await removeLink('remove-me@example.com');
  assert.equal(result, true);
  const link = await getLink('remove-me@example.com');
  assert.equal(link, null);
});

test('Panel removeLink: returns false for unknown email', async () => {
  await removeAll();
  const result = await removeLink('ghost@example.com');
  assert.equal(result, false);
});

// ============================================================
// Overwriting / upsert behavior
// ============================================================

test('Panel setLink: overwrites existing link with same email', async () => {
  await removeAll();
  await setLink('upsert@example.com', 'OriginalName', 'self', false);
  await setLink('upsert@example.com', 'UpdatedName', 'self:verified', true);

  const link = await getLink('upsert@example.com');
  assert.ok(link);
  assert.equal(link.minecraftName, 'UpdatedName');
  assert.equal(link.linkedBy, 'self:verified');
  assert.equal(link.verified, true);

  // Should still be only one entry
  const all = await getAllLinks();
  const matching = all.filter((l) => l.email === 'upsert@example.com');
  assert.equal(matching.length, 1);
  await removeAll();
});
