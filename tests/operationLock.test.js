// Tests for the scope-based operation lock (src/operationLock.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireOp, releaseOp, getActiveOps } from '../src/operationLock.js';

test('acquireOp: returns a numeric id', () => {
  const id = acquireOp('test-op', ['test-scope-a']);
  assert.equal(typeof id, 'number');
  releaseOp(id);
});

test('releaseOp: removes the operation', () => {
  const id = acquireOp('test-release', ['test-scope-b']);
  assert.ok(getActiveOps().some((op) => op.name === 'test-release'));
  releaseOp(id);
  assert.ok(!getActiveOps().some((op) => op.name === 'test-release'));
});

test('acquireOp: allows non-conflicting scopes', () => {
  const id1 = acquireOp('op-files', ['files-test']);
  const id2 = acquireOp('op-lifecycle', ['lifecycle-test']);
  assert.equal(getActiveOps().length >= 2, true);
  releaseOp(id1);
  releaseOp(id2);
});

test('acquireOp: rejects conflicting scopes', () => {
  const id = acquireOp('backup-test', ['files-conflict']);
  assert.throws(() => acquireOp('import-test', ['files-conflict']), { message: /already in progress/ });
  releaseOp(id);
});

test('acquireOp: restore blocks start (lifecycle scope)', () => {
  const id = acquireOp('restore-test', ['files-lc', 'lifecycle-lc']);
  assert.throws(() => acquireOp('start-test', ['lifecycle-lc']), { message: /restore-test is already in progress/ });
  releaseOp(id);
});

test('acquireOp: backup blocks modpack import (files scope)', () => {
  const id = acquireOp('backup-fi', ['files-fi']);
  assert.throws(() => acquireOp('modpack-import-fi', ['files-fi']), { message: /backup-fi is already in progress/ });
  releaseOp(id);
});

test('acquireOp: backup does not block server start (different scopes)', () => {
  const id1 = acquireOp('backup-noblock', ['files-nb']);
  const id2 = acquireOp('start-noblock', ['lifecycle-nb']);
  // Both should be active
  assert.equal(getActiveOps().filter((op) => op.name.includes('-noblock')).length, 2);
  releaseOp(id1);
  releaseOp(id2);
});

test('getActiveOps: returns operation details', () => {
  const before = getActiveOps().length;
  const id = acquireOp('detail-test', ['detail-scope']);
  const ops = getActiveOps();
  const op = ops.find((o) => o.name === 'detail-test');
  assert.ok(op);
  assert.deepEqual(op.scopes, ['detail-scope']);
  assert.equal(typeof op.startedAt, 'number');
  releaseOp(id);
  assert.equal(getActiveOps().length, before);
});

test('releaseOp: no-op for unknown id', () => {
  // Should not throw
  releaseOp(999999);
});
