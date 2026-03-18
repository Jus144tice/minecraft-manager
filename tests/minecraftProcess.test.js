// Tests for src/minecraftProcess.js — class behavior, logging, uptime, state.
// Uses a mock spawn to avoid real child processes (which cause test-runner
// hangs on Windows under high concurrency).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { MinecraftProcess } from '../src/minecraftProcess.js';

// --- Mock spawn helper ---

function createMockProc() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.pid = 12345;
  proc.kill = mock.fn(() => {
    setImmediate(() => proc.emit('close', null));
  });
  return proc;
}

function createMc() {
  let proc;
  const mc = new MinecraftProcess({
    spawn: mock.fn(() => {
      proc = createMockProc();
      return proc;
    }),
  });
  return { mc, getProc: () => proc };
}

// --- Constructor / initial state ---

test('MinecraftProcess: initial state is stopped', () => {
  const { mc } = createMc();
  assert.equal(mc.running, false);
  assert.equal(mc.stopping, false);
  assert.equal(mc.proc, null);
  assert.equal(mc.startTime, null);
  assert.equal(mc.readyTime, null);
  assert.deepEqual(mc.logs, []);
});

// --- start() guards ---

test('start: throws if launch config missing executable', () => {
  const { mc } = createMc();
  assert.throws(() => mc.start({}, '/tmp'), { message: /missing executable/ });
  assert.throws(() => mc.start(null, '/tmp'), { message: /missing executable/ });
});

test('start: throws if already running', () => {
  const { mc } = createMc();
  mc.start({ executable: 'java', args: ['-jar', 'server.jar'] }, '.');
  assert.throws(() => mc.start({ executable: 'java' }, '.'), {
    message: /already running/,
  });
});

// --- start() sets state correctly ---

test('start: sets running, startTime, clears readyTime', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java', args: ['-jar', 'server.jar'] }, '.');

  assert.equal(mc.running, true);
  assert.equal(mc.stopping, false);
  assert.equal(typeof mc.startTime, 'number');
  assert.equal(mc.readyTime, null);
  assert.equal(mc.proc, getProc());
});

// --- Logging ---

test('start: logs startup messages', () => {
  const { mc } = createMc();
  mc.start({ executable: 'java', args: ['-jar', 'server.jar'] }, '/srv/mc');

  const lines = mc.logs.map((l) => l.line);
  assert.ok(lines.some((l) => l.includes('[Manager] Server process starting')));
  assert.ok(lines.some((l) => l.includes('/srv/mc')));
  assert.ok(lines.some((l) => l.includes('java')));
});

test('start: captures stdout lines', () => {
  const { mc, getProc } = createMc();
  const logs = [];
  mc.on('log', (entry) => logs.push(entry));

  mc.start({ executable: 'java' }, '.');
  getProc().stdout.emit('data', 'hello world\n');

  const lines = logs.map((l) => l.line);
  assert.ok(lines.some((l) => l === 'hello world'));
});

test('start: captures stderr with [STDERR] prefix', () => {
  const { mc, getProc } = createMc();
  const logs = [];
  mc.on('log', (entry) => logs.push(entry));

  mc.start({ executable: 'java' }, '.');
  getProc().stderr.emit('data', 'oops\n');

  const lines = logs.map((l) => l.line);
  assert.ok(lines.some((l) => l === '[STDERR] oops'));
});

test('start: skips blank lines from stdout', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java' }, '.');

  const before = mc.logs.length;
  getProc().stdout.emit('data', '\n  \n');
  assert.equal(mc.logs.length, before, 'blank lines should not be logged');
});

test('log circular buffer: caps at MAX_LOGS', () => {
  const { mc } = createMc();
  for (let i = 0; i < 2050; i++) {
    mc._log(`line ${i}`);
  }
  assert.equal(mc.logs.length, 2000);
  assert.equal(mc.logs[0].line, 'line 50');
  assert.equal(mc.logs[1999].line, 'line 2049');
});

// --- close event ---

test('close: sets state to stopped and emits stopped event', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java' }, '.');

  let stoppedArgs = null;
  mc.on('stopped', (...args) => {
    stoppedArgs = args;
  });

  getProc().emit('close', 0);

  assert.equal(mc.running, false);
  assert.equal(mc.stopping, false);
  assert.equal(mc.proc, null);
  assert.equal(mc.startTime, null);
  assert.equal(mc.readyTime, null);
  assert.deepEqual(stoppedArgs[0], 0);
  assert.equal(typeof stoppedArgs[1], 'number');
});

test('close: logs stop message with exit code', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java' }, '.');
  getProc().emit('close', 42);

  const lines = mc.logs.map((l) => l.line);
  assert.ok(lines.some((l) => l.includes('exit code: 42')));
});

test('close: handles null exit code', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java' }, '.');
  getProc().emit('close', null);

  const lines = mc.logs.map((l) => l.line);
  assert.ok(lines.some((l) => l.includes('exit code: unknown')));
});

// --- error event ---

test('error: clears state and emits error', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java' }, '.');

  let emittedErr = null;
  mc.on('error', (e) => {
    emittedErr = e;
  });

  const err = new Error('spawn ENOENT');
  getProc().emit('error', err);

  assert.equal(mc.running, false);
  assert.equal(mc.proc, null);
  assert.equal(emittedErr, err);
});

test('error: destroys stdio streams', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java' }, '.');
  // Catch the re-emitted error so it doesn't throw
  mc.on('error', () => {});

  const proc = getProc();
  const stdinDestroyed = mock.fn();
  const stdoutDestroyed = mock.fn();
  const stderrDestroyed = mock.fn();
  proc.stdin.destroy = stdinDestroyed;
  proc.stdout.destroy = stdoutDestroyed;
  proc.stderr.destroy = stderrDestroyed;

  proc.emit('error', new Error('spawn ENOENT'));

  assert.equal(stdinDestroyed.mock.callCount(), 1);
  assert.equal(stdoutDestroyed.mock.callCount(), 1);
  assert.equal(stderrDestroyed.mock.callCount(), 1);
});

// --- stop() ---

test('stop: throws if not running', () => {
  const { mc } = createMc();
  assert.throws(() => mc.stop(), { message: /not running/ });
});

test('stop: writes stop command to stdin and sets stopping flag', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java' }, '.');

  const written = [];
  getProc().stdin.write = mock.fn((data) => written.push(data));

  mc.stop();
  assert.equal(mc.stopping, true);
  assert.ok(written.includes('stop\n'));
});

// --- kill() ---

test('kill: calls proc.kill with SIGKILL', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java' }, '.');

  mc.kill();
  const proc = getProc();
  assert.equal(proc.kill.mock.callCount(), 1);
  assert.deepEqual(proc.kill.mock.calls[0].arguments, ['SIGKILL']);
});

test('kill: no-op if proc is null', () => {
  const { mc } = createMc();
  mc.kill();
});

// --- sendConsoleCommand() ---

test('sendConsoleCommand: throws if not running', () => {
  const { mc } = createMc();
  assert.throws(() => mc.sendConsoleCommand('list'), { message: /not running/ });
});

test('sendConsoleCommand: writes command to stdin and logs it', () => {
  const { mc, getProc } = createMc();
  mc.start({ executable: 'java' }, '.');

  const written = [];
  getProc().stdin.write = mock.fn((data) => written.push(data));

  mc.sendConsoleCommand('list');

  assert.ok(written.includes('list\n'));
  const lines = mc.logs.map((l) => l.line);
  assert.ok(lines.some((l) => l === '> list'));
});

// --- getUptime() ---

test('getUptime: returns null when not running', () => {
  const { mc } = createMc();
  assert.equal(mc.getUptime(), null);
});

test('getUptime: returns null when running but readyTime not set', () => {
  const { mc } = createMc();
  mc.start({ executable: 'java' }, '.');
  assert.equal(mc.running, true);
  assert.equal(mc.readyTime, null);
  assert.equal(mc.getUptime(), null);
});

test('getUptime: returns seconds since readyTime when set', () => {
  const { mc } = createMc();
  mc.start({ executable: 'java' }, '.');
  mc.readyTime = Date.now() - 5000;
  const uptime = mc.getUptime();
  assert.ok(uptime >= 4 && uptime <= 6, `Uptime should be ~5s, got ${uptime}`);
});
