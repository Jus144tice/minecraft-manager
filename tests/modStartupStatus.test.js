// Tests for src/modStartupStatus.js — Forge log parsing and mod status tracking.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModStartupParser } from '../src/modStartupStatus.js';

let parser;

beforeEach(() => {
  parser = new ModStartupParser();
  // Set up a test mod ID map
  parser.setModIdMap(
    new Map([
      ['voicechat', 'voicechat-1.20.1-2.6.12.jar'],
      ['create', 'create-1.20.1-0.5.1.f.jar'],
      ['quark', 'quark-1.20.1-4.0-460.jar'],
      ['supplementaries', 'supplementaries-1.20-3.1.42.jar'],
      ['overweight_farming', 'overweight_farming-1.20.1-1.2.jar'],
    ]),
  );
  parser.reset();
});

test('parseLine returns null before reset', () => {
  const p = new ModStartupParser();
  const result = p.parseLine('[00:00:00] [main/INFO] [voicechat/]: hello');
  assert.equal(result, null);
});

test('parseLine tracks INFO as loaded', () => {
  const result = parser.parseLine(
    '[00:06:27] [modloading-worker-0/INFO] [voicechat/]: [voicechat] Compatibility version 20',
  );
  assert.ok(result);
  assert.equal(result.type, 'status');
  assert.equal(result.filename, 'voicechat-1.20.1-2.6.12.jar');
  assert.equal(result.status, 'loaded');
});

test('parseLine tracks WARN as warning', () => {
  const result = parser.parseLine('[00:06:28] [main/WARN] [quark/WP]: Something is not quite right');
  assert.ok(result);
  assert.equal(result.type, 'status');
  assert.equal(result.filename, 'quark-1.20.1-4.0-460.jar');
  assert.equal(result.status, 'warning');
  assert.equal(result.message.level, 'WARN');
  assert.equal(result.message.text, 'Something is not quite right');
});

test('parseLine tracks ERROR as error', () => {
  const result = parser.parseLine('[00:06:39] [Worker-Main-1/ERROR] [create/]: Something broke badly');
  assert.ok(result);
  assert.equal(result.status, 'error');
  assert.equal(result.filename, 'create-1.20.1-0.5.1.f.jar');
});

test('status only escalates, never downgrades', () => {
  parser.parseLine('[00:06:27] [main/ERROR] [voicechat/]: an error');
  parser.parseLine('[00:06:28] [main/WARN] [voicechat/]: a warning');
  parser.parseLine('[00:06:29] [main/INFO] [voicechat/]: loaded fine');

  const status = parser.getStatusForFile('voicechat-1.20.1-2.6.12.jar');
  assert.equal(status.status, 'error'); // stays at error, not downgraded
});

test('stack trace lines are collected', () => {
  parser.parseLine('[00:06:28] [main/WARN] [voicechat/]: Failed to process');
  parser.parseLine('com.google.gson.JsonSyntaxException: bad json');
  parser.parseLine('\tat com.example.Foo.bar(Foo.java:42)');
  parser.parseLine('\tat com.example.Baz.run(Baz.java:10)');
  parser.parseLine('[00:06:29] [main/INFO] [create/]: Create loaded'); // ends stack trace

  const status = parser.getStatusForFile('voicechat-1.20.1-2.6.12.jar');
  assert.equal(status.messages.length, 1);
  assert.ok(status.messages[0].stackTrace);
  assert.equal(status.messages[0].stackTrace.length, 3);
});

test('finalize marks unmapped mods as loaded', () => {
  // Only voicechat appeared in logs
  parser.parseLine('[00:06:27] [modloading-worker-0/INFO] [voicechat/]: loaded');
  parser.finalize();

  // voicechat was explicitly loaded
  assert.equal(parser.getStatusForFile('voicechat-1.20.1-2.6.12.jar').status, 'loaded');
  // create never appeared in logs but should be marked loaded after finalize
  assert.equal(parser.getStatusForFile('create-1.20.1-0.5.1.f.jar').status, 'loaded');
});

test('Done pattern triggers complete event', () => {
  const result = parser.parseLine('[00:07:15] [Server thread/INFO] [minecraft/DedicatedServer]: Done (48.234s)!');
  assert.ok(result);
  assert.equal(result.type, 'complete');
});

test('critical failure detected from LoadingFailedException', () => {
  const result = parser.parseLine(
    '[00:06:05] [main/ERROR] [minecraft/Main]: quark (quark) has failed to load correctly',
  );
  // Note: "minecraft" is in SYSTEM_SOURCES but critical pattern is checked first
  assert.ok(result);
  assert.equal(result.status, 'critical');
  assert.equal(result.filename, 'quark-1.20.1-4.0-460.jar');
});

test('system sources are ignored for normal lines', () => {
  const result = parser.parseLine('[00:06:30] [main/INFO] [minecraft/DedicatedServer]: Starting server');
  assert.equal(result, null);
});

test('getStatuses returns all tracked mods', () => {
  parser.parseLine('[00:06:27] [main/INFO] [voicechat/]: loaded');
  parser.parseLine('[00:06:28] [main/WARN] [create/]: warning msg');

  const statuses = parser.getStatuses();
  assert.ok(statuses['voicechat-1.20.1-2.6.12.jar']);
  assert.ok(statuses['create-1.20.1-0.5.1.f.jar']);
  assert.equal(statuses['voicechat-1.20.1-2.6.12.jar'].status, 'loaded');
  assert.equal(statuses['create-1.20.1-0.5.1.f.jar'].status, 'warning');
});

test('reset clears all state', () => {
  parser.parseLine('[00:06:27] [main/INFO] [voicechat/]: loaded');
  parser.reset();
  assert.equal(Object.keys(parser.getStatuses()).length, 0);
});

test('multiple messages for same mod are collected', () => {
  parser.parseLine('[00:06:28] [main/WARN] [create/]: first warning');
  parser.parseLine('[00:06:29] [main/ERROR] [create/]: then an error');

  const status = parser.getStatusForFile('create-1.20.1-0.5.1.f.jar');
  assert.equal(status.status, 'error');
  assert.equal(status.messages.length, 2);
});

test('fuzzy matching maps source to mod ID', () => {
  // Source "quark-zeta" should fuzzy match to "quark"
  const result = parser.parseLine('[00:06:28] [main/WARN] [quark-zeta/]: config issue');
  assert.ok(result);
  assert.equal(result.filename, 'quark-1.20.1-4.0-460.jar');
});
