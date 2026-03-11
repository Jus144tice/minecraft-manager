// Integration tests for API routes with real Express middleware chain.
// Spins up a lightweight Express app with session + CSRF + same-origin,
// makes real HTTP requests, and verifies responses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import http from 'http';
import { buildCsrfCheck, buildSameOriginCheck } from '../src/middleware.js';
import { requireSession } from '../src/auth.js';

// --- Build a test app that mirrors the real middleware chain ---

let server;
let baseUrl;

function buildTestApp() {
  const app = express();

  app.use(session({
    secret: 'test-secret-for-testing-only',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: false, sameSite: 'lax' },
  }));

  app.use(express.json());

  // --- Test-only route: force a session login for testing ---
  app.post('/test/login', (req, res) => {
    req.session.user = { email: 'test@local', name: 'Test', provider: 'local', adminLevel: 1 };
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.save(() => {
      res.json({ ok: true, csrfToken: req.session.csrfToken });
    });
  });

  // --- Public route (no auth) ---
  app.get('/api/public', (req, res) => res.json({ hello: 'world' }));

  // --- Protected routes ---
  app.use('/api/protected', requireSession);

  // CSRF token endpoint
  app.get('/api/protected/csrf-token', (req, res) => {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session.save(() => {});
    }
    res.json({ token: req.session.csrfToken });
  });

  // CSRF check for mutating requests
  app.use('/api/protected', buildCsrfCheck());

  // Same-origin check
  app.use('/api/protected', buildSameOriginCheck(null));

  // Test endpoints
  app.get('/api/protected/data', (req, res) => res.json({ data: 'secret' }));
  app.post('/api/protected/action', (req, res) => res.json({ ok: true, received: req.body }));
  app.delete('/api/protected/item/:id', (req, res) => res.json({ ok: true, deleted: req.params.id }));
  app.post('/api/protected/echo', (req, res) => res.json({ echo: req.body }));

  return app;
}

// --- HTTP helpers ---

function request(method, path, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { ...headers },
    };

    if (cookie) opts.headers['Cookie'] = cookie;
    if (body !== undefined) {
      const payload = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null,
            cookie: res.headers['set-cookie']?.[0]?.split(';')[0] || null,
          });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data, cookie: null });
        }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Login and return { cookie, csrfToken } */
async function loginSession() {
  const res = await request('POST', '/test/login', { body: {} });
  return { cookie: res.cookie, csrfToken: res.body.csrfToken };
}

// --- Setup / teardown ---

before(async () => {
  const app = buildTestApp();
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

// ===================== Authentication =====================

test('Route: public endpoint accessible without auth', async () => {
  const res = await request('GET', '/api/public');
  assert.equal(res.status, 200);
  assert.equal(res.body.hello, 'world');
});

test('Route: protected GET returns 401 without session', async () => {
  const res = await request('GET', '/api/protected/data');
  assert.equal(res.status, 401);
  assert.ok(res.body.error);
});

test('Route: protected GET succeeds with valid session', async () => {
  const { cookie } = await loginSession();
  const res = await request('GET', '/api/protected/data', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.data, 'secret');
});

// ===================== CSRF Protection =====================

test('Route: POST without CSRF token returns 403', async () => {
  const { cookie } = await loginSession();
  const res = await request('POST', '/api/protected/action', {
    cookie,
    body: { test: true },
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /CSRF/i);
});

test('Route: POST with wrong CSRF token returns 403', async () => {
  const { cookie } = await loginSession();
  const res = await request('POST', '/api/protected/action', {
    cookie,
    body: { test: true },
    headers: { 'X-CSRF-Token': 'wrong-token' },
  });
  assert.equal(res.status, 403);
});

test('Route: POST with valid CSRF token succeeds', async () => {
  const { cookie, csrfToken } = await loginSession();
  const res = await request('POST', '/api/protected/action', {
    cookie,
    body: { key: 'value' },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.received.key, 'value');
});

test('Route: DELETE with valid CSRF token succeeds', async () => {
  const { cookie, csrfToken } = await loginSession();
  const res = await request('DELETE', '/api/protected/item/42', {
    cookie,
    body: {},
    headers: { 'X-CSRF-Token': csrfToken },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, '42');
});

test('Route: GET /csrf-token returns a token', async () => {
  const { cookie } = await loginSession();
  const res = await request('GET', '/api/protected/csrf-token', { cookie });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(typeof res.body.token, 'string');
  assert.ok(res.body.token.length >= 32);
});

// ===================== Same-Origin Protection =====================

test('Route: POST with cross-origin Origin header returns 403', async () => {
  const { cookie, csrfToken } = await loginSession();
  const res = await request('POST', '/api/protected/action', {
    cookie,
    body: { test: true },
    headers: {
      'X-CSRF-Token': csrfToken,
      'Origin': 'http://evil.com',
    },
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /cross-origin/i);
});

test('Route: POST with same-origin Origin header succeeds', async () => {
  const { cookie, csrfToken } = await loginSession();
  const res = await request('POST', '/api/protected/action', {
    cookie,
    body: { data: 123 },
    headers: {
      'X-CSRF-Token': csrfToken,
      'Origin': baseUrl,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('Route: POST without Origin header succeeds (same-origin SPA)', async () => {
  const { cookie, csrfToken } = await loginSession();
  const res = await request('POST', '/api/protected/echo', {
    cookie,
    body: { msg: 'hello' },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.echo, { msg: 'hello' });
});

// ===================== Session isolation =====================

test('Route: different sessions have different CSRF tokens', async () => {
  const s1 = await loginSession();
  const s2 = await loginSession();
  assert.notEqual(s1.csrfToken, s2.csrfToken);
});

test('Route: CSRF token from session A rejected on session B', async () => {
  const s1 = await loginSession();
  const s2 = await loginSession();
  // Use session B's cookie but session A's CSRF token
  const res = await request('POST', '/api/protected/action', {
    cookie: s2.cookie,
    body: {},
    headers: { 'X-CSRF-Token': s1.csrfToken },
  });
  assert.equal(res.status, 403);
});

// ===================== JSON body parsing =====================

test('Route: JSON body is correctly parsed', async () => {
  const { cookie, csrfToken } = await loginSession();
  const payload = { name: 'JEI', version: '1.2.3', nested: { a: 1 } };
  const res = await request('POST', '/api/protected/echo', {
    cookie,
    body: payload,
    headers: { 'X-CSRF-Token': csrfToken },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.echo, payload);
});
