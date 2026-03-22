// Tests for the analytics module (src/analytics.js).
// Covers demo data generation, helper functions, and snapshot/event shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoMetrics, generateDemoEvents, generateDemoSummary } from '../src/analytics.js';

// ---- Demo Data Generation ----

test('generateDemoMetrics: returns array of data points with correct shape', () => {
  const now = Date.now();
  const from = new Date(now - 3600000).toISOString();
  const to = new Date(now).toISOString();
  const points = generateDemoMetrics({ from, to });

  assert.ok(Array.isArray(points));
  assert.ok(points.length > 0, 'Should generate at least one point');

  const first = points[0];
  assert.ok(first.timestamp, 'Each point should have a timestamp');
  assert.ok(['running', 'stopped'].includes(first.status), 'Status should be running or stopped');
  assert.equal(typeof first.onlineCount, 'number');
});

test('generateDemoMetrics: respects time range', () => {
  const from = '2026-03-22T10:00:00.000Z';
  const to = '2026-03-22T10:15:00.000Z';
  const points = generateDemoMetrics({ from, to });

  const firstTs = new Date(points[0].timestamp).getTime();
  const lastTs = new Date(points[points.length - 1].timestamp).getTime();
  assert.ok(firstTs >= new Date(from).getTime(), 'First point should be >= from');
  assert.ok(lastTs <= new Date(to).getTime(), 'Last point should be <= to');
});

test('generateDemoMetrics: simulates a restart (some points are stopped)', () => {
  const now = Date.now();
  const points = generateDemoMetrics({ from: new Date(now - 3600000).toISOString(), to: new Date(now).toISOString() });
  const statuses = new Set(points.map((p) => p.status));
  assert.ok(statuses.has('stopped'), 'Should include stopped points during simulated restart');
  assert.ok(statuses.has('running'), 'Should include running points');
});

test('generateDemoMetrics: running points have non-null TPS and memory', () => {
  const now = Date.now();
  const points = generateDemoMetrics({ from: new Date(now - 3600000).toISOString(), to: new Date(now).toISOString() });
  const running = points.filter((p) => p.status === 'running');
  assert.ok(running.length > 0);
  for (const p of running) {
    assert.ok(p.tps != null, 'Running point should have TPS');
    assert.ok(p.memBytes != null, 'Running point should have memBytes');
    assert.ok(p.cpuPercent != null, 'Running point should have cpuPercent');
  }
});

test('generateDemoMetrics: stopped points have null TPS/CPU/memory', () => {
  const now = Date.now();
  const points = generateDemoMetrics({ from: new Date(now - 3600000).toISOString(), to: new Date(now).toISOString() });
  const stopped = points.filter((p) => p.status === 'stopped');
  assert.ok(stopped.length > 0);
  for (const p of stopped) {
    assert.equal(p.tps, null);
    assert.equal(p.cpuPercent, null);
    assert.equal(p.memBytes, null);
  }
});

test('generateDemoMetrics: longer range produces larger step size', () => {
  const now = Date.now();
  const short = generateDemoMetrics({
    from: new Date(now - 15 * 60000).toISOString(),
    to: new Date(now).toISOString(),
  });
  const long = generateDemoMetrics({
    from: new Date(now - 7 * 86400000).toISOString(),
    to: new Date(now).toISOString(),
  });

  // Long range should have fewer points relative to its duration
  const shortDensity = short.length / (15 * 60);
  const longDensity = long.length / (7 * 86400);
  assert.ok(shortDensity > longDensity, 'Short range should be denser than 7d range');
});

// ---- Demo Events ----

test('generateDemoEvents: returns array with expected event types', () => {
  const now = Date.now();
  const events = generateDemoEvents({ from: new Date(now - 86400000).toISOString(), to: new Date(now).toISOString() });
  assert.ok(Array.isArray(events));
  assert.ok(events.length > 0);

  const types = events.map((e) => e.event_type);
  assert.ok(types.includes('start'));
  assert.ok(types.includes('stop'));
  assert.ok(types.includes('backup'));
});

test('generateDemoEvents: events have timestamps and details', () => {
  const events = generateDemoEvents({});
  for (const e of events) {
    assert.ok(e.timestamp, 'Event should have timestamp');
    assert.ok(e.event_type, 'Event should have event_type');
    assert.ok(e.details != null, 'Event should have details object');
  }
});

// ---- Demo Summary ----

test('generateDemoSummary: returns expected shape', () => {
  const summary = generateDemoSummary();

  assert.equal(typeof summary.avgTps, 'number');
  assert.equal(typeof summary.minTps, 'number');
  assert.equal(typeof summary.maxTps, 'number');
  assert.equal(typeof summary.avgCpu, 'number');
  assert.equal(typeof summary.maxCpu, 'number');
  assert.equal(typeof summary.avgMem, 'number');
  assert.equal(typeof summary.peakMem, 'number');
  assert.equal(typeof summary.peakPlayers, 'number');
  assert.equal(typeof summary.avgPlayers, 'number');
  assert.equal(typeof summary.uptimePercent, 'number');
  assert.equal(typeof summary.lagSamples, 'number');
  assert.equal(typeof summary.sampleCount, 'number');
  assert.equal(typeof summary.totalSamples, 'number');
  assert.ok(summary.eventCounts, 'Should have eventCounts');
});

test('generateDemoSummary: TPS values are in realistic range', () => {
  const summary = generateDemoSummary();
  assert.ok(summary.avgTps >= 0 && summary.avgTps <= 20);
  assert.ok(summary.minTps >= 0 && summary.minTps <= 20);
  assert.ok(summary.maxTps >= 0 && summary.maxTps <= 20);
  assert.ok(summary.minTps <= summary.avgTps);
  assert.ok(summary.avgTps <= summary.maxTps);
});

test('generateDemoSummary: uptimePercent is between 0 and 100', () => {
  const summary = generateDemoSummary();
  assert.ok(summary.uptimePercent >= 0 && summary.uptimePercent <= 100);
});
