// Tests for ops-friendly health/readiness/metrics endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// We test the route handler logic directly with lightweight mock req/res objects,
// matching the pattern used in settings.test.js.

// ---- Mock helpers ----

function mockCtx(overrides = {}) {
  return {
    config: { demoMode: false, tpsAlertThreshold: 18, serverPath: '/srv/mc', ...overrides.config },
    mc: { running: false, getUptime: () => null, proc: null, ...overrides.mc },
    rconConnected: overrides.rconConnected ?? false,
    rconCmd: overrides.rconCmd ?? (() => Promise.resolve('')),
    demoState: { running: true },
    getDemoUptime: () => 3847,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(obj) {
      res.body = obj;
      return res;
    },
    set(key, value) {
      res.headers[key] = value;
      return res;
    },
    send(data) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// ---- Import and build router ----

// We import the route builder and extract handlers from the Express router.
import healthRoutes from '../src/routes/health.js';

function getHandler(ctx, opts, method, path) {
  const router = healthRoutes(ctx, opts);
  // Express router stores routes in router.stack
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`No ${method.toUpperCase()} handler for ${path}`);
}

// ---- /healthz tests ----

test('GET /healthz returns 200 with status ok', () => {
  const ctx = mockCtx();
  const handler = getHandler(ctx, { dbReady: true, startTime: Date.now() }, 'get', '/healthz');
  const res = mockRes();
  handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(typeof res.body.uptime, 'number');
});

// ---- /readyz tests ----

test('GET /readyz returns 200 when DB is ready', () => {
  const ctx = mockCtx();
  const handler = getHandler(ctx, { dbReady: true, startTime: Date.now() }, 'get', '/readyz');
  const res = mockRes();
  handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ready');
  assert.equal(res.body.checks.database, true);
  assert.equal(res.body.checks.config, true);
});

test('GET /readyz returns 503 when DB is not ready', () => {
  const ctx = mockCtx();
  const handler = getHandler(ctx, { dbReady: false, startTime: Date.now() }, 'get', '/readyz');
  const res = mockRes();
  handler({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'not_ready');
  assert.equal(res.body.checks.database, false);
});

test('GET /readyz includes server/rcon checks in non-demo mode', () => {
  const ctx = mockCtx({ mc: { running: true, getUptime: () => 100, proc: null }, rconConnected: true });
  const handler = getHandler(ctx, { dbReady: true, startTime: Date.now() }, 'get', '/readyz');
  const res = mockRes();
  handler({}, res);
  assert.equal(res.body.checks.serverRunning, true);
  assert.equal(res.body.checks.rconConnected, true);
});

test('GET /readyz omits server/rcon checks in demo mode', () => {
  const ctx = mockCtx({ config: { demoMode: true } });
  const handler = getHandler(ctx, { dbReady: true, startTime: Date.now() }, 'get', '/readyz');
  const res = mockRes();
  handler({}, res);
  assert.equal(res.body.checks.serverRunning, undefined);
  assert.equal(res.body.checks.rconConnected, undefined);
});

// ---- /metrics tests ----

test('GET /metrics returns Prometheus text format', async () => {
  const ctx = mockCtx();
  const handler = getHandler(ctx, { dbReady: true, startTime: Date.now() - 60000 }, 'get', '/metrics');
  const res = mockRes();
  await handler({}, res);
  assert.equal(res.headers['Content-Type'], 'text/plain; version=0.0.4; charset=utf-8');
  assert.equal(typeof res.body, 'string');
  assert.ok(res.body.includes('mcmanager_process_uptime_seconds'));
  assert.ok(res.body.includes('mcmanager_database_up'));
  assert.ok(res.body.includes('minecraft_server_running'));
  assert.ok(res.body.includes('minecraft_players_online'));
  assert.ok(res.body.includes('# HELP'));
  assert.ok(res.body.includes('# TYPE'));
});

test('GET /metrics includes demo metrics in demo mode', async () => {
  const ctx = mockCtx({ config: { demoMode: true, tpsAlertThreshold: 18, serverPath: '/srv/mc' } });
  const handler = getHandler(ctx, { dbReady: true, startTime: Date.now() }, 'get', '/metrics');
  const res = mockRes();
  await handler({}, res);
  assert.ok(res.body.includes('mcmanager_demo_mode'));
  assert.ok(res.body.includes('minecraft_tps'));
});

test('GET /metrics reports database_up as 0 when DB is down', async () => {
  const ctx = mockCtx();
  const handler = getHandler(ctx, { dbReady: false, startTime: Date.now() }, 'get', '/metrics');
  const res = mockRes();
  await handler({}, res);
  assert.ok(res.body.includes('mcmanager_database_up 0'));
});
