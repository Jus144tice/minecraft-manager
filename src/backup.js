// Backup and restore module.
// Creates tar.gz snapshots of the Minecraft server, app config, and PostgreSQL database.
// Backups are stored in a configurable directory with timestamp-based naming.

import { execFile, spawn } from 'child_process';
import { mkdir, readdir, stat, unlink, readFile, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { audit, info, warn } from './audit.js';
import { getPool } from './db.js';
import cron from 'node-cron';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

let scheduledTask = null;

// ---- Helpers ----

function backupDir(config) {
  return config.backupPath || path.join(APP_ROOT, 'backups');
}

function generateBackupName() {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  return `mc-backup_${ts}`;
}

/** Return sorted list of backup metadata (newest first). */
export async function listBackups(config) {
  const dir = backupDir(config);
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir);
  const backups = [];

  for (const name of entries) {
    if (!name.endsWith('.tar.gz')) continue;
    const manifestName = name.replace('.tar.gz', '.json');
    const archivePath = path.join(dir, name);
    const manifestPath = path.join(dir, manifestName);

    let manifest = {};
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* no manifest */ }

    const s = await stat(archivePath);
    backups.push({
      filename: name,
      size: s.size,
      createdAt: manifest.createdAt || s.mtime.toISOString(),
      type: manifest.type || 'manual',
      serverPath: manifest.serverPath || null,
      minecraftVersion: manifest.minecraftVersion || null,
      includesDatabase: manifest.includesDatabase || false,
      note: manifest.note || '',
    });
  }

  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return backups;
}

// ---- Create backup ----

export async function createBackup(config, { type = 'manual', note = '', user = null } = {}) {
  const dir = backupDir(config);
  await mkdir(dir, { recursive: true });

  const name = generateBackupName();
  const stagingDir = path.join(dir, `_staging_${name}`);
  await mkdir(stagingDir, { recursive: true });

  try {
    // 1. Copy app config
    const appDir = path.join(stagingDir, 'app');
    await mkdir(appDir, { recursive: true });
    const configPath = path.join(APP_ROOT, 'config.json');
    if (existsSync(configPath)) {
      await writeFile(path.join(appDir, 'config.json'), await readFile(configPath));
    }

    // 2. Dump PostgreSQL if connected
    let includesDatabase = false;
    const pool = getPool();
    if (pool) {
      try {
        // Use SQL COPY commands for a portable dump that doesn't require pg_dump binary
        const dbDir = path.join(stagingDir, 'database');
        await mkdir(dbDir, { recursive: true });
        await dumpDatabaseSql(pool, dbDir);
        includesDatabase = true;
      } catch (err) {
        warn('Backup: PostgreSQL dump failed, continuing without DB', { error: err.message });
      }
    }

    // 3. Create the tar.gz of the Minecraft server + staging data
    const archivePath = path.join(dir, `${name}.tar.gz`);
    const serverPath = config.serverPath;

    // Build tar arguments
    // Archive the minecraft server and the staging dir (app config + db dump)
    const tarArgs = [
      '-czf', archivePath,
      '-C', path.dirname(serverPath), path.basename(serverPath),
      '-C', dir, `_staging_${name}`,
    ];

    await execFileAsync('tar', tarArgs, { maxBuffer: 10 * 1024 * 1024, timeout: 600000 });

    // 4. Write manifest
    const manifest = {
      name,
      createdAt: new Date().toISOString(),
      type,
      note,
      user: user || null,
      serverPath: config.serverPath,
      minecraftVersion: config.minecraftVersion || 'unknown',
      includesDatabase,
      modsFolder: config.modsFolder || 'mods',
      disabledModsFolder: config.disabledModsFolder || 'mods_disabled',
    };
    await writeFile(path.join(dir, `${name}.json`), JSON.stringify(manifest, null, 2));

    const archiveStat = await stat(archivePath);
    info('Backup created', { name, size: archiveStat.size, type, includesDatabase });
    audit('BACKUP_CREATE', { user: user || 'system', type, name, size: archiveStat.size });

    return { filename: `${name}.tar.gz`, size: archiveStat.size, createdAt: manifest.createdAt, type, includesDatabase };
  } finally {
    // Clean up staging directory
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- SQL-based database dump (no pg_dump binary needed) ----

async function dumpDatabaseSql(pool, outDir) {
  const tables = ['users', 'audit_logs'];
  const client = await pool.connect();
  try {
    for (const table of tables) {
      // Get column names
      const colResult = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = $1 ORDER BY ordinal_position`, [table]);
      if (colResult.rows.length === 0) continue;

      const columns = colResult.rows.map(r => r.column_name);
      const dataResult = await client.query(`SELECT * FROM ${table}`);

      const statements = [];
      // Header
      statements.push(`-- Dump of table: ${table}`);
      statements.push(`-- Rows: ${dataResult.rows.length}`);
      statements.push(`DELETE FROM ${table};`);

      // Generate INSERT statements
      for (const row of dataResult.rows) {
        const values = columns.map(col => {
          const val = row[col];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'number') return String(val);
          if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
          if (val instanceof Date) return `'${val.toISOString()}'`;
          if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        statements.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')});`);
      }

      // Reset sequences
      statements.push(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1)) FROM ${table};`);
      statements.push('');

      await writeFile(path.join(outDir, `${table}.sql`), statements.join('\n'));
    }
  } finally {
    client.release();
  }
}

// ---- Restore backup ----

export async function restoreBackup(config, filename, mc) {
  const dir = backupDir(config);
  const archivePath = path.join(dir, filename);

  if (!existsSync(archivePath)) throw new Error('Backup archive not found');
  if (!filename.endsWith('.tar.gz')) throw new Error('Invalid backup file');

  // Safety: server must be stopped
  if (mc && mc.running) {
    throw new Error('Stop the Minecraft server before restoring a backup');
  }

  // Read manifest
  const manifestPath = archivePath.replace('.tar.gz', '.json');
  let manifest = {};
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* ok */ }

  const serverPath = config.serverPath;
  const serverBasename = path.basename(serverPath);
  const serverParent = path.dirname(serverPath);
  const backupName = filename.replace('.tar.gz', '');

  // 1. Extract archive to a temp directory
  const extractDir = path.join(dir, `_restore_${Date.now()}`);
  await mkdir(extractDir, { recursive: true });

  try {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], { maxBuffer: 10 * 1024 * 1024, timeout: 600000 });

    // 2. Restore the Minecraft server directory
    const extractedServerDir = path.join(extractDir, serverBasename);
    if (existsSync(extractedServerDir)) {
      // Remove current server contents and replace
      await rm(serverPath, { recursive: true, force: true });
      // Move extracted server dir into place
      const { rename } = await import('fs/promises');
      try {
        await rename(extractedServerDir, serverPath);
      } catch {
        // Cross-device move — fall back to copy
        await execFileAsync('cp', ['-a', extractedServerDir, serverPath], { timeout: 300000 });
      }
      info('Restore: Minecraft server files restored');
    }

    // 3. Restore app config
    const extractedConfig = path.join(extractDir, `_staging_${backupName}`, 'app', 'config.json');
    if (existsSync(extractedConfig)) {
      await writeFile(path.join(APP_ROOT, 'config.json'), await readFile(extractedConfig));
      info('Restore: config.json restored');
    }

    // 4. Restore database
    const pool = getPool();
    if (pool) {
      const dbDir = path.join(extractDir, `_staging_${backupName}`, 'database');
      if (existsSync(dbDir)) {
        await restoreDatabaseSql(pool, dbDir);
        info('Restore: PostgreSQL data restored');
      }
    }

    audit('BACKUP_RESTORE', { filename, user: 'system' });
    info('Restore complete', { filename });
    return { ok: true, filename, includesDatabase: manifest.includesDatabase || false };
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function restoreDatabaseSql(pool, dbDir) {
  const files = await readdir(dbDir);
  const client = await pool.connect();
  try {
    for (const file of files.sort()) {
      if (!file.endsWith('.sql')) continue;
      const sql = await readFile(path.join(dbDir, file), 'utf8');
      // Execute each statement individually
      const statements = sql.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('--'));
      for (const stmt of statements) {
        try {
          await client.query(stmt);
        } catch (err) {
          warn(`Restore: SQL statement failed in ${file}`, { error: err.message, stmt: stmt.slice(0, 100) });
        }
      }
    }
  } finally {
    client.release();
  }
}

// ---- Delete backup ----

export async function deleteBackup(config, filename) {
  const dir = backupDir(config);

  if (!filename.endsWith('.tar.gz')) throw new Error('Invalid backup file');
  // Prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new Error('Invalid filename');
  }

  const archivePath = path.join(dir, filename);
  const manifestPath = archivePath.replace('.tar.gz', '.json');

  if (!existsSync(archivePath)) throw new Error('Backup not found');

  await unlink(archivePath);
  await unlink(manifestPath).catch(() => {}); // manifest may not exist
  info('Backup deleted', { filename });
  audit('BACKUP_DELETE', { filename });
}

// ---- Scheduled backups (cron) ----

export function setupBackupSchedule(config, mc) {
  stopBackupSchedule();

  if (!config.backupEnabled) {
    info('Scheduled backups disabled');
    return;
  }

  const schedule = config.backupSchedule || '0 3 * * *';
  if (!cron.validate(schedule)) {
    warn('Invalid backup cron schedule, falling back to 3 AM daily', { schedule });
    config.backupSchedule = '0 3 * * *';
  }

  const cronExpr = config.backupSchedule || '0 3 * * *';
  scheduledTask = cron.schedule(cronExpr, async () => {
    info('Scheduled backup starting...');
    try {
      const result = await createBackup(config, { type: 'scheduled' });
      info('Scheduled backup complete', { filename: result.filename, size: result.size });

      // Prune old backups if maxBackups is set
      if (config.maxBackups && config.maxBackups > 0) {
        await pruneOldBackups(config);
      }
    } catch (err) {
      warn('Scheduled backup failed', { error: err.message });
    }
  }, { timezone: config.backupTimezone || undefined });

  info('Backup schedule active', { schedule: cronExpr });
}

export function stopBackupSchedule() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

async function pruneOldBackups(config) {
  const max = config.maxBackups;
  if (!max || max <= 0) return;

  const all = await listBackups(config);
  // Only prune scheduled backups — leave manual backups untouched
  const scheduled = all.filter(b => b.type === 'scheduled');
  if (scheduled.length <= max) return;

  const toDelete = scheduled.slice(max);
  for (const backup of toDelete) {
    try {
      await deleteBackup(config, backup.filename);
      info('Pruned old scheduled backup', { filename: backup.filename });
    } catch (err) {
      warn('Failed to prune backup', { filename: backup.filename, error: err.message });
    }
  }
}
