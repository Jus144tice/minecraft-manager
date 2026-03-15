// Tests for src/mrpack.js — .mrpack parsing, validation, classification, and building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yazl from 'yazl';
import {
  classifyEntry,
  sideToEnv,
  validateIndex,
  extractDependencies,
  analyzeForServer,
  isSafeOverridePath,
  parseMrpack,
  extractOverrides,
  buildMrpack,
} from '../src/mrpack.js';

// ============================================================
// Helper: build a minimal valid .mrpack buffer for testing
// ============================================================

function makeValidIndex(overrides = {}) {
  return {
    formatVersion: 1,
    game: 'minecraft',
    name: 'Test Pack',
    versionId: '1.0.0',
    files: [
      {
        path: 'mods/test-mod.jar',
        hashes: { sha1: 'abc123', sha512: 'def456' },
        downloads: ['https://cdn.modrinth.com/data/test/test-mod.jar'],
        fileSize: 12345,
        env: { client: 'required', server: 'required' },
      },
    ],
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
    ...overrides,
  };
}

function buildTestZip(indexObj, extras = []) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(indexObj), 'utf8'), 'modrinth.index.json');
    for (const { name, content } of extras) {
      zip.addBuffer(Buffer.from(content, 'utf8'), name);
    }
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

// ============================================================
// classifyEntry
// ============================================================

test('classifyEntry: server-only (client=unsupported)', () => {
  assert.equal(classifyEntry({ env: { client: 'unsupported', server: 'required' } }), 'server');
});

test('classifyEntry: client-only (server=unsupported)', () => {
  assert.equal(classifyEntry({ env: { client: 'required', server: 'unsupported' } }), 'client');
});

test('classifyEntry: both required', () => {
  assert.equal(classifyEntry({ env: { client: 'required', server: 'required' } }), 'both');
});

test('classifyEntry: both optional', () => {
  assert.equal(classifyEntry({ env: { client: 'optional', server: 'optional' } }), 'both');
});

test('classifyEntry: mixed required/optional is both', () => {
  assert.equal(classifyEntry({ env: { client: 'optional', server: 'required' } }), 'both');
  assert.equal(classifyEntry({ env: { client: 'required', server: 'optional' } }), 'both');
});

test('classifyEntry: no env field returns unknown', () => {
  assert.equal(classifyEntry({}), 'unknown');
  assert.equal(classifyEntry({ env: null }), 'unknown');
  assert.equal(classifyEntry(null), 'unknown');
});

test('classifyEntry: empty env object returns unknown', () => {
  assert.equal(classifyEntry({ env: {} }), 'unknown');
});

// ============================================================
// sideToEnv
// ============================================================

test('sideToEnv: maps valid values', () => {
  assert.deepEqual(sideToEnv('required', 'optional'), { client: 'required', server: 'optional' });
});

test('sideToEnv: defaults invalid values to optional', () => {
  assert.deepEqual(sideToEnv('invalid', 'nope'), { client: 'optional', server: 'optional' });
});

test('sideToEnv: handles unsupported', () => {
  assert.deepEqual(sideToEnv('unsupported', 'required'), { client: 'unsupported', server: 'required' });
});

// ============================================================
// validateIndex
// ============================================================

test('validateIndex: accepts valid index', () => {
  const errors = validateIndex(makeValidIndex());
  assert.equal(errors.length, 0);
});

test('validateIndex: rejects null/non-object', () => {
  assert.ok(validateIndex(null).length > 0);
  assert.ok(validateIndex('string').length > 0);
});

test('validateIndex: rejects wrong formatVersion', () => {
  const errors = validateIndex(makeValidIndex({ formatVersion: 2 }));
  assert.ok(errors.some((e) => e.includes('formatVersion')));
});

test('validateIndex: rejects wrong game', () => {
  const errors = validateIndex(makeValidIndex({ game: 'terraria' }));
  assert.ok(errors.some((e) => e.includes('game')));
});

test('validateIndex: rejects missing name', () => {
  const errors = validateIndex(makeValidIndex({ name: '' }));
  assert.ok(errors.some((e) => e.includes('name')));
});

test('validateIndex: rejects missing versionId', () => {
  const errors = validateIndex(makeValidIndex({ versionId: '' }));
  assert.ok(errors.some((e) => e.includes('versionId')));
});

test('validateIndex: rejects non-array files', () => {
  const errors = validateIndex(makeValidIndex({ files: 'not-array' }));
  assert.ok(errors.some((e) => e.includes('files')));
});

test('validateIndex: rejects file entry missing path', () => {
  const idx = makeValidIndex({ files: [{ hashes: { sha1: 'a' }, downloads: ['https://x.com/f'] }] });
  const errors = validateIndex(idx);
  assert.ok(errors.some((e) => e.includes('path')));
});

test('validateIndex: rejects file entry missing hashes', () => {
  const idx = makeValidIndex({ files: [{ path: 'mods/x.jar', downloads: ['https://x.com/f'] }] });
  const errors = validateIndex(idx);
  assert.ok(errors.some((e) => e.includes('hashes')));
});

test('validateIndex: rejects file entry with empty downloads', () => {
  const idx = makeValidIndex({ files: [{ path: 'mods/x.jar', hashes: { sha1: 'a' }, downloads: [] }] });
  const errors = validateIndex(idx);
  assert.ok(errors.some((e) => e.includes('downloads')));
});

test('validateIndex: rejects invalid download URL', () => {
  const idx = makeValidIndex({
    files: [{ path: 'mods/x.jar', hashes: { sha1: 'a' }, downloads: ['not-a-url'] }],
  });
  const errors = validateIndex(idx);
  assert.ok(errors.some((e) => e.includes('URL')));
});

test('validateIndex: rejects invalid env values', () => {
  const idx = makeValidIndex({
    files: [
      {
        path: 'mods/x.jar',
        hashes: { sha1: 'a' },
        downloads: ['https://x.com/f'],
        env: { client: 'bad', server: 'wrong' },
      },
    ],
  });
  const errors = validateIndex(idx);
  assert.ok(errors.some((e) => e.includes('env.client')));
  assert.ok(errors.some((e) => e.includes('env.server')));
});

test('validateIndex: rejects missing dependencies', () => {
  const idx = makeValidIndex();
  delete idx.dependencies;
  const errors = validateIndex(idx);
  assert.ok(errors.some((e) => e.includes('dependencies')));
});

// ============================================================
// extractDependencies
// ============================================================

test('extractDependencies: extracts minecraft + fabric', () => {
  const result = extractDependencies(makeValidIndex());
  assert.equal(result.minecraftVersion, '1.20.1');
  assert.equal(result.loader, 'fabric');
  assert.equal(result.loaderVersion, '0.15.0');
});

test('extractDependencies: extracts forge', () => {
  const result = extractDependencies({ dependencies: { minecraft: '1.20.1', forge: '47.2.0' } });
  assert.equal(result.loader, 'forge');
  assert.equal(result.loaderVersion, '47.2.0');
});

test('extractDependencies: extracts neoforge', () => {
  const result = extractDependencies({ dependencies: { minecraft: '1.21', neoforge: '21.0.1' } });
  assert.equal(result.loader, 'neoforge');
});

test('extractDependencies: extracts quilt', () => {
  const result = extractDependencies({ dependencies: { minecraft: '1.20', 'quilt-loader': '0.20.0' } });
  assert.equal(result.loader, 'quilt');
});

test('extractDependencies: handles missing dependencies', () => {
  const result = extractDependencies({});
  assert.equal(result.minecraftVersion, null);
  assert.equal(result.loader, null);
});

// ============================================================
// analyzeForServer
// ============================================================

test('analyzeForServer: partitions files by classification', () => {
  const index = {
    files: [
      { path: 'mods/server.jar', env: { client: 'unsupported', server: 'required' } },
      { path: 'mods/client.jar', env: { client: 'required', server: 'unsupported' } },
      { path: 'mods/both.jar', env: { client: 'required', server: 'required' } },
      { path: 'mods/unknown.jar' },
    ],
  };
  const result = analyzeForServer(index);
  assert.equal(result.server.length, 1);
  assert.equal(result.client.length, 1);
  assert.equal(result.both.length, 1);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.server[0]._classification, 'server');
});

test('analyzeForServer: handles empty files', () => {
  const result = analyzeForServer({ files: [] });
  assert.equal(result.server.length, 0);
  assert.equal(result.client.length, 0);
});

// ============================================================
// isSafeOverridePath
// ============================================================

test('isSafeOverridePath: allows normal relative paths', () => {
  assert.ok(isSafeOverridePath('config/mod.toml'));
  assert.ok(isSafeOverridePath('mods/test.jar'));
});

test('isSafeOverridePath: blocks path traversal', () => {
  assert.ok(!isSafeOverridePath('../etc/passwd'));
  assert.ok(!isSafeOverridePath('config/../../secret'));
});

test('isSafeOverridePath: blocks absolute paths', () => {
  assert.ok(!isSafeOverridePath('/etc/passwd'));
});

test('isSafeOverridePath: blocks backslashes', () => {
  assert.ok(!isSafeOverridePath('config\\mod.toml'));
});

test('isSafeOverridePath: blocks null bytes', () => {
  assert.ok(!isSafeOverridePath('config\0evil'));
});

test('isSafeOverridePath: blocks empty string', () => {
  assert.ok(!isSafeOverridePath(''));
});

test('isSafeOverridePath: blocks very long paths', () => {
  assert.ok(!isSafeOverridePath('a'.repeat(501)));
});

test('isSafeOverridePath: blocks non-string input', () => {
  assert.ok(!isSafeOverridePath(null));
  assert.ok(!isSafeOverridePath(42));
});

// ============================================================
// parseMrpack
// ============================================================

test('parseMrpack: parses valid mrpack buffer', async () => {
  const index = makeValidIndex();
  const buf = await buildTestZip(index);
  const result = await parseMrpack(buf);
  assert.equal(result.index.name, 'Test Pack');
  assert.equal(result.index.files.length, 1);
  assert.deepEqual(result.overridePaths, []);
  assert.deepEqual(result.serverOverridePaths, []);
});

test('parseMrpack: catalogs override paths', async () => {
  const index = makeValidIndex();
  const buf = await buildTestZip(index, [
    { name: 'overrides/config/mod.toml', content: 'key=val' },
    { name: 'server-overrides/server.properties', content: 'motd=hi' },
    { name: 'client-overrides/options.txt', content: 'skip' },
  ]);
  const result = await parseMrpack(buf);
  assert.deepEqual(result.overridePaths, ['config/mod.toml']);
  assert.deepEqual(result.serverOverridePaths, ['server.properties']);
});

test('parseMrpack: does not catalog client-overrides', async () => {
  const index = makeValidIndex();
  const buf = await buildTestZip(index, [
    { name: 'client-overrides/options.txt', content: 'skip' },
    { name: 'overrides/config/mod.toml', content: 'ok' },
  ]);
  const result = await parseMrpack(buf);
  assert.deepEqual(result.overridePaths, ['config/mod.toml']);
  // client-overrides not in either list
  assert.deepEqual(result.serverOverridePaths, []);
});

test('parseMrpack: rejects non-buffer input', async () => {
  await assert.rejects(() => parseMrpack('not a buffer'), /Expected a Buffer/);
});

test('parseMrpack: rejects missing modrinth.index.json', async () => {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('hello'), 'readme.txt');
  zip.end();
  const buf = await new Promise((resolve) => {
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  await assert.rejects(() => parseMrpack(buf), /Missing modrinth\.index\.json/);
});

test('parseMrpack: rejects invalid JSON in index', async () => {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('not json{{{', 'utf8'), 'modrinth.index.json');
  zip.end();
  const buf = await new Promise((resolve) => {
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  await assert.rejects(() => parseMrpack(buf), /Invalid JSON/);
});

// ============================================================
// extractOverrides
// ============================================================

test('extractOverrides: extracts overrides and server-overrides', async () => {
  const index = makeValidIndex();
  const buf = await buildTestZip(index, [
    { name: 'overrides/config/mod.toml', content: 'key=val' },
    { name: 'server-overrides/server.properties', content: 'motd=test' },
    { name: 'client-overrides/options.txt', content: 'skip-this' },
  ]);
  const serverPath = '/tmp/test-server';
  const files = await extractOverrides(buf, serverPath);
  assert.equal(files.length, 2);
  const paths = files.map((f) => f.relativePath).sort();
  assert.deepEqual(paths, ['config/mod.toml', 'server.properties']);
  assert.equal(files.find((f) => f.relativePath === 'config/mod.toml').buffer.toString(), 'key=val');
});

test('extractOverrides: ignores client-overrides', async () => {
  const index = makeValidIndex();
  const buf = await buildTestZip(index, [
    { name: 'client-overrides/options.txt', content: 'skip' },
    { name: 'overrides/config/mod.toml', content: 'ok' },
  ]);
  const files = await extractOverrides(buf, '/tmp/test-server');
  assert.equal(files.length, 1);
  assert.equal(files[0].relativePath, 'config/mod.toml');
});

// ============================================================
// buildMrpack
// ============================================================

test('buildMrpack: produces valid mrpack that can be re-parsed', async () => {
  const buf = await buildMrpack({
    name: 'My Pack',
    versionId: '2.0.0',
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
    files: [
      {
        path: 'mods/test.jar',
        hashes: { sha1: 'abc', sha512: 'def' },
        downloads: ['https://cdn.modrinth.com/test.jar'],
        fileSize: 1000,
        env: { client: 'required', server: 'required' },
      },
    ],
    overrides: [{ relativePath: 'config/test.toml', buffer: Buffer.from('setting=true') }],
  });

  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 0);

  // Re-parse the built mrpack
  const parsed = await parseMrpack(buf);
  assert.equal(parsed.index.name, 'My Pack');
  assert.equal(parsed.index.versionId, '2.0.0');
  assert.equal(parsed.index.files.length, 1);
  assert.equal(parsed.index.files[0].path, 'mods/test.jar');
  assert.deepEqual(parsed.serverOverridePaths, ['config/test.toml']);
});

test('buildMrpack: uses defaults for missing name/versionId', async () => {
  const buf = await buildMrpack({
    files: [],
    dependencies: { minecraft: '1.20.1' },
  });
  const parsed = await parseMrpack(buf);
  assert.equal(parsed.index.name, 'Server Modpack');
  assert.equal(parsed.index.versionId, '1.0.0');
});

test('buildMrpack: skips unsafe override paths', async () => {
  const buf = await buildMrpack({
    name: 'Test',
    versionId: '1.0.0',
    files: [],
    dependencies: {},
    overrides: [{ relativePath: '../etc/passwd', buffer: Buffer.from('evil') }],
  });
  const parsed = await parseMrpack(buf);
  assert.deepEqual(parsed.serverOverridePaths, []);
});

test('buildMrpack: omits env when not provided', async () => {
  const buf = await buildMrpack({
    name: 'Test',
    versionId: '1.0.0',
    files: [
      {
        path: 'mods/no-env.jar',
        hashes: { sha1: 'abc' },
        downloads: ['https://cdn.modrinth.com/no-env.jar'],
        fileSize: 500,
      },
    ],
    dependencies: {},
  });
  const parsed = await parseMrpack(buf);
  assert.equal(parsed.index.files[0].env, undefined);
});

// ============================================================
// Round-trip: build → parse → extract overrides
// ============================================================

test('round-trip: overrides survive build → extractOverrides', async () => {
  const overrideContent = 'max-tick-time=60000';
  const buf = await buildMrpack({
    name: 'Round Trip',
    versionId: '1.0.0',
    files: [],
    dependencies: { minecraft: '1.20.1' },
    overrides: [{ relativePath: 'server.properties', buffer: Buffer.from(overrideContent) }],
  });

  const files = await extractOverrides(buf, '/tmp/server');
  assert.equal(files.length, 1);
  assert.equal(files[0].relativePath, 'server.properties');
  assert.equal(files[0].buffer.toString(), overrideContent);
});
