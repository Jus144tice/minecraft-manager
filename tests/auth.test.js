// Tests for auth guards in src/auth.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireSession } from '../src/auth.js';

// Minimal mock helpers
function mockReq(sessionUser = null) {
  return { session: sessionUser ? { user: sessionUser } : {} };
}

function mockRes() {
  const res = { statusCode: undefined, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// --- requireSession ---

test('requireSession: calls next() when session has a user', () => {
  const req = mockReq({ email: 'jenny@example.com', provider: 'google' });
  const res = mockRes();
  let nextCalled = false;
  requireSession(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, 'next() should be called for authenticated sessions');
  assert.equal(res.statusCode, undefined, 'no error status should be set');
});

test('requireSession: returns 401 when session has no user', () => {
  const req = mockReq(null); // session exists but no user property
  const res = mockRes();
  let nextCalled = false;
  requireSession(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'next() must not be called for unauthenticated requests');
  assert.equal(res.statusCode, 401);
  assert.ok(res.body?.error, 'response should include an error message');
});

test('requireSession: returns 401 when session is missing entirely', () => {
  const req = { session: undefined };
  const res = mockRes();
  let nextCalled = false;
  requireSession(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireSession: returns 401 for empty session object', () => {
  const req = { session: {} };
  const res = mockRes();
  let nextCalled = false;
  requireSession(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireSession: accepts any truthy user object (provider-agnostic)', () => {
  const providers = [
    { email: 'alice@gmail.com', provider: 'google' },
    { email: 'bob@outlook.com', provider: 'microsoft' },
    { email: 'admin@local', provider: 'local' },
    { email: 'demo@local', provider: 'local' },
  ];
  for (const user of providers) {
    const req = mockReq(user);
    const res = mockRes();
    let nextCalled = false;
    requireSession(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled, `next() should be called for provider: ${user.provider}`);
  }
});
