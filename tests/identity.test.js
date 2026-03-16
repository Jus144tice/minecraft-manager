// Tests for identity routes in src/routes/identity.js.
// Uses a lightweight Express test server with mocked panelLinks and challenge system.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import http from 'http';
import crypto from 'crypto';
import { requireCapability } from '../src/middleware.js';
import { isValidMinecraftName } from '../src/validate.js';

// --- Mock state ---
let mockLinks = new Map();
let mockChallenges = new Map();

function resetMockState() {
  mockLinks.clear();
  mockChallenges.clear();
}

// Mock panelLinks API
const mockPanelLinks = {
  getLink(email) {
    return mockLinks.get(email) || null;
  },
  getLinkByMinecraftName(name) {
    for (const link of mockLinks.values()) {
      if (link.minecraftName.toLowerCase() === name.toLowerCase()) return link;
    }
    return null;
  },
  setLink(email, minecraftName, linkedBy, verified) {
    mockLinks.set(email, { email, minecraftName, linkedBy, verified, linkedAt: new Date().toISOString() });
  },
  removeLink(email) {
    return mockLinks.delete(email);
  },
  getAllLinks() {
    return [...mockLinks.values()];
  },
};

// --- Build test app ---
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

  // Test login
  app.post('/test/login', (req, res) => {
    req.session.user = {
      email: req.body.email || 'user@test.com',
      name: 'Test',
      provider: 'local',
      role: req.body.role || 'viewer',
      adminLevel: 0,
    };
    req.session.csrfToken = crypto.randomBytes(16).toString('hex');
    req.session.save(() => res.json({ ok: true, csrfToken: req.session.csrfToken }));
  });

  // Mount identity-like routes inline (avoids importing full module with all deps)
  const { Router } = express;
  const router = Router();

  // GET /identity/me
  router.get('/identity/me', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });
    const { email, name, provider, role } = req.session.user;
    const result = { email, name, provider, role: role || 'viewer' };
    const link = mockPanelLinks.getLink(email);
    if (link) {
      result.minecraft = {
        name: link.minecraftName,
        verified: link.verified,
        linkedAt: link.linkedAt,
      };
    }
    res.json(result);
  });

  // POST /identity/link
  router.post('/identity/link', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });
    const { minecraftName } = req.body;
    if (!minecraftName) return res.status(400).json({ error: 'minecraftName required' });
    if (!isValidMinecraftName(minecraftName)) return res.status(400).json({ error: 'Invalid Minecraft player name' });

    const email = req.session.user.email;
    const existing = mockPanelLinks.getLink(email);
    if (existing) return res.status(409).json({ error: `Already linked to ${existing.minecraftName}. Unlink first.` });

    const existingClaim = mockPanelLinks.getLinkByMinecraftName(minecraftName);
    if (existingClaim && existingClaim.email !== email) {
      return res.status(409).json({ error: `${minecraftName} is already linked to another panel account.` });
    }

    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    mockChallenges.set(email, { code, minecraftName });
    res.json({ code, minecraftName, expiresInMinutes: 5, instructions: `Type: !link ${code}` });
  });

  // GET /identity/link/status
  router.get('/identity/link/status', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });
    const email = req.session.user.email;
    const link = mockPanelLinks.getLink(email);
    if (link) return res.json({ linked: true, minecraftName: link.minecraftName, verified: link.verified });
    const pending = mockChallenges.get(email);
    if (pending)
      return res.json({ linked: false, pending: true, code: pending.code, minecraftName: pending.minecraftName });
    res.json({ linked: false, pending: false });
  });

  // DELETE /identity/link
  router.delete('/identity/link', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });
    const existed = mockPanelLinks.removeLink(req.session.user.email);
    res.json({ ok: true, existed });
  });

  // GET /panel-links (admin)
  router.get('/panel-links', requireCapability('identity.view_links'), (_req, res) => {
    res.json(mockPanelLinks.getAllLinks());
  });

  // POST /panel-link (admin)
  router.post('/panel-link', requireCapability('panel.link_identities'), (req, res) => {
    const { email, minecraftName } = req.body;
    if (!email || !minecraftName) return res.status(400).json({ error: 'email and minecraftName required' });
    if (!isValidMinecraftName(minecraftName)) return res.status(400).json({ error: 'Invalid player name' });
    mockPanelLinks.setLink(email, minecraftName, `admin:${req.session.user.email}`, false);
    res.json({ ok: true });
  });

  // DELETE /panel-link/:email (admin)
  router.delete('/panel-link/:email', requireCapability('panel.link_identities'), (req, res) => {
    const existed = mockPanelLinks.removeLink(req.params.email);
    res.json({ ok: true, existed });
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

async function login(role = 'viewer', email = 'user@test.com') {
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
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());
beforeEach(() => resetMockState());

// --- GET /identity/me ---

test('identity/me: unauthenticated returns 401', async () => {
  const res = await request('GET', '/api/identity/me');
  assert.equal(res.status, 401);
});

test('identity/me: authenticated returns user info', async () => {
  const { cookie } = await login();
  const res = await request('GET', '/api/identity/me', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'user@test.com');
  assert.equal(res.body.role, 'viewer');
  assert.equal(res.body.minecraft, undefined);
});

test('identity/me: includes minecraft info when linked', async () => {
  mockPanelLinks.setLink('user@test.com', 'Steve', 'self', true);
  const { cookie } = await login();
  const res = await request('GET', '/api/identity/me', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.minecraft.name, 'Steve');
  assert.equal(res.body.minecraft.verified, true);
});

// --- POST /identity/link ---

test('identity/link: unauthenticated returns 401', async () => {
  const res = await request('POST', '/api/identity/link', { body: { minecraftName: 'Steve' } });
  assert.equal(res.status, 401);
});

test('identity/link: missing minecraftName returns 400', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/identity/link', { cookie, csrfToken, body: {} });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('required'));
});

test('identity/link: invalid MC name returns 400', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/identity/link', {
    cookie,
    csrfToken,
    body: { minecraftName: 'invalid name with spaces!!!' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('Invalid'));
});

test('identity/link: valid MC name returns challenge code', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/identity/link', {
    cookie,
    csrfToken,
    body: { minecraftName: 'Steve' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.code);
  assert.equal(res.body.minecraftName, 'Steve');
  assert.ok(res.body.instructions);
});

test('identity/link: already linked returns 409', async () => {
  mockPanelLinks.setLink('user@test.com', 'Alex', 'self', true);
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/identity/link', {
    cookie,
    csrfToken,
    body: { minecraftName: 'Steve' },
  });
  assert.equal(res.status, 409);
  assert.ok(res.body.error.includes('Already linked'));
});

test('identity/link: MC name claimed by another user returns 409', async () => {
  mockPanelLinks.setLink('other@test.com', 'Steve', 'self', true);
  const { cookie, csrfToken } = await login();
  const res = await request('POST', '/api/identity/link', {
    cookie,
    csrfToken,
    body: { minecraftName: 'Steve' },
  });
  assert.equal(res.status, 409);
  assert.ok(res.body.error.includes('already linked'));
});

// --- GET /identity/link/status ---

test('identity/link/status: not linked, no challenge', async () => {
  const { cookie } = await login();
  const res = await request('GET', '/api/identity/link/status', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.linked, false);
  assert.equal(res.body.pending, false);
});

test('identity/link/status: pending challenge', async () => {
  const { cookie, csrfToken } = await login();
  // Create a challenge first
  await request('POST', '/api/identity/link', { cookie, csrfToken, body: { minecraftName: 'Steve' } });
  const res = await request('GET', '/api/identity/link/status', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.linked, false);
  assert.equal(res.body.pending, true);
  assert.ok(res.body.code);
});

test('identity/link/status: already linked', async () => {
  mockPanelLinks.setLink('user@test.com', 'Steve', 'self', true);
  const { cookie } = await login();
  const res = await request('GET', '/api/identity/link/status', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.linked, true);
  assert.equal(res.body.minecraftName, 'Steve');
});

// --- DELETE /identity/link ---

test('identity/link DELETE: removes own link', async () => {
  mockPanelLinks.setLink('user@test.com', 'Steve', 'self', true);
  const { cookie, csrfToken } = await login();
  const res = await request('DELETE', '/api/identity/link', { cookie, csrfToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.existed, true);
  assert.equal(mockPanelLinks.getLink('user@test.com'), null);
});

test('identity/link DELETE: returns existed=false when not linked', async () => {
  const { cookie, csrfToken } = await login();
  const res = await request('DELETE', '/api/identity/link', { cookie, csrfToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.existed, false);
});

// --- Admin endpoints ---

test('panel-links: admin can list all links', async () => {
  mockPanelLinks.setLink('a@test.com', 'Steve', 'self', true);
  mockPanelLinks.setLink('b@test.com', 'Alex', 'self', false);
  const { cookie } = await login('admin', 'admin@test.com');
  const res = await request('GET', '/api/panel-links', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('panel-links: viewer gets 403', async () => {
  const { cookie } = await login('viewer');
  const res = await request('GET', '/api/panel-links', { cookie });
  assert.equal(res.status, 403);
});

test('panel-link POST: admin can create a link', async () => {
  const { cookie, csrfToken } = await login('admin', 'admin@test.com');
  const res = await request('POST', '/api/panel-link', {
    cookie,
    csrfToken,
    body: { email: 'user@test.com', minecraftName: 'Steve' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(mockPanelLinks.getLink('user@test.com'));
});

test('panel-link POST: missing fields returns 400', async () => {
  const { cookie, csrfToken } = await login('admin', 'admin@test.com');
  const res = await request('POST', '/api/panel-link', {
    cookie,
    csrfToken,
    body: { email: 'user@test.com' },
  });
  assert.equal(res.status, 400);
});

test('panel-link POST: invalid MC name returns 400', async () => {
  const { cookie, csrfToken } = await login('admin', 'admin@test.com');
  const res = await request('POST', '/api/panel-link', {
    cookie,
    csrfToken,
    body: { email: 'user@test.com', minecraftName: '../bad' },
  });
  assert.equal(res.status, 400);
});

test('panel-link DELETE: admin can remove a link', async () => {
  mockPanelLinks.setLink('user@test.com', 'Steve', 'self', true);
  const { cookie, csrfToken } = await login('admin', 'admin@test.com');
  const res = await request('DELETE', '/api/panel-link/user@test.com', { cookie, csrfToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.existed, true);
});

test('panel-link DELETE: viewer gets 403', async () => {
  const { cookie, csrfToken } = await login('viewer');
  const res = await request('DELETE', '/api/panel-link/user@test.com', { cookie, csrfToken });
  assert.equal(res.status, 403);
});
