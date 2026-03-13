// Tests for path traversal prevention in src/pathUtils.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeJoin } from '../src/pathUtils.js';

const BASE = path.resolve('/srv/minecraft/mods');

test('safeJoin: allows a plain filename', () => {
  const result = safeJoin(BASE, 'create-1.20.1.jar');
  assert.equal(result, path.join(BASE, 'create-1.20.1.jar'));
});

test('safeJoin: allows a subdirectory path under base', () => {
  const base = path.resolve('/srv/minecraft');
  const result = safeJoin(base, 'mods', 'jei.jar');
  assert.equal(result, path.join(base, 'mods', 'jei.jar'));
});

test('safeJoin: allows the base directory itself', () => {
  const result = safeJoin(BASE, '.');
  assert.equal(result, BASE);
});

test('safeJoin: blocks classic .. traversal', () => {
  assert.throws(() => safeJoin(BASE, '../server.js'), /traversal/i);
});

test('safeJoin: blocks deep .. traversal', () => {
  assert.throws(() => safeJoin(BASE, '../../etc/passwd'), /traversal/i);
});

test('safeJoin: blocks absolute path injection', () => {
  // path.resolve ignores earlier parts once it sees an absolute component —
  // safeJoin must catch this.
  assert.throws(() => safeJoin(BASE, '/etc/passwd'), /traversal/i);
});

test('safeJoin: blocks prefix-confusion attack (base name as prefix)', () => {
  // e.g. /srv/minecraft/mods-evil is NOT inside /srv/minecraft/mods
  assert.throws(() => safeJoin(BASE, '../mods-evil/bad.jar'), /traversal/i);
});
