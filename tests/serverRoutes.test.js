// Tests for server control routes (src/routes/server.js) using demo mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import http from 'http';
import crypto from 'crypto';
import serverRoutes from '../src/routes/server.js';

let server;
let baseUrl;
let testCtx;

function buildTestApp() {
  const app = express();
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use(express.json());

  app.post('/test/login', (req, res) => {
    req.session.user = {
      email: req.body.email || 'admin@test.com',
      name: 'Admin',
      provider: 'local',
      role: req.body.role || 'owner',
    };
    req.session.csrfToken = crypto.randomBytes(16).toString('hex');
    req.session.save(() => res.json({ ok: true, csrfToken: req.session.csrfToken }));
  });

  const broadcasts = [];
  const demoState = {
    running: true,
    startTime: Date.now() - 60000,
    activityIndex: 0,
    activityTimer: null,
    startupTimers: [],
  };

  const ctx = {
    config: { demoMode: true },
    demoState,
    broadcast: (msg) => broadcasts.push(msg),
    broadcastStatus: () => {},
    startDemoActivityTimer: () => {},
    stopDemoActivityTimer: () => {},
    clearDemoStartupTimers: () => {
      for (const id of demoState.startupTimers) clearTimeout(id);
      demoState.startupTimers = [];
    },
    markIntentionalStop: () => {},
    rconConnected: false,
    mc: { running: false, stopping: false },
    rconCmd: async () => '',
    _broadcasts: broadcasts,
  };

  app.use('/api', serverRoutes(ctx));
  testCtx = ctx;
  return app;
}

async function request(method, path, { cookie, body, csrfToken } = {}) {
  const url = new URL(path, baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function login(role = 'owner') {
  const rawCookie = await fetch(new URL('/test/login', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  const cookie = rawCookie.headers.get('set-cookie')?.split(';')[0];
  const json = await rawCookie.json();
  return { cookie, csrfToken: json.csrfToken };
}

before(async () => {
  const app = buildTestApp();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  testCtx?.clearDemoStartupTimers();
  server?.close();
});

// --- Auth checks ---

test('POST /server/start: requires auth', async () => {
  const res = await request('POST', '/api/server/start', { body: {} });
  assert.equal(res.status, 401);
});

test('POST /server/start: viewer gets 403', async () => {
  const { cookie, csrfToken } = await login('viewer');
  const res = await request('POST', '/api/server/start', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 403);
});

// --- Start (demo mode) ---

test('POST /server/start: starts demo server', async () => {
  const { cookie, csrfToken } = await login('owner');
  // Ensure server is stopped first
  await request('POST', '/api/server/stop', { cookie, csrfToken, body: {} });
  const res = await request('POST', '/api/server/start', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.message.includes('DEMO'));
});

test('POST /server/start: rejects when already running', async () => {
  const { cookie, csrfToken } = await login('owner');
  // Make sure it's running
  await request('POST', '/api/server/start', { cookie, csrfToken, body: {} });
  // Start again — should fail
  const res2 = await request('POST', '/api/server/start', { cookie, csrfToken, body: {} });
  assert.equal(res2.status, 400);
  assert.ok(res2.body.error.includes('already running'));
});

// --- Stop (demo mode) ---

test('POST /server/stop: stops demo server', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('POST', '/api/server/stop', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('POST /server/stop: rejects when already stopped', async () => {
  const { cookie, csrfToken } = await login('owner');
  // Stop first
  await request('POST', '/api/server/stop', { cookie, csrfToken, body: {} });
  const res = await request('POST', '/api/server/stop', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('not running'));
});

// --- Kill (demo mode) ---

test('POST /server/kill: kills demo server', async () => {
  const { cookie, csrfToken } = await login('owner');
  // Ensure running first
  await request('POST', '/api/server/start', { cookie, csrfToken, body: {} });
  const res = await request('POST', '/api/server/kill', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

// --- Restart (demo mode) ---

test('POST /server/restart: restarts demo server', async () => {
  const { cookie, csrfToken } = await login('owner');
  // Ensure running
  await request('POST', '/api/server/start', { cookie, csrfToken, body: {} });
  const res = await request('POST', '/api/server/restart', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 200);
  assert.ok(res.body.message.includes('DEMO'));
});

// --- Command (demo mode) ---

test('POST /server/command: requires command field', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('POST', '/api/server/command', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('command required'));
});

test('POST /server/command: rejects null bytes in command', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('POST', '/api/server/command', {
    cookie,
    csrfToken,
    body: { command: 'list\0injected' },
  });
  assert.equal(res.status, 400);
});

test('POST /server/command: executes safe command in demo mode', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('POST', '/api/server/command', {
    cookie,
    csrfToken,
    body: { command: 'list' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.result.includes('DEMO'));
});

// --- Stdin (demo mode) ---

test('POST /server/stdin: echoes command in demo mode', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('POST', '/api/server/stdin', {
    cookie,
    csrfToken,
    body: { command: 'help' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('POST /server/stdin: rejects empty command', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('POST', '/api/server/stdin', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 400);
});

// --- Regenerate world (demo mode) ---

test('POST /server/regenerate-world: succeeds in demo mode', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('POST', '/api/server/regenerate-world', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 200);
  assert.ok(res.body.message.includes('DEMO'));
});
