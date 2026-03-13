// Tests for backup module functions that don't require a database or tar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { listBackups, deleteBackup, getBackupLock, createBackup, validateBackup } from '../src/backup.js';

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

    // Create manifest with new fields
    const manifest = {
      createdAt: '2024-01-15T03:00:00.000Z',
      type: 'scheduled',
      serverPath: '/home/mc/server',
      minecraftVersion: '1.20.1',
      includesDatabase: true,
      note: 'test backup',
      appVersion: '1.0.0',
      modCount: 42,
      quiesced: true,
    };
    await writeFile(path.join(dir, 'mc-backup_2024-01-15.json'), JSON.stringify(manifest));

    const result = await listBackups({ backupPath: dir });
    assert.equal(result.length, 1);
    assert.equal(result[0].filename, 'mc-backup_2024-01-15.tar.gz');
    assert.equal(result[0].type, 'scheduled');
    assert.equal(result[0].minecraftVersion, '1.20.1');
    assert.equal(result[0].includesDatabase, true);
    assert.equal(result[0].note, 'test backup');
    assert.equal(result[0].appVersion, '1.0.0');
    assert.equal(result[0].modCount, 42);
    assert.equal(result[0].quiesced, true);
    assert.equal(result[0].hasManifest, true);
  } finally {
    await cleanup(dir);
  }
});

test('listBackups: sorts by createdAt descending (newest first)', async () => {
  const dir = await makeTempBackupDir();
  try {
    await writeFile(path.join(dir, 'backup-old.tar.gz'), 'old');
    await writeFile(
      path.join(dir, 'backup-old.json'),
      JSON.stringify({ createdAt: '2024-01-01T00:00:00Z', type: 'manual' }),
    );

    await writeFile(path.join(dir, 'backup-new.tar.gz'), 'new');
    await writeFile(
      path.join(dir, 'backup-new.json'),
      JSON.stringify({ createdAt: '2024-06-01T00:00:00Z', type: 'manual' }),
    );

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
    assert.equal(result[0].note, ''); // default
    assert.equal(result[0].hasManifest, false);
    assert.equal(result[0].appVersion, null);
    assert.equal(result[0].modCount, null);
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
    await assert.rejects(() => deleteBackup({ backupPath: dir }, 'malicious.exe'), { message: /invalid/i });
  } finally {
    await cleanup(dir);
  }
});

test('deleteBackup: throws for path traversal attempt', async () => {
  const dir = await makeTempBackupDir();
  try {
    await assert.rejects(() => deleteBackup({ backupPath: dir }, '../../../etc/passwd.tar.gz'), {
      message: /invalid/i,
    });
  } finally {
    await cleanup(dir);
  }
});

test('deleteBackup: throws when archive does not exist', async () => {
  const dir = await makeTempBackupDir();
  try {
    await assert.rejects(() => deleteBackup({ backupPath: dir }, 'nonexistent.tar.gz'), { message: /not found/i });
  } finally {
    await cleanup(dir);
  }
});

// ===================== Backup-state lock =====================

test('getBackupLock: returns null when no operation in progress', () => {
  assert.equal(getBackupLock(), null);
});

test('createBackup: acquires and releases lock', async () => {
  const dir = await makeTempBackupDir();
  const serverDir = path.join(dir, 'server');
  await fs.mkdir(serverDir, { recursive: true });
  await writeFile(path.join(serverDir, 'server.jar'), 'fake');

  try {
    // createBackup will fail at tar but should still release the lock
    try {
      await createBackup({ backupPath: dir, serverPath: serverDir, minecraftVersion: '1.20.1' }, { type: 'manual' });
    } catch {
      // tar may fail in test env — that's fine
    }
    // Lock must be released regardless
    assert.equal(getBackupLock(), null);
  } finally {
    await cleanup(dir);
  }
});

test('createBackup: rejects concurrent operations', async () => {
  const dir = await makeTempBackupDir();
  const serverDir = path.join(dir, 'server');
  await fs.mkdir(serverDir, { recursive: true });
  await writeFile(path.join(serverDir, 'server.jar'), 'fake');

  const config = { backupPath: dir, serverPath: serverDir, minecraftVersion: '1.20.1' };

  try {
    // Start two backups concurrently — one should fail with lock error
    const p1 = createBackup(config, { type: 'manual' }).catch((e) => e);
    const p2 = createBackup(config, { type: 'manual' }).catch((e) => e);
    const [r1, r2] = await Promise.all([p1, p2]);

    // At least one should be a lock error
    const errors = [r1, r2].filter((r) => r instanceof Error);
    const lockError = errors.find((e) => e.message.includes('already in progress'));
    assert.ok(lockError, 'Expected a lock contention error');
  } finally {
    // Ensure lock is cleaned up
    await cleanup(dir);
  }
});

// ===================== Quiesce (unit-level) =====================

test('createBackup: calls rconCmd for quiescing when provided', async () => {
  const dir = await makeTempBackupDir();
  const serverDir = path.join(dir, 'server');
  await fs.mkdir(serverDir, { recursive: true });
  await writeFile(path.join(serverDir, 'server.jar'), 'fake');

  const commands = [];
  const mockRconCmd = async (cmd) => {
    commands.push(cmd);
    return 'OK';
  };

  const config = { backupPath: dir, serverPath: serverDir, minecraftVersion: '1.20.1' };

  try {
    await createBackup(config, { type: 'manual', rconCmd: mockRconCmd });
  } catch {
    // tar may fail in test env
  }

  // Should have called save-all (flush or plain) and save-off before, save-on after
  assert.ok(
    commands.some((c) => c.startsWith('save-all')),
    'Expected save-all command',
  );
  assert.ok(commands.includes('save-on'), 'Expected save-on to re-enable auto-save');
});

// ===================== validateBackup =====================

test('validateBackup: returns error when archive is missing', async () => {
  const dir = await makeTempBackupDir();
  try {
    const result = await validateBackup({ backupPath: dir }, 'nonexistent.tar.gz');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('not found')));
  } finally {
    await cleanup(dir);
  }
});

test('validateBackup: warns when no manifest exists', async () => {
  const dir = await makeTempBackupDir();
  try {
    await writeFile(path.join(dir, 'old-backup.tar.gz'), 'archive-data');
    const result = await validateBackup({ backupPath: dir }, 'old-backup.tar.gz');
    assert.equal(result.valid, true);
    assert.equal(result.manifest, null);
    assert.ok(result.warnings.some((w) => w.includes('No manifest')));
  } finally {
    await cleanup(dir);
  }
});

test('validateBackup: passes when archive hash matches', async () => {
  const dir = await makeTempBackupDir();
  try {
    const content = 'valid-archive-content';
    await writeFile(path.join(dir, 'valid.tar.gz'), content);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    await writeFile(path.join(dir, 'valid.json'), JSON.stringify({ archiveHash: hash, archiveSize: content.length }));

    const result = await validateBackup({ backupPath: dir }, 'valid.tar.gz');
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  } finally {
    await cleanup(dir);
  }
});

test('validateBackup: fails when archive hash does not match', async () => {
  const dir = await makeTempBackupDir();
  try {
    await writeFile(path.join(dir, 'corrupt.tar.gz'), 'corrupted-data');
    await writeFile(
      path.join(dir, 'corrupt.json'),
      JSON.stringify({ archiveHash: 'deadbeef'.repeat(8), archiveSize: 14 }),
    );

    const result = await validateBackup({ backupPath: dir }, 'corrupt.tar.gz');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('integrity check failed')));
  } finally {
    await cleanup(dir);
  }
});

test('validateBackup: fails when archive size does not match', async () => {
  const dir = await makeTempBackupDir();
  try {
    const content = 'some-content';
    await writeFile(path.join(dir, 'size-mismatch.tar.gz'), content);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    await writeFile(path.join(dir, 'size-mismatch.json'), JSON.stringify({ archiveHash: hash, archiveSize: 999999 }));

    const result = await validateBackup({ backupPath: dir }, 'size-mismatch.tar.gz');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('size mismatch')));
  } finally {
    await cleanup(dir);
  }
});

test('validateBackup: warns when manifest lacks archiveHash', async () => {
  const dir = await makeTempBackupDir();
  try {
    await writeFile(path.join(dir, 'no-hash.tar.gz'), 'data');
    await writeFile(
      path.join(dir, 'no-hash.json'),
      JSON.stringify({ type: 'manual', createdAt: '2024-01-01T00:00:00Z' }),
    );

    const result = await validateBackup({ backupPath: dir }, 'no-hash.tar.gz');
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((w) => w.includes('integrity cannot be verified')));
    assert.ok(result.manifest);
  } finally {
    await cleanup(dir);
  }
});

test('validateBackup: returns manifest details when valid', async () => {
  const dir = await makeTempBackupDir();
  try {
    const content = 'archive-with-full-manifest';
    await writeFile(path.join(dir, 'full.tar.gz'), content);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const manifest = {
      createdAt: '2024-06-15T12:00:00Z',
      type: 'manual',
      appVersion: '1.0.0',
      minecraftVersion: '1.20.1',
      modCount: 15,
      includesDatabase: true,
      quiesced: true,
      archiveHash: hash,
      archiveSize: content.length,
    };
    await writeFile(path.join(dir, 'full.json'), JSON.stringify(manifest));

    const result = await validateBackup({ backupPath: dir }, 'full.tar.gz');
    assert.equal(result.valid, true);
    assert.equal(result.manifest.appVersion, '1.0.0');
    assert.equal(result.manifest.modCount, 15);
    assert.equal(result.manifest.minecraftVersion, '1.20.1');
    assert.equal(result.manifest.includesDatabase, true);
  } finally {
    await cleanup(dir);
  }
});
