// Tests for src/metrics.js — TPS parsing, lag detection, demo metrics
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTps, isLagSpike, collectDemoMetrics } from '../src/metrics.js';

// --- parseTps ---

test('parseTps: parses Paper/Spigot format', () => {
  const raw = 'TPS from last 1m, 5m, 15m: 20.0, 19.8, 19.6';
  assert.equal(parseTps(raw), 20.0);
});

test('parseTps: parses Paper format with colour codes', () => {
  const raw = '§6TPS from last 1m, 5m, 15m: §a20.0§6, §a19.5§6, §a19.2';
  assert.equal(parseTps(raw), 20.0);
});

test('parseTps: parses Forge format', () => {
  const raw = 'Overall : Mean tick time: 12.34 ms. Mean TPS: 19.5';
  assert.equal(parseTps(raw), 19.5);
});

test('parseTps: returns null for vanilla (no TPS output)', () => {
  assert.equal(parseTps('Unknown command'), null);
  assert.equal(parseTps(''), null);
  assert.equal(parseTps(null), null);
});

test('parseTps: handles low TPS values', () => {
  const raw = 'TPS from last 1m, 5m, 15m: 8.3, 12.0, 15.0';
  assert.equal(parseTps(raw), 8.3);
});

// --- isLagSpike ---

test('isLagSpike: returns true when TPS below threshold', () => {
  assert.equal(isLagSpike(15.0, 18), true);
  assert.equal(isLagSpike(17.9, 18), true);
});

test('isLagSpike: returns false when TPS at or above threshold', () => {
  assert.equal(isLagSpike(18.0, 18), false);
  assert.equal(isLagSpike(20.0, 18), false);
});

test('isLagSpike: returns false when TPS is null', () => {
  assert.equal(isLagSpike(null, 18), false);
  assert.equal(isLagSpike(undefined, 18), false);
});

// --- collectDemoMetrics ---

test('collectDemoMetrics: returns all expected fields', () => {
  const m = collectDemoMetrics();
  assert.equal(typeof m.tps, 'number');
  assert.ok(m.tps >= 19 && m.tps <= 21);
  assert.equal(typeof m.cpuPercent, 'number');
  assert.equal(typeof m.memBytes, 'number');
  assert.equal(typeof m.diskBytes, 'number');
  assert.equal(typeof m.modCount, 'number');
  assert.equal(m.onlineCount, 3);
  assert.ok(Array.isArray(m.players));
  assert.equal(m.players.length, 3);
  assert.equal(typeof m.lagSpike, 'boolean');
  assert.equal(m.tpsThreshold, 18);
});
