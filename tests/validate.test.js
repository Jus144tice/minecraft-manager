// Tests for input validation in src/validate.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidMinecraftName, isSafeModFilename, isSafeCommand, sanitizeReason } from '../src/validate.js';

// --- isValidMinecraftName ---

test('isValidMinecraftName: accepts typical names', () => {
  assert.ok(isValidMinecraftName('Steve'));
  assert.ok(isValidMinecraftName('Alex_1234'));
  assert.ok(isValidMinecraftName('a'));
  assert.ok(isValidMinecraftName('a'.repeat(16)));
  assert.ok(isValidMinecraftName('Player_Name'));
});

test('isValidMinecraftName: rejects names that are too long', () => {
  assert.equal(isValidMinecraftName('a'.repeat(17)), false);
});

test('isValidMinecraftName: rejects empty string', () => {
  assert.equal(isValidMinecraftName(''), false);
});

test('isValidMinecraftName: rejects special characters used in injection attempts', () => {
  assert.equal(isValidMinecraftName('Steve; op @a'), false);
  assert.equal(isValidMinecraftName('name\nop @a'), false);
  assert.equal(isValidMinecraftName('name\x00'), false);
  assert.equal(isValidMinecraftName('../passwd'), false);
  assert.equal(isValidMinecraftName('<script>'), false);
});

test('isValidMinecraftName: rejects non-string types', () => {
  assert.equal(isValidMinecraftName(null), false);
  assert.equal(isValidMinecraftName(undefined), false);
  assert.equal(isValidMinecraftName(123), false);
});

// --- isSafeModFilename ---

test('isSafeModFilename: accepts valid jar filenames', () => {
  assert.ok(isSafeModFilename('create-1.20.1.jar'));
  assert.ok(isSafeModFilename('jei-1.20.1-forge-15.3.0.4.jar'));
  assert.ok(isSafeModFilename('Mod+Extra_Pack-v2.0.jar'));
  assert.ok(isSafeModFilename('a.jar'));
});

test('isSafeModFilename: rejects path traversal', () => {
  assert.equal(isSafeModFilename('../evil.jar'), false);
  assert.equal(isSafeModFilename('../../server.js'), false);
  assert.equal(isSafeModFilename('mods/../server.js'), false);
});

test('isSafeModFilename: rejects non-jar extensions', () => {
  assert.equal(isSafeModFilename('mod.zip'), false);
  assert.equal(isSafeModFilename('mod.exe'), false);
  assert.equal(isSafeModFilename('mod'), false);
});

test('isSafeModFilename: rejects path separators in name', () => {
  assert.equal(isSafeModFilename('subdir/mod.jar'), false);
  assert.equal(isSafeModFilename('sub\\mod.jar'), false);
});

test('isSafeModFilename: rejects empty and non-string', () => {
  assert.equal(isSafeModFilename(''), false);
  assert.equal(isSafeModFilename(null), false);
});

// --- isSafeCommand ---

test('isSafeCommand: accepts normal server commands', () => {
  assert.ok(isSafeCommand('list'));
  assert.ok(isSafeCommand('op Steve'));
  assert.ok(isSafeCommand('say Hello, world!'));
  assert.ok(isSafeCommand('time set day'));
});

test('isSafeCommand: rejects empty string', () => {
  assert.equal(isSafeCommand(''), false);
});

test('isSafeCommand: rejects commands with null bytes', () => {
  assert.equal(isSafeCommand('list\x00inject'), false);
});

test('isSafeCommand: rejects excessively long commands', () => {
  assert.equal(isSafeCommand('a'.repeat(1001)), false);
});

test('isSafeCommand: rejects non-string types', () => {
  assert.equal(isSafeCommand(null), false);
  assert.equal(isSafeCommand(42), false);
});

// --- sanitizeReason ---

test('sanitizeReason: strips null bytes and newlines', () => {
  const result = sanitizeReason('bad\x00reason\nwith\rnewlines');
  assert.ok(!result.includes('\x00'));
  assert.ok(!result.includes('\n'));
  assert.ok(!result.includes('\r'));
});

test('sanitizeReason: caps at 200 characters', () => {
  const long = 'a'.repeat(300);
  assert.equal(sanitizeReason(long).length, 200);
});

test('sanitizeReason: returns default for empty/null', () => {
  assert.equal(sanitizeReason(''), 'Banned by admin');
  assert.equal(sanitizeReason(null), 'Banned by admin');
});
