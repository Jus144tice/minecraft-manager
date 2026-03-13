// Tests for server file operations in src/serverFiles.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  listMods,
  toggleMod,
  deleteMod,
  saveMod,
  hashFile,
  hashMods,
  getOps,
  setOps,
  getWhitelist,
  setWhitelist,
  getServerProperties,
  setServerProperties,
} from '../src/serverFiles.js';

// --- Temp directory helpers ---

async function makeTempServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
  await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
  await fs.mkdir(path.join(dir, 'mods_disabled'), { recursive: true });
  return dir;
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeJar(dir, folder, name, content = 'fake jar content') {
  await fs.writeFile(path.join(dir, folder, name), content);
}

// ===================== listMods =====================

test('listMods: returns empty array when no jars exist', async () => {
  const dir = await makeTempServer();
  try {
    const mods = await listMods(dir);
    assert.deepEqual(mods, []);
  } finally {
    await cleanup(dir);
  }
});

test('listMods: lists enabled and disabled mods sorted by name', async () => {
  const dir = await makeTempServer();
  try {
    await writeJar(dir, 'mods', 'beta-mod.jar');
    await writeJar(dir, 'mods', 'alpha-mod.jar');
    await writeJar(dir, 'mods_disabled', 'charlie-mod.jar');

    const mods = await listMods(dir);
    assert.equal(mods.length, 3);
    assert.equal(mods[0].filename, 'alpha-mod.jar');
    assert.equal(mods[0].enabled, true);
    assert.equal(mods[1].filename, 'beta-mod.jar');
    assert.equal(mods[1].enabled, true);
    assert.equal(mods[2].filename, 'charlie-mod.jar');
    assert.equal(mods[2].enabled, false);
  } finally {
    await cleanup(dir);
  }
});

test('listMods: ignores non-jar files', async () => {
  const dir = await makeTempServer();
  try {
    await writeJar(dir, 'mods', 'readme.txt');
    await writeJar(dir, 'mods', 'real-mod.jar');
    const mods = await listMods(dir);
    assert.equal(mods.length, 1);
    assert.equal(mods[0].filename, 'real-mod.jar');
  } finally {
    await cleanup(dir);
  }
});

test('listMods: handles missing mods folder gracefully', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
  try {
    const mods = await listMods(dir);
    assert.deepEqual(mods, []);
  } finally {
    await cleanup(dir);
  }
});

test('listMods: includes file size', async () => {
  const dir = await makeTempServer();
  try {
    const content = 'x'.repeat(1234);
    await writeJar(dir, 'mods', 'sized.jar', content);
    const mods = await listMods(dir);
    assert.equal(mods[0].size, 1234);
  } finally {
    await cleanup(dir);
  }
});

// ===================== toggleMod =====================

test('toggleMod: disables a mod by moving to disabled folder', async () => {
  const dir = await makeTempServer();
  try {
    await writeJar(dir, 'mods', 'test.jar');
    await toggleMod(dir, 'test.jar', false);

    const enabledFiles = await fs.readdir(path.join(dir, 'mods'));
    const disabledFiles = await fs.readdir(path.join(dir, 'mods_disabled'));
    assert.equal(enabledFiles.includes('test.jar'), false);
    assert.equal(disabledFiles.includes('test.jar'), true);
  } finally {
    await cleanup(dir);
  }
});

test('toggleMod: enables a mod by moving to mods folder', async () => {
  const dir = await makeTempServer();
  try {
    await writeJar(dir, 'mods_disabled', 'test.jar');
    await toggleMod(dir, 'test.jar', true);

    const enabledFiles = await fs.readdir(path.join(dir, 'mods'));
    const disabledFiles = await fs.readdir(path.join(dir, 'mods_disabled'));
    assert.equal(enabledFiles.includes('test.jar'), true);
    assert.equal(disabledFiles.includes('test.jar'), false);
  } finally {
    await cleanup(dir);
  }
});

test('toggleMod: creates target directory if missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
  try {
    // Only create mods folder, not mods_disabled
    await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
    await writeJar(dir, 'mods', 'test.jar');
    await toggleMod(dir, 'test.jar', false);

    const disabledFiles = await fs.readdir(path.join(dir, 'mods_disabled'));
    assert.equal(disabledFiles.includes('test.jar'), true);
  } finally {
    await cleanup(dir);
  }
});

// ===================== deleteMod =====================

test('deleteMod: deletes from mods folder', async () => {
  const dir = await makeTempServer();
  try {
    await writeJar(dir, 'mods', 'doomed.jar');
    await deleteMod(dir, 'doomed.jar');
    const files = await fs.readdir(path.join(dir, 'mods'));
    assert.equal(files.includes('doomed.jar'), false);
  } finally {
    await cleanup(dir);
  }
});

test('deleteMod: deletes from disabled folder', async () => {
  const dir = await makeTempServer();
  try {
    await writeJar(dir, 'mods_disabled', 'doomed.jar');
    await deleteMod(dir, 'doomed.jar');
    const files = await fs.readdir(path.join(dir, 'mods_disabled'));
    assert.equal(files.includes('doomed.jar'), false);
  } finally {
    await cleanup(dir);
  }
});

test('deleteMod: throws when mod does not exist', async () => {
  const dir = await makeTempServer();
  try {
    await assert.rejects(() => deleteMod(dir, 'nonexistent.jar'), { message: /not found/i });
  } finally {
    await cleanup(dir);
  }
});

// ===================== saveMod =====================

test('saveMod: writes buffer to mods folder', async () => {
  const dir = await makeTempServer();
  try {
    const buf = Buffer.from('PK\x03\x04fake-jar-data');
    await saveMod(dir, 'new-mod.jar', buf);
    const written = await fs.readFile(path.join(dir, 'mods', 'new-mod.jar'));
    assert.deepEqual(written, buf);
  } finally {
    await cleanup(dir);
  }
});

test('saveMod: creates mods folder if missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
  try {
    const buf = Buffer.from('jar');
    await saveMod(dir, 'mod.jar', buf);
    const written = await fs.readFile(path.join(dir, 'mods', 'mod.jar'));
    assert.deepEqual(written, buf);
  } finally {
    await cleanup(dir);
  }
});

// ===================== hashFile / hashMods =====================

test('hashFile: returns SHA1 hex digest', async () => {
  const dir = await makeTempServer();
  try {
    const content = 'hello world';
    const filePath = path.join(dir, 'mods', 'test.jar');
    await fs.writeFile(filePath, content);
    const hash = await hashFile(filePath);
    // SHA1 of "hello world" is 2aae6c35c94fcfb415dbe95f408b9ce91ee846ed
    assert.equal(hash, '2aae6c35c94fcfb415dbe95f408b9ce91ee846ed');
  } finally {
    await cleanup(dir);
  }
});

test('hashMods: returns hash map for all jars in both folders', async () => {
  const dir = await makeTempServer();
  try {
    await writeJar(dir, 'mods', 'a.jar', 'content-a');
    await writeJar(dir, 'mods_disabled', 'b.jar', 'content-b');
    await writeJar(dir, 'mods', 'readme.txt', 'not a jar');

    const result = await hashMods(dir);
    assert.ok(result['a.jar']);
    assert.ok(result['b.jar']);
    assert.equal(result['readme.txt'], undefined);
    assert.equal(result['a.jar'].enabled, true);
    assert.equal(result['b.jar'].enabled, false);
    assert.equal(typeof result['a.jar'].hash, 'string');
    assert.equal(result['a.jar'].hash.length, 40); // SHA1 hex length
  } finally {
    await cleanup(dir);
  }
});

test('hashMods: returns empty object when no jars exist', async () => {
  const dir = await makeTempServer();
  try {
    const result = await hashMods(dir);
    assert.deepEqual(result, {});
  } finally {
    await cleanup(dir);
  }
});

// ===================== JSON data files =====================

test('getOps/setOps: round-trips ops data', async () => {
  const dir = await makeTempServer();
  try {
    const ops = [{ uuid: '123', name: 'Steve', level: 4 }];
    await setOps(dir, ops);
    const result = await getOps(dir);
    assert.deepEqual(result, ops);
  } finally {
    await cleanup(dir);
  }
});

test('getOps: returns empty array when file is missing', async () => {
  const dir = await makeTempServer();
  try {
    const result = await getOps(dir);
    assert.deepEqual(result, []);
  } finally {
    await cleanup(dir);
  }
});

test('getWhitelist/setWhitelist: round-trips whitelist data', async () => {
  const dir = await makeTempServer();
  try {
    const list = [{ uuid: '456', name: 'Alex' }];
    await setWhitelist(dir, list);
    const result = await getWhitelist(dir);
    assert.deepEqual(result, list);
  } finally {
    await cleanup(dir);
  }
});

// ===================== server.properties =====================

test('getServerProperties: parses key=value pairs', async () => {
  const dir = await makeTempServer();
  try {
    await fs.writeFile(
      path.join(dir, 'server.properties'),
      '# Minecraft server properties\nserver-port=25565\nmotd=A Minecraft Server\ndifficulty=hard\n',
    );
    const props = await getServerProperties(dir);
    assert.equal(props['server-port'], '25565');
    assert.equal(props['motd'], 'A Minecraft Server');
    assert.equal(props['difficulty'], 'hard');
  } finally {
    await cleanup(dir);
  }
});

test('getServerProperties: skips comments and blank lines', async () => {
  const dir = await makeTempServer();
  try {
    await fs.writeFile(path.join(dir, 'server.properties'), '# comment\n\nkey=value\n# another comment\n');
    const props = await getServerProperties(dir);
    assert.deepEqual(Object.keys(props), ['key']);
  } finally {
    await cleanup(dir);
  }
});

test('getServerProperties: returns empty object when file is missing', async () => {
  const dir = await makeTempServer();
  try {
    const props = await getServerProperties(dir);
    assert.deepEqual(props, {});
  } finally {
    await cleanup(dir);
  }
});

test('setServerProperties: updates existing keys and adds new ones', async () => {
  const dir = await makeTempServer();
  try {
    await fs.writeFile(path.join(dir, 'server.properties'), '# header\nserver-port=25565\nmotd=Old MOTD\n');

    await setServerProperties(dir, { motd: 'New MOTD', 'max-players': '20' });
    const props = await getServerProperties(dir);
    assert.equal(props['server-port'], '25565'); // unchanged
    assert.equal(props['motd'], 'New MOTD'); // updated
    assert.equal(props['max-players'], '20'); // added
  } finally {
    await cleanup(dir);
  }
});

test('setServerProperties: preserves comments', async () => {
  const dir = await makeTempServer();
  try {
    await fs.writeFile(path.join(dir, 'server.properties'), '# My server\nkey=old\n');
    await setServerProperties(dir, { key: 'new' });
    const raw = await fs.readFile(path.join(dir, 'server.properties'), 'utf8');
    assert.ok(raw.includes('# My server'));
  } finally {
    await cleanup(dir);
  }
});

test('setServerProperties: creates file if missing', async () => {
  const dir = await makeTempServer();
  try {
    await setServerProperties(dir, { difficulty: 'peaceful' });
    const props = await getServerProperties(dir);
    assert.equal(props['difficulty'], 'peaceful');
  } finally {
    await cleanup(dir);
  }
});

test('getServerProperties: handles value with equals sign', async () => {
  const dir = await makeTempServer();
  try {
    await fs.writeFile(path.join(dir, 'server.properties'), 'motd=Hello = World\n');
    const props = await getServerProperties(dir);
    assert.equal(props['motd'], 'Hello = World');
  } finally {
    await cleanup(dir);
  }
});
