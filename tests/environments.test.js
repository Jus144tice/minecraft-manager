// Tests for the multi-environment management module in src/environments.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENV_KEYS,
  validateEnvironmentId,
  validateEnvironmentConfig,
  slugify,
  migrateToEnvironments,
  resolveConfig,
  getSelectedConfig,
  getSelectedEnvId,
  listEnvironments,
  getEnvironment,
  createEnvironment,
  updateEnvironment,
  deleteEnvironment,
  switchActiveEnvironment,
} from '../src/environments.js';

// ---- Helpers ------------------------------------------------

function makeFlatConfig(overrides = {}) {
  return {
    serverPath: '/home/minecraft/server',
    launch: { executable: 'java', args: ['-Xmx4G', 'nogui'] },
    rconHost: '127.0.0.1',
    rconPort: 25575,
    rconPassword: 'secret',
    minecraftVersion: '1.20.1',
    modsFolder: 'mods',
    disabledModsFolder: 'mods_disabled',
    serverAddress: 'play.example.com',
    autoStart: false,
    autoRestart: true,
    tpsAlertThreshold: 18,
    webPort: 3000,
    bindHost: '127.0.0.1',
    backupPath: '/mnt/backups',
    demoMode: false,
    ...overrides,
  };
}

function makeRawConfig(envOverrides = {}, sharedOverrides = {}) {
  return {
    environments: {
      production: {
        name: 'Production',
        serverPath: '/home/minecraft/server',
        launch: { executable: 'java', args: ['-Xmx4G', 'nogui'] },
        rconHost: '127.0.0.1',
        rconPort: 25575,
        rconPassword: 'secret',
        minecraftVersion: '1.20.1',
        modsFolder: 'mods',
        disabledModsFolder: 'mods_disabled',
        serverAddress: 'play.example.com',
        autoStart: false,
        autoRestart: true,
        tpsAlertThreshold: 18,
        createdAt: '2026-01-01T00:00:00.000Z',
        ...envOverrides,
      },
    },
    activeEnvironment: 'production',
    webPort: 3000,
    bindHost: '127.0.0.1',
    backupPath: '/mnt/backups',
    demoMode: false,
    ...sharedOverrides,
  };
}

// ---- ENV_KEYS -----------------------------------------------

test('ENV_KEYS contains expected per-environment keys', () => {
  assert.ok(ENV_KEYS.includes('serverPath'));
  assert.ok(ENV_KEYS.includes('launch'));
  assert.ok(ENV_KEYS.includes('rconPort'));
  assert.ok(ENV_KEYS.includes('minecraftVersion'));
  assert.ok(ENV_KEYS.includes('autoStart'));
  // Shared keys should NOT be in ENV_KEYS
  assert.ok(!ENV_KEYS.includes('webPort'));
  assert.ok(!ENV_KEYS.includes('backupPath'));
  assert.ok(!ENV_KEYS.includes('demoMode'));
});

// ---- validateEnvironmentId ----------------------------------

test('validateEnvironmentId accepts valid slugs', () => {
  assert.ok(validateEnvironmentId('production'));
  assert.ok(validateEnvironmentId('dev'));
  assert.ok(validateEnvironmentId('test-env'));
  assert.ok(validateEnvironmentId('mc-121-test'));
  assert.ok(validateEnvironmentId('a'));
});

test('validateEnvironmentId rejects invalid slugs', () => {
  assert.ok(!validateEnvironmentId(''));
  assert.ok(!validateEnvironmentId('Production')); // uppercase
  assert.ok(!validateEnvironmentId('-start')); // starts with hyphen
  assert.ok(!validateEnvironmentId('has space'));
  assert.ok(!validateEnvironmentId('has_underscore'));
  assert.ok(!validateEnvironmentId('a'.repeat(33))); // too long
  assert.ok(!validateEnvironmentId(123));
  assert.ok(!validateEnvironmentId(null));
});

// ---- validateEnvironmentConfig ------------------------------

test('validateEnvironmentConfig accepts valid config', () => {
  const errors = validateEnvironmentConfig({
    name: 'Production',
    serverPath: '/home/minecraft/server',
    launch: { executable: 'java', args: ['-Xmx4G'] },
    rconPort: 25575,
  });
  assert.deepEqual(errors, []);
});

test('validateEnvironmentConfig requires name', () => {
  const errors = validateEnvironmentConfig({ serverPath: '/path' });
  assert.ok(errors.some((e) => e.includes('name')));
});

test('validateEnvironmentConfig requires serverPath', () => {
  const errors = validateEnvironmentConfig({ name: 'Test' });
  assert.ok(errors.some((e) => e.includes('serverPath')));
});

test('validateEnvironmentConfig validates launch structure', () => {
  const errors = validateEnvironmentConfig({
    name: 'Test',
    serverPath: '/path',
    launch: { executable: '', args: [] },
  });
  assert.ok(errors.some((e) => e.includes('launch.executable')));
});

test('validateEnvironmentConfig validates rconPort range', () => {
  const errors = validateEnvironmentConfig({
    name: 'Test',
    serverPath: '/path',
    rconPort: 99999,
  });
  assert.ok(errors.some((e) => e.includes('rconPort')));
});

test('validateEnvironmentConfig allows missing optional fields', () => {
  const errors = validateEnvironmentConfig({
    name: 'Minimal',
    serverPath: '/path',
  });
  assert.deepEqual(errors, []);
});

// ---- slugify ------------------------------------------------

test('slugify converts names to valid IDs', () => {
  assert.equal(slugify('Production'), 'production');
  assert.equal(slugify('My Test Server'), 'my-test-server');
  assert.equal(slugify('MC 1.21 Testing!'), 'mc-1-21-testing');
  assert.equal(slugify('  spaces  '), 'spaces');
});

test('slugify truncates to 32 chars', () => {
  const long = 'a'.repeat(50);
  assert.equal(slugify(long).length, 32);
});

// ---- migrateToEnvironments ----------------------------------

test('migrateToEnvironments converts flat config to environments structure', () => {
  const flat = makeFlatConfig();
  const { migrated, config } = migrateToEnvironments(flat);

  assert.ok(migrated);
  assert.ok(config.environments);
  assert.ok(config.environments.default);
  assert.equal(config.activeEnvironment, 'default');
  assert.equal(config.environments.default.name, 'Default');
  assert.equal(config.environments.default.serverPath, '/home/minecraft/server');
  assert.equal(config.environments.default.rconPort, 25575);

  // Per-env keys should NOT remain at top level
  assert.equal(config.serverPath, undefined);
  assert.equal(config.launch, undefined);
  assert.equal(config.rconPort, undefined);

  // Shared keys should remain at top level
  assert.equal(config.webPort, 3000);
  assert.equal(config.backupPath, '/mnt/backups');
  assert.equal(config.demoMode, false);
});

test('migrateToEnvironments is idempotent on already-migrated config', () => {
  const raw = makeRawConfig();
  const { migrated, config } = migrateToEnvironments(raw);

  assert.ok(!migrated);
  assert.deepEqual(config, raw);
});

test('migrateToEnvironments sets activeEnvironment if missing', () => {
  const raw = makeRawConfig();
  delete raw.activeEnvironment;
  const { migrated, config } = migrateToEnvironments(raw);

  assert.ok(migrated);
  assert.equal(config.activeEnvironment, 'production');
});

test('migrateToEnvironments preserves createdAt timestamp', () => {
  const flat = makeFlatConfig();
  const { config } = migrateToEnvironments(flat);
  assert.ok(config.environments.default.createdAt);
});

// ---- resolveConfig ------------------------------------------

test('resolveConfig produces a flat config from the active environment', () => {
  const raw = makeRawConfig();
  const flat = resolveConfig(raw);

  assert.equal(flat.serverPath, '/home/minecraft/server');
  assert.equal(flat.webPort, 3000);
  assert.equal(flat.rconPort, 25575);
  assert.equal(flat.activeEnvironment, 'production');
  // environments key should not leak into flat config
  assert.equal(flat.environments, undefined);
});

test('resolveConfig can resolve a specific environment', () => {
  const raw = makeRawConfig();
  raw.environments.staging = {
    name: 'Staging',
    serverPath: '/home/minecraft/staging',
    rconPort: 25576,
    minecraftVersion: '1.21',
  };

  const flat = resolveConfig(raw, 'staging');
  assert.equal(flat.serverPath, '/home/minecraft/staging');
  assert.equal(flat.rconPort, 25576);
  assert.equal(flat.minecraftVersion, '1.21');
  // Shared keys still present
  assert.equal(flat.webPort, 3000);
});

test('resolveConfig throws for unknown environment', () => {
  const raw = makeRawConfig();
  assert.throws(() => resolveConfig(raw, 'nonexistent'), /Unknown environment/);
});

// ---- getSelectedConfig / getSelectedEnvId -------------------

test('getSelectedConfig returns active env config when no session selection', () => {
  const raw = makeRawConfig();
  const ctx = { rawConfig: raw, config: resolveConfig(raw) };
  const req = { session: {} };

  const config = getSelectedConfig(ctx, req);
  assert.equal(config.serverPath, '/home/minecraft/server');
});

test('getSelectedConfig returns selected env config from session', () => {
  const raw = makeRawConfig();
  raw.environments.staging = {
    name: 'Staging',
    serverPath: '/home/minecraft/staging',
    minecraftVersion: '1.21',
  };
  const ctx = { rawConfig: raw, config: resolveConfig(raw) };
  const req = { session: { selectedEnvironment: 'staging' } };

  const config = getSelectedConfig(ctx, req);
  assert.equal(config.serverPath, '/home/minecraft/staging');
});

test('getSelectedEnvId returns session selection or active fallback', () => {
  const raw = makeRawConfig();
  const ctx = { rawConfig: raw };

  assert.equal(getSelectedEnvId(ctx, { session: {} }), 'production');
  assert.equal(getSelectedEnvId(ctx, { session: { selectedEnvironment: 'staging' } }), 'staging');
  assert.equal(getSelectedEnvId(ctx, {}), 'production');
});

// ---- listEnvironments ---------------------------------------

test('listEnvironments returns environment summaries', () => {
  const raw = makeRawConfig();
  raw.environments.staging = {
    name: 'Staging',
    serverPath: '/staging',
    minecraftVersion: '1.21',
  };
  const list = listEnvironments(raw);

  assert.equal(list.length, 2);
  const prod = list.find((e) => e.id === 'production');
  const staging = list.find((e) => e.id === 'staging');
  assert.ok(prod);
  assert.ok(staging);
  assert.ok(prod.isActive);
  assert.ok(!staging.isActive);
  assert.equal(prod.name, 'Production');
  assert.equal(staging.serverPath, '/staging');
});

// ---- getEnvironment -----------------------------------------

test('getEnvironment returns environment or null', () => {
  const raw = makeRawConfig();
  assert.ok(getEnvironment(raw, 'production'));
  assert.equal(getEnvironment(raw, 'nonexistent'), null);
});

// ---- createEnvironment --------------------------------------

test('createEnvironment adds a new environment', () => {
  const raw = makeRawConfig();
  const updated = createEnvironment(raw, 'staging', {
    name: 'Staging',
    serverPath: '/staging',
  });

  assert.ok(updated.environments.staging);
  assert.equal(updated.environments.staging.name, 'Staging');
  assert.ok(updated.environments.staging.createdAt);
  // Original environments untouched
  assert.ok(updated.environments.production);
});

test('createEnvironment rejects invalid ID', () => {
  const raw = makeRawConfig();
  assert.throws(() => createEnvironment(raw, 'Bad ID!', { name: 'X', serverPath: '/' }), /Invalid environment ID/);
});

test('createEnvironment rejects duplicate ID', () => {
  const raw = makeRawConfig();
  assert.throws(() => createEnvironment(raw, 'production', { name: 'Dupe', serverPath: '/' }), /already exists/);
});

test('createEnvironment rejects invalid config', () => {
  const raw = makeRawConfig();
  assert.throws(() => createEnvironment(raw, 'bad', { name: '' }), /Invalid environment config/);
});

// ---- updateEnvironment --------------------------------------

test('updateEnvironment merges changes into existing environment', () => {
  const raw = makeRawConfig();
  const updated = updateEnvironment(raw, 'production', {
    name: 'Prod (updated)',
    minecraftVersion: '1.21',
  });

  assert.equal(updated.environments.production.name, 'Prod (updated)');
  assert.equal(updated.environments.production.minecraftVersion, '1.21');
  // Unchanged fields preserved
  assert.equal(updated.environments.production.serverPath, '/home/minecraft/server');
});

test('updateEnvironment ignores non-env keys', () => {
  const raw = makeRawConfig();
  const updated = updateEnvironment(raw, 'production', {
    webPort: 9999, // not an env key
  });

  assert.equal(updated.environments.production.webPort, undefined);
});

test('updateEnvironment throws for unknown environment', () => {
  const raw = makeRawConfig();
  assert.throws(() => updateEnvironment(raw, 'nope', { name: 'X' }), /not found/);
});

// ---- deleteEnvironment --------------------------------------

test('deleteEnvironment removes a non-active environment', () => {
  const raw = makeRawConfig();
  raw.environments.staging = { name: 'Staging', serverPath: '/staging' };
  const updated = deleteEnvironment(raw, 'staging');

  assert.equal(updated.environments.staging, undefined);
  assert.ok(updated.environments.production); // untouched
});

test('deleteEnvironment throws for active environment', () => {
  const raw = makeRawConfig();
  assert.throws(() => deleteEnvironment(raw, 'production'), /Cannot delete the active environment/);
});

test('deleteEnvironment throws for unknown environment', () => {
  const raw = makeRawConfig();
  assert.throws(() => deleteEnvironment(raw, 'nope'), /not found/);
});

// ---- switchActiveEnvironment --------------------------------

test('switchActiveEnvironment changes the active environment', () => {
  const raw = makeRawConfig();
  raw.environments.staging = { name: 'Staging', serverPath: '/staging' };
  const updated = switchActiveEnvironment(raw, 'staging');

  assert.equal(updated.activeEnvironment, 'staging');
});

test('switchActiveEnvironment throws for unknown environment', () => {
  const raw = makeRawConfig();
  assert.throws(() => switchActiveEnvironment(raw, 'nope'), /not found/);
});

// ---- Integration: migrate then resolve ----------------------

test('full lifecycle: migrate flat config, resolve, CRUD', () => {
  const flat = makeFlatConfig();
  const { config: raw } = migrateToEnvironments(flat);

  // Resolve the default environment
  const resolved = resolveConfig(raw);
  assert.equal(resolved.serverPath, '/home/minecraft/server');
  assert.equal(resolved.webPort, 3000);

  // Create a new environment
  const withStaging = createEnvironment(raw, 'staging', {
    name: 'Staging',
    serverPath: '/staging',
    rconPort: 25576,
    minecraftVersion: '1.21',
  });

  // Switch to it
  const switched = switchActiveEnvironment(withStaging, 'staging');
  const stagingConfig = resolveConfig(switched);
  assert.equal(stagingConfig.serverPath, '/staging');
  assert.equal(stagingConfig.rconPort, 25576);
  assert.equal(stagingConfig.webPort, 3000); // shared

  // Delete the old default
  const cleaned = deleteEnvironment(switched, 'default');
  assert.equal(Object.keys(cleaned.environments).length, 1);
});
