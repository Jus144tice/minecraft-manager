// Tests for player management routes (src/routes/players.js) using demo mode.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import http from 'http';
import crypto from 'crypto';
import playerRoutes from '../src/routes/players.js';
import * as Demo from '../src/demoData.js';

let server;
let baseUrl;
let ctx;

// Save original demo data to restore between tests
let origOps, origWhitelist, origBans;

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

  ctx = {
    config: { demoMode: true, serverPath: '.' },
    demoState: { running: true, startTime: Date.now() - 60000 },
    broadcast: () => {},
    broadcastStatus: () => {},
    rconConnected: false,
    rconCmd: async () => '',
  };

  app.use('/api', playerRoutes(ctx));
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
  const raw = await fetch(new URL('/test/login', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  const cookie = raw.headers.get('set-cookie')?.split(';')[0];
  const json = await raw.json();
  return { cookie, csrfToken: json.csrfToken };
}

before(async () => {
  // Snapshot demo data
  origOps = [...Demo.DEMO_OPS];
  origWhitelist = [...Demo.DEMO_WHITELIST];
  origBans = { players: [...Demo.DEMO_BANS.players], ips: [...(Demo.DEMO_BANS.ips || [])] };

  const app = buildTestApp();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

beforeEach(() => {
  // Restore demo data between tests
  Demo.DEMO_OPS.length = 0;
  origOps.forEach((o) => Demo.DEMO_OPS.push({ ...o }));
  Demo.DEMO_WHITELIST.length = 0;
  origWhitelist.forEach((w) => Demo.DEMO_WHITELIST.push({ ...w }));
  Demo.DEMO_BANS.players.length = 0;
  origBans.players.forEach((b) => Demo.DEMO_BANS.players.push({ ...b }));
});

// ===================== Online Players =====================

test('GET /players/online: returns demo online players', async () => {
  const { cookie } = await login();
  const res = await request('GET', '/api/players/online', { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.players));
  assert.ok(res.body.players.length > 0);
  assert.ok(res.body.raw.includes('players online'));
});

test('GET /players/online: returns empty when demo server stopped', async () => {
  ctx.demoState.running = false;
  const { cookie } = await login();
  const res = await request('GET', '/api/players/online', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.players.length, 0);
  ctx.demoState.running = true; // restore
});

// ===================== All Players =====================

test('GET /players/all: returns demo usercache', async () => {
  const { cookie } = await login();
  const res = await request('GET', '/api/players/all', { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
});

// ===================== Operators =====================

test('GET /players/ops: returns demo ops', async () => {
  const { cookie } = await login();
  const res = await request('GET', '/api/players/ops', { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('POST /players/op: adds operator in demo mode', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/op', {
    cookie,
    csrfToken,
    body: { name: 'NewPlayer', level: 2 },
  });
  assert.equal(res.status, 200);
  assert.ok(Demo.DEMO_OPS.some((o) => o.name === 'NewPlayer' && o.level === 2));
});

test('POST /players/op: updates existing op level', async () => {
  const { cookie, csrfToken } = await login();
  const existingName = Demo.DEMO_OPS[0].name;
  const res = await request('POST', '/api/players/op', {
    cookie,
    csrfToken,
    body: { name: existingName, level: 1 },
  });
  assert.equal(res.status, 200);
  assert.equal(Demo.DEMO_OPS.find((o) => o.name === existingName).level, 1);
});

test('POST /players/op: rejects invalid name', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/op', {
    cookie,
    csrfToken,
    body: { name: 'invalid name!', level: 4 },
  });
  assert.equal(res.status, 400);
});

test('POST /players/op: rejects invalid level', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/op', {
    cookie,
    csrfToken,
    body: { name: 'Steve', level: 5 },
  });
  assert.equal(res.status, 400);
});

test('POST /players/op: viewer gets 403', async () => {
  const { cookie, csrfToken } = await login('viewer');
  const res = await request('POST', '/api/players/op', {
    cookie,
    csrfToken,
    body: { name: 'Steve', level: 4 },
  });
  assert.equal(res.status, 403);
});

test('DELETE /players/op/:name: removes operator', async () => {
  const { cookie, csrfToken } = await login();
  const name = Demo.DEMO_OPS[0].name;
  const res = await request('DELETE', `/api/players/op/${name}`, { cookie, csrfToken });
  assert.equal(res.status, 200);
  assert.ok(!Demo.DEMO_OPS.some((o) => o.name === name));
});

// ===================== Whitelist =====================

test('GET /players/whitelist: returns demo whitelist', async () => {
  const { cookie } = await login();
  const res = await request('GET', '/api/players/whitelist', { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('POST /players/whitelist: adds player to whitelist', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/whitelist', {
    cookie,
    csrfToken,
    body: { name: 'NewWLPlayer' },
  });
  assert.equal(res.status, 200);
  assert.ok(Demo.DEMO_WHITELIST.some((w) => w.name === 'NewWLPlayer'));
});

test('POST /players/whitelist: rejects missing name', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/whitelist', {
    cookie,
    csrfToken,
    body: {},
  });
  assert.equal(res.status, 400);
});

test('DELETE /players/whitelist/:name: removes from whitelist', async () => {
  const { cookie, csrfToken } = await login();
  const name = Demo.DEMO_WHITELIST[0].name;
  const res = await request('DELETE', `/api/players/whitelist/${name}`, { cookie, csrfToken });
  assert.equal(res.status, 200);
  assert.ok(!Demo.DEMO_WHITELIST.some((w) => w.name === name));
});

// ===================== Bans =====================

test('GET /players/banned: returns demo bans', async () => {
  const { cookie } = await login();
  const res = await request('GET', '/api/players/banned', { cookie });
  assert.equal(res.status, 200);
  assert.ok(res.body.players !== undefined);
});

test('POST /players/ban: bans a player', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/ban', {
    cookie,
    csrfToken,
    body: { name: 'Griefer123', reason: 'Griefing' },
  });
  assert.equal(res.status, 200);
  assert.ok(Demo.DEMO_BANS.players.some((b) => b.name === 'Griefer123'));
});

test('POST /players/ban: rejects invalid name', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/ban', {
    cookie,
    csrfToken,
    body: { name: '<script>alert(1)</script>' },
  });
  assert.equal(res.status, 400);
});

test('DELETE /players/ban/:name: unbans a player', async () => {
  const { cookie, csrfToken } = await login();
  // First ban someone
  await request('POST', '/api/players/ban', {
    cookie,
    csrfToken,
    body: { name: 'TempBan', reason: 'test' },
  });
  const res = await request('DELETE', '/api/players/ban/TempBan', { cookie, csrfToken });
  assert.equal(res.status, 200);
  assert.ok(!Demo.DEMO_BANS.players.some((b) => b.name === 'TempBan'));
});

// ===================== Kick =====================

test('POST /players/kick: kicks player in demo mode', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/kick', {
    cookie,
    csrfToken,
    body: { name: 'Steve', reason: 'AFK' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('POST /players/kick: rejects missing name', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/kick', {
    cookie,
    csrfToken,
    body: { reason: 'test' },
  });
  assert.equal(res.status, 400);
});

// ===================== Say / Broadcast =====================

test('POST /players/say: broadcasts message in demo mode', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/say', {
    cookie,
    csrfToken,
    body: { message: 'Hello everyone!' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('POST /players/say: rejects empty message', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/players/say', {
    cookie,
    csrfToken,
    body: {},
  });
  assert.equal(res.status, 400);
});

// ===================== Player Profile =====================

test('GET /players/profile/:name: returns aggregated profile', async () => {
  const { cookie } = await login();
  const name = Demo.DEMO_OPS[0].name;
  const res = await request('GET', `/api/players/profile/${name}`, { cookie });
  assert.equal(res.status, 200);
  assert.ok(res.body.name);
  assert.ok(res.body.op !== undefined);
  assert.ok(res.body.whitelisted !== undefined);
  assert.ok(res.body.online !== undefined);
});

test('GET /players/profile/:name: rejects invalid name', async () => {
  const { cookie } = await login();
  const res = await request('GET', '/api/players/profile/invalid name!', { cookie });
  assert.equal(res.status, 400);
});

// ===================== Auth on mutating endpoints =====================

test('POST /players/ban: unauthenticated gets 401', async () => {
  const res = await request('POST', '/api/players/ban', { body: { name: 'Steve' } });
  assert.equal(res.status, 401);
});

test('POST /players/whitelist: viewer gets 403', async () => {
  const { cookie, csrfToken } = await login('viewer');
  const res = await request('POST', '/api/players/whitelist', {
    cookie,
    csrfToken,
    body: { name: 'Steve' },
  });
  assert.equal(res.status, 403);
});
