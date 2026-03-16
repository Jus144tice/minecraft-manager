// Tests for user management routes in src/routes/users.js.
// Uses a lightweight Express test server with mocked DB functions.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import http from 'http';
import crypto from 'crypto';
import { requireCapability } from '../src/middleware.js';
import { ROLES, ROLE_ORDER } from '../src/permissions.js';

// --- Mock DB state ---
let mockUsers = [];

function resetMockUsers() {
  mockUsers = [
    { id: 1, email: 'owner@test.com', name: 'Owner', provider: 'local', role: 'owner', admin_level: 1 },
    { id: 2, email: 'viewer@test.com', name: 'Viewer', provider: 'local', role: 'viewer', admin_level: 0 },
    { id: 3, email: 'mod@test.com', name: 'Moderator', provider: 'google', role: 'moderator', admin_level: 0 },
  ];
}

// --- Build test app that mirrors the users route ---
let server;
let baseUrl;

function buildTestApp() {
  const app = express();
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: false, sameSite: 'lax' },
    }),
  );
  app.use(express.json());

  // Test-only login endpoint
  app.post('/test/login', (req, res) => {
    const role = req.body.role || 'owner';
    req.session.user = {
      email: req.body.email || 'owner@test.com',
      name: 'Test',
      provider: 'local',
      role,
    };
    req.session.csrfToken = crypto.randomBytes(16).toString('hex');
    req.session.save(() => res.json({ ok: true, csrfToken: req.session.csrfToken }));
  });

  // Mount user routes inline (avoids importing the module which pulls in real DB)
  const { Router } = express;
  const router = Router();

  router.get('/users', requireCapability('panel.manage_users'), async (_req, res) => {
    res.json(mockUsers);
  });

  router.get('/users/:email', requireCapability('panel.manage_users'), async (req, res) => {
    const user = mockUsers.find((u) => u.email === req.params.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });

  router.put('/users/:email/role', requireCapability('panel.manage_users'), async (req, res) => {
    const { role } = req.body;
    if (!ROLE_ORDER.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${ROLE_ORDER.join(', ')}` });
    }
    const user = mockUsers.find((u) => u.email === req.params.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.role = role;
    res.json(user);
  });

  router.delete('/users/:email', requireCapability('panel.manage_users'), async (req, res) => {
    if (req.params.email === req.session.user.email) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const idx = mockUsers.findIndex((u) => u.email === req.params.email);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    mockUsers.splice(idx, 1);
    res.json({ ok: true });
  });

  router.get('/roles', (_req, res) => {
    const roles = {};
    for (const [key, role] of Object.entries(ROLES)) {
      roles[key] = { name: role.name, level: role.level, description: role.description };
    }
    res.json(roles);
  });

  app.use('/api', router);
  return app;
}

// --- Helpers ---

async function request(method, path, { cookie, body, csrfToken } = {}) {
  const url = new URL(path, baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, headers: res.headers };
}

async function login(role = 'owner', email = 'owner@test.com') {
  const res = await request('POST', '/test/login', { body: { role, email } });
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie?.split(';')[0];
  return { cookie, csrfToken: res.body.csrfToken };
}

// --- Lifecycle ---

before(async () => {
  const app = buildTestApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => server?.close());

beforeEach(() => resetMockUsers());

// --- GET /roles (public) ---

test('GET /roles: returns all 5 role definitions without auth', async () => {
  const res = await request('GET', '/api/roles');
  assert.equal(res.status, 200);
  const roles = res.body;
  assert.equal(Object.keys(roles).length, 5);
  assert.ok(roles.viewer);
  assert.ok(roles.operator);
  assert.ok(roles.moderator);
  assert.ok(roles.admin);
  assert.ok(roles.owner);
  assert.equal(roles.viewer.level, 0);
  assert.equal(roles.owner.level, 4);
});

// --- GET /users (requires panel.manage_users) ---

test('GET /users: owner can list users', async () => {
  const { cookie } = await login('owner');
  const res = await request('GET', '/api/users', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 3);
});

test('GET /users: viewer gets 403', async () => {
  const { cookie } = await login('viewer', 'viewer@test.com');
  const res = await request('GET', '/api/users', { cookie });
  assert.equal(res.status, 403);
});

test('GET /users: unauthenticated gets 401', async () => {
  const res = await request('GET', '/api/users');
  assert.equal(res.status, 401);
});

test('GET /users: admin gets 403 (only owner has panel.manage_users)', async () => {
  const { cookie } = await login('admin', 'admin@test.com');
  const res = await request('GET', '/api/users', { cookie });
  assert.equal(res.status, 403);
});

// --- GET /users/:email ---

test('GET /users/:email: returns specific user', async () => {
  const { cookie } = await login('owner');
  const res = await request('GET', '/api/users/viewer@test.com', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'viewer@test.com');
  assert.equal(res.body.role, 'viewer');
});

test('GET /users/:email: returns 404 for unknown user', async () => {
  const { cookie } = await login('owner');
  const res = await request('GET', '/api/users/nobody@test.com', { cookie });
  assert.equal(res.status, 404);
});

// --- PUT /users/:email/role ---

test('PUT /users/:email/role: owner can set role to moderator', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('PUT', '/api/users/viewer@test.com/role', {
    cookie,
    csrfToken,
    body: { role: 'moderator' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'moderator');
});

test('PUT /users/:email/role: rejects invalid role name', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('PUT', '/api/users/viewer@test.com/role', {
    cookie,
    csrfToken,
    body: { role: 'superadmin' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('Invalid role'));
});

test('PUT /users/:email/role: returns 404 for unknown user', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('PUT', '/api/users/nobody@test.com/role', {
    cookie,
    csrfToken,
    body: { role: 'admin' },
  });
  assert.equal(res.status, 404);
});

test('PUT /users/:email/role: all 5 roles are accepted', async () => {
  const { cookie, csrfToken } = await login('owner');
  for (const role of ROLE_ORDER) {
    const res = await request('PUT', '/api/users/viewer@test.com/role', {
      cookie,
      csrfToken,
      body: { role },
    });
    assert.equal(res.status, 200, `Role "${role}" should be accepted`);
  }
});

// --- DELETE /users/:email ---

test('DELETE /users/:email: owner can delete another user', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('DELETE', '/api/users/viewer@test.com', { cookie, csrfToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(mockUsers.length, 2);
});

test('DELETE /users/:email: cannot delete self', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('DELETE', '/api/users/owner@test.com', { cookie, csrfToken });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('own account'));
});

test('DELETE /users/:email: returns 404 for unknown user', async () => {
  const { cookie, csrfToken } = await login('owner');
  const res = await request('DELETE', '/api/users/nobody@test.com', { cookie, csrfToken });
  assert.equal(res.status, 404);
});
