// Tests for environment routes in src/routes/environments.js.
// Uses a lightweight Express test server with a mocked ctx.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import http from 'http';
import crypto from 'crypto';
import environmentRoutes from '../src/routes/environments.js';
import { resolveConfig } from '../src/environments.js';

// --- Mock state ---

function makeRawConfig() {
  return {
    environments: {
      production: {
        name: 'Production',
        serverPath: '/home/minecraft/server',
        launch: { executable: 'java', args: ['-Xmx4G', 'nogui'] },
        rconHost: '127.0.0.1',
        rconPort: 25575,
        rconPassword: 'secret',
        minecraftVersion: '1.20.1',
        modsFolder: 'mods',
        disabledModsFolder: 'mods_disabled',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
    activeEnvironment: 'production',
    webPort: 3000,
    demoMode: false,
  };
}

let mockRawConfig;
let mockConfig;
let mockMc;

function buildCtx() {
  mockRawConfig = makeRawConfig();
  mockConfig = resolveConfig(mockRawConfig);
  mockMc = {
    running: false,
    stopping: false,
    start() {
      this.running = true;
    },
    stop() {
      this.running = false;
      this.emit('stopped', 0);
    },
    kill() {
      this.running = false;
    },
    once(event, cb) {
      this._onceCallbacks = this._onceCallbacks || {};
      this._onceCallbacks[event] = cb;
    },
    emit(event, ...args) {
      if (this._onceCallbacks?.[event]) {
        this._onceCallbacks[event](...args);
        delete this._onceCallbacks[event];
      }
    },
  };

  return {
    get config() {
      return mockConfig;
    },
    set config(c) {
      mockConfig = c;
    },
    get rawConfig() {
      return mockRawConfig;
    },
    set rawConfig(rc) {
      mockRawConfig = rc;
    },
    async saveRawConfig() {
      /* mock — no-op */
    },
    mc: mockMc,
    markIntentionalStop() {},
    get rconConnected() {
      return false;
    },
    async rconCmd() {
      return '';
    },
    scheduleRconConnect() {},
    broadcastStatus() {},
    broadcast() {},
    async switchEnvironment(envId) {
      mockRawConfig = { ...mockRawConfig, activeEnvironment: envId };
      mockConfig = resolveConfig(mockRawConfig);
    },
  };
}

// --- Build test app ---

let server;
let baseUrl;
let ctx;

function buildTestApp() {
  ctx = buildCtx();
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

  // Test login endpoint
  app.post('/test/login', (req, res) => {
    req.session.user = {
      email: req.body.email || 'user@test.com',
      name: 'Test',
      provider: 'local',
      role: req.body.role || 'owner',
      adminLevel: 1,
    };
    req.session.csrfToken = crypto.randomBytes(16).toString('hex');
    req.session.save(() => res.json({ ok: true, csrfToken: req.session.csrfToken }));
  });

  app.use('/api', (req, res, next) => {
    // Simple CSRF check for test
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      if (req.headers['x-csrf-token'] && req.session?.csrfToken === req.headers['x-csrf-token']) {
        return next();
      }
      if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
    }
    next();
  });

  app.use('/api', environmentRoutes(ctx));
  return app;
}

async function apiRequest(method, path, body, cookie, csrfToken) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (cookie) options.headers['Cookie'] = cookie;
  if (csrfToken) options.headers['x-csrf-token'] = csrfToken;
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl}${path}`, options);
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

async function login(role = 'owner') {
  const res = await fetch(`${baseUrl}/test/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  const json = await res.json();
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  return { cookie, csrfToken: json.csrfToken };
}

before(async () => {
  const app = buildTestApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  // Reset to clean state
  mockRawConfig = makeRawConfig();
  mockConfig = resolveConfig(mockRawConfig);
  if (ctx) {
    ctx.rawConfig = mockRawConfig;
    ctx.config = mockConfig;
  }
});

// ---- GET /environments --------------------------------------

test('GET /environments returns environment list', async () => {
  const { cookie } = await login();
  const { status, json } = await apiRequest('GET', '/api/environments', null, cookie);
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.environments));
  assert.equal(json.environments.length, 1);
  assert.equal(json.environments[0].id, 'production');
  assert.equal(json.environments[0].isActive, true);
  assert.equal(json.activeEnvironment, 'production');
});

// ---- GET /environments/:id ----------------------------------

test('GET /environments/:id returns environment details', async () => {
  const { cookie } = await login();
  const { status, json } = await apiRequest('GET', '/api/environments/production', null, cookie);
  assert.equal(status, 200);
  assert.equal(json.id, 'production');
  assert.equal(json.name, 'Production');
  assert.equal(json.isActive, true);
  // rconPassword should be redacted
  assert.equal(json.rconPassword, undefined);
});

test('GET /environments/:id returns 404 for unknown env', async () => {
  const { cookie } = await login();
  const { status } = await apiRequest('GET', '/api/environments/nonexistent', null, cookie);
  assert.equal(status, 404);
});

// ---- POST /environments/select ------------------------------

test('POST /environments/select sets session selection', async () => {
  const { cookie, csrfToken } = await login();
  const { status, json } = await apiRequest(
    'POST',
    '/api/environments/select',
    { id: 'production' },
    cookie,
    csrfToken,
  );
  assert.equal(status, 200);
  assert.equal(json.selected, 'production');
});

test('POST /environments/select rejects unknown environment', async () => {
  const { cookie, csrfToken } = await login();
  const { status } = await apiRequest('POST', '/api/environments/select', { id: 'nonexistent' }, cookie, csrfToken);
  assert.equal(status, 404);
});

// ---- POST /environments (create) ----------------------------

test('POST /environments creates a new environment', async () => {
  const { cookie, csrfToken } = await login();
  const { status, json } = await apiRequest(
    'POST',
    '/api/environments',
    {
      id: 'staging',
      name: 'Staging',
      serverPath: '/home/minecraft/staging',
      launch: { executable: 'java', args: ['-Xmx2G'] },
    },
    cookie,
    csrfToken,
  );
  assert.equal(status, 200);
  assert.equal(json.id, 'staging');
  assert.equal(json.environment.name, 'Staging');
  // Verify it's persisted
  assert.ok(ctx.rawConfig.environments.staging);
});

test('POST /environments auto-generates ID from name', async () => {
  const { cookie, csrfToken } = await login();
  const { status, json } = await apiRequest(
    'POST',
    '/api/environments',
    {
      name: 'My Test Server',
      serverPath: '/test',
    },
    cookie,
    csrfToken,
  );
  assert.equal(status, 200);
  assert.equal(json.id, 'my-test-server');
});

test('POST /environments rejects invalid ID', async () => {
  const { cookie, csrfToken } = await login();
  const { status } = await apiRequest(
    'POST',
    '/api/environments',
    {
      id: 'BAD ID!',
      name: 'Bad',
      serverPath: '/bad',
    },
    cookie,
    csrfToken,
  );
  assert.equal(status, 400);
});

test('POST /environments rejects missing name', async () => {
  const { cookie, csrfToken } = await login();
  const { status } = await apiRequest('POST', '/api/environments', { serverPath: '/test' }, cookie, csrfToken);
  assert.equal(status, 400);
});

// ---- PUT /environments/:id ----------------------------------

test('PUT /environments/:id updates environment config', async () => {
  const { cookie, csrfToken } = await login();
  const { status, json } = await apiRequest(
    'PUT',
    '/api/environments/production',
    { name: 'Prod (Updated)', minecraftVersion: '1.21' },
    cookie,
    csrfToken,
  );
  assert.equal(status, 200);
  assert.equal(json.environment.name, 'Prod (Updated)');
  assert.equal(json.environment.minecraftVersion, '1.21');
});

test('PUT /environments/:id returns 400 for unknown env', async () => {
  const { cookie, csrfToken } = await login();
  const { status } = await apiRequest('PUT', '/api/environments/nonexistent', { name: 'X' }, cookie, csrfToken);
  assert.equal(status, 400);
});

// ---- DELETE /environments/:id -------------------------------

test('DELETE /environments/:id removes a non-active environment', async () => {
  const { cookie, csrfToken } = await login();
  // First create one to delete
  await apiRequest('POST', '/api/environments', { id: 'temp', name: 'Temp', serverPath: '/temp' }, cookie, csrfToken);
  assert.ok(ctx.rawConfig.environments.temp);

  const { status, json } = await apiRequest('DELETE', '/api/environments/temp', null, cookie, csrfToken);
  assert.equal(status, 200);
  assert.ok(json.ok);
  assert.equal(ctx.rawConfig.environments.temp, undefined);
});

test('DELETE /environments/:id rejects deleting active environment', async () => {
  const { cookie, csrfToken } = await login();
  const { status, json } = await apiRequest('DELETE', '/api/environments/production', null, cookie, csrfToken);
  assert.equal(status, 400);
  assert.ok(json.error.includes('active'));
});

// ---- POST /environments/:id/deploy --------------------------

test('POST /environments/:id/deploy switches active environment', async () => {
  const { cookie, csrfToken } = await login();
  // Create a staging env to deploy to
  await apiRequest(
    'POST',
    '/api/environments',
    { id: 'staging', name: 'Staging', serverPath: '/staging' },
    cookie,
    csrfToken,
  );

  const { status, json } = await apiRequest(
    'POST',
    '/api/environments/staging/deploy',
    { start: false },
    cookie,
    csrfToken,
  );
  assert.equal(status, 200);
  assert.ok(json.ok);
  assert.equal(json.activeEnvironment, 'staging');
  assert.equal(json.previousEnvironment, 'production');
  assert.equal(ctx.rawConfig.activeEnvironment, 'staging');
});

test('POST /environments/:id/deploy returns 404 for unknown env', async () => {
  const { cookie, csrfToken } = await login();
  const { status } = await apiRequest('POST', '/api/environments/nonexistent/deploy', {}, cookie, csrfToken);
  assert.equal(status, 404);
});

test('POST /environments/:id/deploy to already-active env is a no-op', async () => {
  const { cookie, csrfToken } = await login();
  const { status, json } = await apiRequest('POST', '/api/environments/production/deploy', {}, cookie, csrfToken);
  assert.equal(status, 200);
  assert.ok(json.ok);
  assert.ok(json.message?.includes('Already'));
});

// ---- Permission checks -------------------------------------

test('POST /environments requires environments.manage capability', async () => {
  const { cookie, csrfToken } = await login('viewer');
  const { status } = await apiRequest(
    'POST',
    '/api/environments',
    { name: 'Test', serverPath: '/test' },
    cookie,
    csrfToken,
  );
  assert.equal(status, 403);
});

test('DELETE /environments/:id requires environments.manage capability', async () => {
  const { cookie, csrfToken } = await login('viewer');
  const { status } = await apiRequest('DELETE', '/api/environments/production', null, cookie, csrfToken);
  assert.equal(status, 403);
});

test('POST /environments/:id/deploy requires environments.manage capability', async () => {
  const { cookie, csrfToken } = await login('viewer');
  const { status } = await apiRequest('POST', '/api/environments/production/deploy', {}, cookie, csrfToken);
  assert.equal(status, 403);
});
