// Tests for structured logging in src/audit.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, info, warn } from '../src/audit.js';

// Helper: capture console output during a callback
function captureLog(method, fn) {
  const logs = [];
  const orig = console[method];
  console[method] = (msg) => logs.push(msg);
  try {
    fn();
  } finally {
    console[method] = orig;
  }
  return logs;
}

test('audit: outputs JSON with level=AUDIT and action', () => {
  const logs = captureLog('log', () => audit('mod.install', { filename: 'jei.jar' }));
  assert.equal(logs.length, 1);
  const entry = JSON.parse(logs[0]);
  assert.equal(entry.level, 'AUDIT');
  assert.equal(entry.action, 'mod.install');
  assert.equal(entry.filename, 'jei.jar');
  assert.ok(entry.time);
});

test('audit: includes ISO timestamp', () => {
  const logs = captureLog('log', () => audit('test.action'));
  const entry = JSON.parse(logs[0]);
  assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T/);
});

test('info: outputs JSON with level=INFO and message', () => {
  const logs = captureLog('log', () => info('Server started', { port: 3000 }));
  const entry = JSON.parse(logs[0]);
  assert.equal(entry.level, 'INFO');
  assert.equal(entry.message, 'Server started');
  assert.equal(entry.port, 3000);
});

test('warn: outputs JSON with level=WARN to stderr', () => {
  const logs = captureLog('warn', () => warn('Disk space low', { pct: 95 }));
  const entry = JSON.parse(logs[0]);
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.message, 'Disk space low');
  assert.equal(entry.pct, 95);
});

test('audit: detail properties are spread into entry', () => {
  const logs = captureLog('log', () => audit('config.save', { key: 'motd', value: 'Hello' }));
  const entry = JSON.parse(logs[0]);
  assert.equal(entry.key, 'motd');
  assert.equal(entry.value, 'Hello');
});

test('info: works with no details', () => {
  const logs = captureLog('log', () => info('Simple message'));
  const entry = JSON.parse(logs[0]);
  assert.equal(entry.level, 'INFO');
  assert.equal(entry.message, 'Simple message');
  assert.deepEqual(Object.keys(entry).sort(), ['level', 'message', 'time']);
});
