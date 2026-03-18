// Tests for crash detection and auto-restart logic in src/services.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createServices } from '../src/services.js';

// Helper: create a mock MinecraftProcess
function mockMc() {
  const mc = new EventEmitter();
  mc.proc = null;
  mc.running = false;
  mc.stopping = false;
  mc.startTime = null;
  mc.readyTime = null;
  mc.logs = [];
  mc.start = function () {
    this.running = true;
    this.startTime = Date.now();
  };
  mc.stop = function () {
    this.stopping = true;
  };
  mc.getUptime = function () {
    if (!this.running || !this.readyTime) return null;
    return Math.floor((Date.now() - this.readyTime) / 1000);
  };
  return mc;
}

// Helper: create services with defaults
function setup(overrides = {}) {
  const mc = mockMc();
  const broadcasts = [];
  const config = {
    autoRestart: true,
    demoMode: false,
    launch: { executable: 'node' },
    serverPath: '.',
    ...overrides,
  };
  const ctx = createServices({
    config,
    saveConfig: async () => {},
    loadConfig: async () => config,
    mc,
    broadcast: (msg) => broadcasts.push(msg),
    broadcastStatus: () => {},
  });
  return { mc, ctx, broadcasts, config };
}

// --- Intentional stop: no crash handling ---

test('crash detection: intentional stop does not trigger crash handling', () => {
  const { mc, ctx, broadcasts } = setup();
  ctx.markIntentionalStop();
  mc.emit('stopped', 1, 120); // non-zero exit code, but intentional
  const crashMsgs = broadcasts.filter((b) => b.type === 'crash');
  assert.equal(crashMsgs.length, 0, 'No crash messages for intentional stop');
});

// --- Clean exit (code 0): not a crash ---

test('crash detection: clean exit (code 0) does not trigger crash handling', () => {
  const { mc, broadcasts } = setup();
  mc.emit('stopped', 0, 120);
  const crashMsgs = broadcasts.filter((b) => b.type === 'crash');
  assert.equal(crashMsgs.length, 0, 'No crash messages for clean exit');
});

// --- Null exit code: not a crash ---

test('crash detection: null exit code does not trigger crash handling', () => {
  const { mc, broadcasts } = setup();
  mc.emit('stopped', null, 120);
  const crashMsgs = broadcasts.filter((b) => b.type === 'crash');
  assert.equal(crashMsgs.length, 0, 'No crash messages for null exit code');
});

// --- Demo mode: no crash handling ---

test('crash detection: demo mode ignores crashes', () => {
  const { mc, broadcasts } = setup({ demoMode: true });
  mc.emit('stopped', 1, 120);
  const crashMsgs = broadcasts.filter((b) => b.type === 'crash');
  assert.equal(crashMsgs.length, 0, 'No crash messages in demo mode');
});

// --- Crash detected, auto-restart disabled ---

test('crash detection: broadcasts crash when auto-restart disabled', () => {
  const { mc, broadcasts } = setup({ autoRestart: false });
  mc.emit('stopped', 1, 120);
  const crashMsgs = broadcasts.filter((b) => b.type === 'crash');
  assert.ok(crashMsgs.length >= 1, 'Should broadcast crash notification');
  assert.ok(crashMsgs[0].message.includes('exit code 1'));
});

// --- Startup crash: skips auto-restart ---

test('crash detection: startup crash (short uptime) skips auto-restart', () => {
  const { mc, broadcasts } = setup();
  mc.emit('stopped', 1, 5); // 5 seconds uptime — below MIN_RUNTIME_MS (30s)
  const crashMsgs = broadcasts.filter((b) => b.type === 'crash');
  assert.ok(crashMsgs.length >= 1, 'Should broadcast crash');
  assert.ok(
    crashMsgs.some((m) => m.message.includes('Startup crash')),
    'Should indicate startup crash',
  );
  // Should NOT have autoRestarting flag
  assert.ok(!crashMsgs.some((m) => m.autoRestarting), 'Should not auto-restart on startup crash');
});

// --- Normal crash: schedules auto-restart ---

test('crash detection: normal crash schedules auto-restart', () => {
  const { mc, ctx, broadcasts } = setup();
  mc.emit('stopped', 1, 120); // 120 seconds uptime — above MIN_RUNTIME_MS
  const crashMsgs = broadcasts.filter((b) => b.type === 'crash');
  assert.ok(crashMsgs.length >= 1, 'Should broadcast crash');
  assert.ok(
    crashMsgs.some((m) => m.autoRestarting === true),
    'Should indicate auto-restarting',
  );
  assert.ok(
    crashMsgs.some((m) => m.message.includes('attempt 1/3')),
    'Should show attempt count',
  );
  // Clean up timer
  ctx.cleanup();
});

// --- Rate limiting: max restarts in window ---

test('crash detection: rate limits after MAX_RESTARTS (3)', () => {
  const { mc, ctx, broadcasts } = setup();

  // Simulate 3 crashes — all should trigger auto-restart
  mc.emit('stopped', 1, 120);
  mc.emit('stopped', 1, 120);
  mc.emit('stopped', 1, 120);

  // 4th crash should hit rate limit
  mc.emit('stopped', 1, 120);
  const crashMsgs = broadcasts.filter((b) => b.type === 'crash');
  assert.ok(
    crashMsgs.some((m) => m.message.includes('limit reached')),
    'Should hit rate limit message',
  );

  ctx.cleanup();
});

// --- markIntentionalStop resets after use ---

test('crash detection: intentionalStop flag resets after one exit', () => {
  const { mc, ctx, broadcasts } = setup({ autoRestart: false });
  ctx.markIntentionalStop();
  mc.emit('stopped', 0, 60); // intentional, clean exit

  // Second exit should NOT be treated as intentional
  mc.emit('stopped', 1, 120); // crash
  const crashMsgs = broadcasts.filter((b) => b.type === 'crash');
  assert.ok(crashMsgs.length >= 1, 'Second exit should trigger crash detection');
});

// --- cleanup() clears timers ---

test('cleanup: clears all timers without throwing', () => {
  const { ctx } = setup();
  // Should not throw even if no timers are active
  ctx.cleanup();
  ctx.cleanup(); // double cleanup should be safe
});
