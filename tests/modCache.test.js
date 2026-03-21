// Tests for src/modCache.js — mod metadata caching with in-memory fallback.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import to reset module state between tests is tricky with ESM,
// so we test the exported functions directly and rely on invalidateAll() for cleanup.
import { getCachedBatch, setCachedBatch, invalidateHash, invalidateAll, initIconCache } from '../src/modCache.js';

beforeEach(async () => {
  await invalidateAll();
});

test('getCachedBatch returns empty map for empty input', async () => {
  const result = await getCachedBatch([]);
  assert.equal(result.size, 0);
});

test('getCachedBatch returns empty map for unknown hashes', async () => {
  const result = await getCachedBatch(['abc123']);
  assert.equal(result.size, 0);
});

test('setCachedBatch + getCachedBatch round-trip for positive entry', async () => {
  const metadata = { projectId: 'proj1', projectTitle: 'Test Mod', versionNumber: '1.0.0' };
  await setCachedBatch([{ sha1: 'aaa', found: true, metadata }]);

  const result = await getCachedBatch(['aaa']);
  assert.equal(result.size, 1);
  assert.equal(result.get('aaa').found, true);
  assert.equal(result.get('aaa').metadata.projectTitle, 'Test Mod');
});

test('setCachedBatch + getCachedBatch round-trip for negative entry', async () => {
  await setCachedBatch([{ sha1: 'bbb', found: false, metadata: null }]);

  const result = await getCachedBatch(['bbb']);
  assert.equal(result.size, 1);
  assert.equal(result.get('bbb').found, false);
  assert.equal(result.get('bbb').metadata, null);
});

test('batch with mixed positive and negative entries', async () => {
  await setCachedBatch([
    { sha1: 'pos1', found: true, metadata: { projectTitle: 'Mod A' } },
    { sha1: 'neg1', found: false, metadata: null },
    { sha1: 'pos2', found: true, metadata: { projectTitle: 'Mod B' } },
  ]);

  const result = await getCachedBatch(['pos1', 'neg1', 'pos2', 'unknown']);
  assert.equal(result.size, 3);
  assert.equal(result.get('pos1').found, true);
  assert.equal(result.get('neg1').found, false);
  assert.equal(result.get('pos2').metadata.projectTitle, 'Mod B');
  assert.equal(result.has('unknown'), false);
});

test('invalidateHash removes a single entry', async () => {
  await setCachedBatch([
    { sha1: 'keep', found: true, metadata: { projectTitle: 'Keep' } },
    { sha1: 'remove', found: true, metadata: { projectTitle: 'Remove' } },
  ]);

  await invalidateHash('remove');

  const result = await getCachedBatch(['keep', 'remove']);
  assert.equal(result.size, 1);
  assert.equal(result.has('keep'), true);
  assert.equal(result.has('remove'), false);
});

test('invalidateAll clears all entries', async () => {
  await setCachedBatch([
    { sha1: 'a', found: true, metadata: { projectTitle: 'A' } },
    { sha1: 'b', found: false, metadata: null },
  ]);

  await invalidateAll();

  const result = await getCachedBatch(['a', 'b']);
  assert.equal(result.size, 0);
});

test('setCachedBatch overwrites existing entries', async () => {
  await setCachedBatch([{ sha1: 'x', found: true, metadata: { projectTitle: 'Old' } }]);
  await setCachedBatch([{ sha1: 'x', found: true, metadata: { projectTitle: 'New' } }]);

  const result = await getCachedBatch(['x']);
  assert.equal(result.get('x').metadata.projectTitle, 'New');
});

test('initIconCache does not throw', async () => {
  await assert.doesNotReject(() => initIconCache());
});
