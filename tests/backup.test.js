// Tests for backup module functions that don't require a database or tar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { listBackups, deleteBackup } from '../src/backup.js';

// --- Helpers ---

async function makeTempBackupDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mc-backup-test-'));
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeFile(filePath, content = '') {
  await fs.writeFile(filePath, content);
}

// ===================== listBackups =====================

test('listBackups: returns empty array when dir does not exist', async () => {
  const config = { backupPath: path.join(os.tmpdir(), 'nonexistent-' + Date.now()) };
  const result = await listBackups(config);
  assert.deepEqual(result, []);
});

test('listBackups: returns empty array when dir has no tar.gz files', async () => {
  const dir = await makeTempBackupDir();
  try {
    await writeFile(path.join(dir, 'readme.txt'), 'not a backup');
    const result = await listBackups({ backupPath: dir });
    assert.deepEqual(result, []);
  } finally {
    await cleanup(dir);
  }
});

test('listBackups: lists tar.gz files with metadata', async () => {
  const dir = await makeTempBackupDir();
  try {
    // Create fake backup archive
    await writeFile(path.join(dir, 'mc-backup_2024-01-15.tar.gz'), 'fake-archive');

    // Create manifest
    const manifest = {
      createdAt: '2024-01-15T03:00:00.000Z',
      type: 'scheduled',
      serverPath: '/home/mc/server',
      minecraftVersion: '1.20.1',
      includesDatabase: true,
      note: 'test backup',
    };
    await writeFile(path.join(dir, 'mc-backup_2024-01-15.json'), JSON.stringify(manifest));

    const result = await listBackups({ backupPath: dir });
    assert.equal(result.length, 1);
    assert.equal(result[0].filename, 'mc-backup_2024-01-15.tar.gz');
    assert.equal(result[0].type, 'scheduled');
    assert.equal(result[0].minecraftVersion, '1.20.1');
    assert.equal(result[0].includesDatabase, true);
    assert.equal(result[0].note, 'test backup');
  } finally {
    await cleanup(dir);
  }
});

test('listBackups: sorts by createdAt descending (newest first)', async () => {
  const dir = await makeTempBackupDir();
  try {
    await writeFile(path.join(dir, 'backup-old.tar.gz'), 'old');
    await writeFile(path.join(dir, 'backup-old.json'), JSON.stringify({ createdAt: '2024-01-01T00:00:00Z', type: 'manual' }));

    await writeFile(path.join(dir, 'backup-new.tar.gz'), 'new');
    await writeFile(path.join(dir, 'backup-new.json'), JSON.stringify({ createdAt: '2024-06-01T00:00:00Z', type: 'manual' }));

    const result = await listBackups({ backupPath: dir });
    assert.equal(result.length, 2);
    assert.equal(result[0].filename, 'backup-new.tar.gz');
    assert.equal(result[1].filename, 'backup-old.tar.gz');
  } finally {
    await cleanup(dir);
  }
});

test('listBackups: handles missing manifest gracefully', async () => {
  const dir = await makeTempBackupDir();
  try {
    await writeFile(path.join(dir, 'no-manifest.tar.gz'), 'archive');
    const result = await listBackups({ backupPath: dir });
    assert.equal(result.length, 1);
    assert.equal(result[0].filename, 'no-manifest.tar.gz');
    assert.equal(result[0].type, 'manual'); // default
    assert.equal(result[0].note, '');        // default
  } finally {
    await cleanup(dir);
  }
});

// ===================== deleteBackup =====================

test('deleteBackup: removes archive and manifest', async () => {
  const dir = await makeTempBackupDir();
  try {
    await writeFile(path.join(dir, 'test.tar.gz'), 'archive');
    await writeFile(path.join(dir, 'test.json'), '{}');

    await deleteBackup({ backupPath: dir }, 'test.tar.gz');
    assert.equal(existsSync(path.join(dir, 'test.tar.gz')), false);
    assert.equal(existsSync(path.join(dir, 'test.json')), false);
  } finally {
    await cleanup(dir);
  }
});

test('deleteBackup: succeeds when manifest is missing', async () => {
  const dir = await makeTempBackupDir();
  try {
    await writeFile(path.join(dir, 'orphan.tar.gz'), 'archive');
    await deleteBackup({ backupPath: dir }, 'orphan.tar.gz');
    assert.equal(existsSync(path.join(dir, 'orphan.tar.gz')), false);
  } finally {
    await cleanup(dir);
  }
});

test('deleteBackup: throws for non-tar.gz filename', async () => {
  const dir = await makeTempBackupDir();
  try {
    await assert.rejects(
      () => deleteBackup({ backupPath: dir }, 'malicious.exe'),
      { message: /invalid/i },
    );
  } finally {
    await cleanup(dir);
  }
});

test('deleteBackup: throws for path traversal attempt', async () => {
  const dir = await makeTempBackupDir();
  try {
    await assert.rejects(
      () => deleteBackup({ backupPath: dir }, '../../../etc/passwd.tar.gz'),
      { message: /invalid/i },
    );
  } finally {
    await cleanup(dir);
  }
});

test('deleteBackup: throws when archive does not exist', async () => {
  const dir = await makeTempBackupDir();
  try {
    await assert.rejects(
      () => deleteBackup({ backupPath: dir }, 'nonexistent.tar.gz'),
      { message: /not found/i },
    );
  } finally {
    await cleanup(dir);
  }
});
