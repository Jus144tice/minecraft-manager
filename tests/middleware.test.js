// Tests for security middleware in src/middleware.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsrfCheck, buildSameOriginCheck, requireAdmin, checkWsOrigin } from '../src/middleware.js';

// --- Mock helpers ---

function mockReq({ method = 'GET', headers = {}, session = {} } = {}) {
  return { method, headers, session };
}

function mockRes() {
  const res = { statusCode: undefined, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function trackNext() {
  let called = false;
  const fn = () => {
    called = true;
  };
  fn.wasCalled = () => called;
  return fn;
}

// ===================== buildCsrfCheck =====================

const csrfCheck = buildCsrfCheck();

test('CSRF: skips GET requests', () => {
  const next = trackNext();
  csrfCheck(mockReq({ method: 'GET' }), mockRes(), next);
  assert.ok(next.wasCalled());
});

test('CSRF: skips HEAD requests', () => {
  const next = trackNext();
  csrfCheck(mockReq({ method: 'HEAD' }), mockRes(), next);
  assert.ok(next.wasCalled());
});

test('CSRF: skips OPTIONS requests', () => {
  const next = trackNext();
  csrfCheck(mockReq({ method: 'OPTIONS' }), mockRes(), next);
  assert.ok(next.wasCalled());
});

test('CSRF: rejects POST without token header', () => {
  const res = mockRes();
  const next = trackNext();
  csrfCheck(mockReq({ method: 'POST', session: { csrfToken: 'abc' } }), res, next);
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /CSRF/i);
});

test('CSRF: rejects POST with wrong token', () => {
  const res = mockRes();
  const next = trackNext();
  csrfCheck(
    mockReq({
      method: 'POST',
      headers: { 'x-csrf-token': 'wrong' },
      session: { csrfToken: 'correct' },
    }),
    res,
    next,
  );
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
});

test('CSRF: rejects POST when session has no csrfToken', () => {
  const res = mockRes();
  const next = trackNext();
  csrfCheck(
    mockReq({
      method: 'POST',
      headers: { 'x-csrf-token': 'something' },
      session: {},
    }),
    res,
    next,
  );
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
});

test('CSRF: rejects POST when session is undefined', () => {
  const res = mockRes();
  const next = trackNext();
  const req = { method: 'POST', headers: { 'x-csrf-token': 'tok' }, session: undefined };
  csrfCheck(req, res, next);
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
});

test('CSRF: allows POST with matching token', () => {
  const next = trackNext();
  csrfCheck(
    mockReq({
      method: 'POST',
      headers: { 'x-csrf-token': 'mytoken123' },
      session: { csrfToken: 'mytoken123' },
    }),
    mockRes(),
    next,
  );
  assert.ok(next.wasCalled());
});

test('CSRF: allows PUT with matching token', () => {
  const next = trackNext();
  csrfCheck(
    mockReq({
      method: 'PUT',
      headers: { 'x-csrf-token': 'tok' },
      session: { csrfToken: 'tok' },
    }),
    mockRes(),
    next,
  );
  assert.ok(next.wasCalled());
});

test('CSRF: allows DELETE with matching token', () => {
  const next = trackNext();
  csrfCheck(
    mockReq({
      method: 'DELETE',
      headers: { 'x-csrf-token': 'tok' },
      session: { csrfToken: 'tok' },
    }),
    mockRes(),
    next,
  );
  assert.ok(next.wasCalled());
});

// ===================== buildSameOriginCheck =====================

test('SameOrigin: skips GET requests', () => {
  const check = buildSameOriginCheck('http://localhost:3000');
  const next = trackNext();
  check(mockReq({ method: 'GET', headers: { origin: 'http://evil.com' } }), mockRes(), next);
  assert.ok(next.wasCalled());
});

test('SameOrigin: allows POST without Origin header (same-origin SPA)', () => {
  const check = buildSameOriginCheck('http://localhost:3000');
  const next = trackNext();
  check(mockReq({ method: 'POST' }), mockRes(), next);
  assert.ok(next.wasCalled());
});

test('SameOrigin: allows POST with matching origin', () => {
  const check = buildSameOriginCheck('http://localhost:3000');
  const next = trackNext();
  check(
    mockReq({
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    }),
    mockRes(),
    next,
  );
  assert.ok(next.wasCalled());
});

test('SameOrigin: rejects POST with different origin', () => {
  const check = buildSameOriginCheck('http://localhost:3000');
  const res = mockRes();
  const next = trackNext();
  check(
    mockReq({
      method: 'POST',
      headers: { origin: 'http://evil.com' },
    }),
    res,
    next,
  );
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /cross-origin/i);
});

test('SameOrigin: rejects DELETE with different origin', () => {
  const check = buildSameOriginCheck('http://localhost:3000');
  const res = mockRes();
  const next = trackNext();
  check(
    mockReq({
      method: 'DELETE',
      headers: { origin: 'http://attacker.example.com' },
    }),
    res,
    next,
  );
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
});

test('SameOrigin: rejects invalid origin header', () => {
  const check = buildSameOriginCheck('http://localhost:3000');
  const res = mockRes();
  const next = trackNext();
  check(
    mockReq({
      method: 'POST',
      headers: { origin: 'not-a-url' },
    }),
    res,
    next,
  );
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /invalid origin/i);
});

test('SameOrigin: falls back to req.headers.host when appUrl is null', () => {
  const check = buildSameOriginCheck(null);
  const next = trackNext();
  check(
    mockReq({
      method: 'POST',
      headers: { origin: 'http://myserver:3000', host: 'myserver:3000' },
    }),
    mockRes(),
    next,
  );
  assert.ok(next.wasCalled());
});

test('SameOrigin: rejects when host fallback does not match origin', () => {
  const check = buildSameOriginCheck(null);
  const res = mockRes();
  const next = trackNext();
  check(
    mockReq({
      method: 'POST',
      headers: { origin: 'http://evil.com', host: 'myserver:3000' },
    }),
    res,
    next,
  );
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
});

test('SameOrigin: matches origin with different protocol but same host', () => {
  const check = buildSameOriginCheck('https://myserver:3000');
  const next = trackNext();
  check(
    mockReq({
      method: 'POST',
      headers: { origin: 'http://myserver:3000' },
    }),
    mockRes(),
    next,
  );
  assert.ok(next.wasCalled());
});

test('SameOrigin: rejects origin with same host but different port', () => {
  const check = buildSameOriginCheck('http://localhost:3000');
  const res = mockRes();
  const next = trackNext();
  check(
    mockReq({
      method: 'POST',
      headers: { origin: 'http://localhost:4000' },
    }),
    res,
    next,
  );
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
});

// ===================== requireAdmin =====================

test('requireAdmin: allows user with admin role', () => {
  const next = trackNext();
  requireAdmin(mockReq({ session: { user: { email: 'a@b.com', role: 'admin' } } }), mockRes(), next);
  assert.ok(next.wasCalled());
});

test('requireAdmin: allows owner role', () => {
  const next = trackNext();
  requireAdmin(mockReq({ session: { user: { email: 'a@b.com', role: 'owner' } } }), mockRes(), next);
  assert.ok(next.wasCalled());
});

test('requireAdmin: rejects viewer role', () => {
  const res = mockRes();
  const next = trackNext();
  requireAdmin(mockReq({ session: { user: { email: 'a@b.com', role: 'viewer' } } }), res, next);
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /admin/i);
});

test('requireAdmin: rejects when adminLevel is missing', () => {
  const res = mockRes();
  const next = trackNext();
  requireAdmin(mockReq({ session: { user: { email: 'a@b.com' } } }), res, next);
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 403);
});

test('requireAdmin: rejects with 401 when user is missing', () => {
  const res = mockRes();
  const next = trackNext();
  requireAdmin(mockReq({ session: {} }), res, next);
  assert.equal(next.wasCalled(), false);
  assert.equal(res.statusCode, 401);
});

// ===================== checkWsOrigin =====================

test('WsOrigin: allows when no Origin header (same-origin or non-browser)', () => {
  assert.equal(checkWsOrigin(undefined, 'localhost:3000', null), null);
  assert.equal(checkWsOrigin(null, 'localhost:3000', 'http://mc.example.com'), null);
});

test('WsOrigin: allows matching origin with APP_URL', () => {
  assert.equal(checkWsOrigin('https://mc.example.com', 'localhost:3000', 'https://mc.example.com'), null);
});

test('WsOrigin: rejects non-matching origin with APP_URL', () => {
  const result = checkWsOrigin('https://evil.com', 'localhost:3000', 'https://mc.example.com');
  assert.ok(result);
  assert.match(result, /does not match APP_URL/);
});

test('WsOrigin: allows matching origin via Host fallback (no APP_URL)', () => {
  assert.equal(checkWsOrigin('http://192.168.1.50:3000', '192.168.1.50:3000', null), null);
});

test('WsOrigin: rejects non-matching origin via Host fallback', () => {
  const result = checkWsOrigin('http://evil.com', 'localhost:3000', null);
  assert.ok(result);
  assert.match(result, /does not match Host/);
});

test('WsOrigin: rejects invalid Origin header', () => {
  const result = checkWsOrigin('not-a-url', 'localhost:3000', null);
  assert.ok(result);
  assert.match(result, /Invalid Origin/);
});

test('WsOrigin: matches host regardless of protocol', () => {
  assert.equal(checkWsOrigin('http://mc.example.com', 'mc.example.com', 'https://mc.example.com'), null);
});
