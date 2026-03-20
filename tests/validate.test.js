// Tests for input validation in src/validate.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidMinecraftName,
  isSafeModFilename,
  isSafeMrpackFilename,
  isSafeCommand,
  sanitizeReason,
  validateConfig,
  parseLaunchCommand,
  migrateLaunchConfig,
  launchToString,
} from '../src/validate.js';

// --- isValidMinecraftName ---

test('isValidMinecraftName: accepts typical names', () => {
  assert.ok(isValidMinecraftName('Steve'));
  assert.ok(isValidMinecraftName('Alex_1234'));
  assert.ok(isValidMinecraftName('a'));
  assert.ok(isValidMinecraftName('a'.repeat(16)));
  assert.ok(isValidMinecraftName('Player_Name'));
});

test('isValidMinecraftName: rejects names that are too long', () => {
  assert.equal(isValidMinecraftName('a'.repeat(17)), false);
});

test('isValidMinecraftName: rejects empty string', () => {
  assert.equal(isValidMinecraftName(''), false);
});

test('isValidMinecraftName: rejects special characters used in injection attempts', () => {
  assert.equal(isValidMinecraftName('Steve; op @a'), false);
  assert.equal(isValidMinecraftName('name\nop @a'), false);
  assert.equal(isValidMinecraftName('name\x00'), false);
  assert.equal(isValidMinecraftName('../passwd'), false);
  assert.equal(isValidMinecraftName('<script>'), false);
});

test('isValidMinecraftName: rejects non-string types', () => {
  assert.equal(isValidMinecraftName(null), false);
  assert.equal(isValidMinecraftName(undefined), false);
  assert.equal(isValidMinecraftName(123), false);
});

// --- isSafeModFilename ---

test('isSafeModFilename: accepts valid jar filenames', () => {
  assert.ok(isSafeModFilename('create-1.20.1.jar'));
  assert.ok(isSafeModFilename('jei-1.20.1-forge-15.3.0.4.jar'));
  assert.ok(isSafeModFilename('Mod+Extra_Pack-v2.0.jar'));
  assert.ok(isSafeModFilename('a.jar'));
});

test('isSafeModFilename: rejects path traversal', () => {
  assert.equal(isSafeModFilename('../evil.jar'), false);
  assert.equal(isSafeModFilename('../../server.js'), false);
  assert.equal(isSafeModFilename('mods/../server.js'), false);
});

test('isSafeModFilename: rejects non-jar extensions', () => {
  assert.equal(isSafeModFilename('mod.zip'), false);
  assert.equal(isSafeModFilename('mod.exe'), false);
  assert.equal(isSafeModFilename('mod'), false);
});

test('isSafeModFilename: rejects path separators in name', () => {
  assert.equal(isSafeModFilename('subdir/mod.jar'), false);
  assert.equal(isSafeModFilename('sub\\mod.jar'), false);
});

test('isSafeModFilename: rejects empty and non-string', () => {
  assert.equal(isSafeModFilename(''), false);
  assert.equal(isSafeModFilename(null), false);
});

// --- isSafeMrpackFilename ---

test('isSafeMrpackFilename: accepts jar, jar.disabled, and zip files', () => {
  assert.ok(isSafeMrpackFilename('create-1.20.1.jar'));
  assert.ok(isSafeMrpackFilename('Terralith_1.20.x_v2.5.4.jar.disabled'));
  assert.ok(isSafeMrpackFilename('ComplementaryReimagined_r5.5.1.zip'));
});

test('isSafeMrpackFilename: accepts filenames with spaces, parens, and plus signs', () => {
  assert.ok(isSafeMrpackFilename('Create Encased-1.20.1-1.7.2-fix1.jar'));
  assert.ok(isSafeMrpackFilename('Dungeon Now Loading-forge-1.20.1-2.11.jar'));
  assert.ok(isSafeMrpackFilename('Bliss_v2.1.1_(Chocapic13_Shaders_edit).zip'));
  assert.ok(isSafeMrpackFilename('Scary Spider 1.20+.zip'));
  assert.ok(isSafeMrpackFilename('DetailedAnimationsReworked - V1.15.zip'));
  assert.ok(isSafeMrpackFilename('Forgematica-0.1.13-mc1.20.1.jar.disabled'));
});

test('isSafeMrpackFilename: rejects path traversal and backslashes', () => {
  assert.equal(isSafeMrpackFilename('../evil.jar'), false);
  assert.equal(isSafeMrpackFilename('sub\\mod.jar'), false);
  assert.equal(isSafeMrpackFilename('mods/sub/evil.jar'), false);
});

test('isSafeMrpackFilename: rejects non-allowed extensions and edge cases', () => {
  assert.equal(isSafeMrpackFilename('mod.exe'), false);
  assert.equal(isSafeMrpackFilename('script.sh'), false);
  assert.equal(isSafeMrpackFilename(''), false);
  assert.equal(isSafeMrpackFilename(null), false);
  assert.equal(isSafeMrpackFilename('a\0b.jar'), false);
});

// --- isSafeCommand ---

test('isSafeCommand: accepts normal server commands', () => {
  assert.ok(isSafeCommand('list'));
  assert.ok(isSafeCommand('op Steve'));
  assert.ok(isSafeCommand('say Hello, world!'));
  assert.ok(isSafeCommand('time set day'));
});

test('isSafeCommand: rejects empty string', () => {
  assert.equal(isSafeCommand(''), false);
});

test('isSafeCommand: rejects commands with null bytes', () => {
  assert.equal(isSafeCommand('list\x00inject'), false);
});

test('isSafeCommand: rejects excessively long commands', () => {
  assert.equal(isSafeCommand('a'.repeat(1001)), false);
});

test('isSafeCommand: rejects non-string types', () => {
  assert.equal(isSafeCommand(null), false);
  assert.equal(isSafeCommand(42), false);
});

// --- sanitizeReason ---

test('sanitizeReason: strips null bytes and newlines', () => {
  const result = sanitizeReason('bad\x00reason\nwith\rnewlines');
  assert.ok(!result.includes('\x00'));
  assert.ok(!result.includes('\n'));
  assert.ok(!result.includes('\r'));
});

test('sanitizeReason: caps at 200 characters', () => {
  const long = 'a'.repeat(300);
  assert.equal(sanitizeReason(long).length, 200);
});

test('sanitizeReason: returns default for empty/null', () => {
  assert.equal(sanitizeReason(''), 'Banned by admin');
  assert.equal(sanitizeReason(null), 'Banned by admin');
});

// --- validateConfig ---

const GOOD_CONFIG = {
  demoMode: false,
  serverPath: '/home/minecraft/server',
  launch: { executable: 'java', args: ['-Xmx8G', '@args.txt', 'nogui'] },
  rconPort: 25575,
  webPort: 3000,
  bindHost: '127.0.0.1',
};

test('validateConfig: accepts valid production config', () => {
  assert.deepEqual(validateConfig(GOOD_CONFIG), []);
});

test('validateConfig: skips validation in demo mode', () => {
  assert.deepEqual(validateConfig({ demoMode: true }), []);
});

test('validateConfig: errors on missing serverPath', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, serverPath: '' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /serverPath/);
});

test('validateConfig: errors on missing launch config', () => {
  const { launch: _, ...noLaunch } = GOOD_CONFIG;
  const errors = validateConfig(noLaunch);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /launch/);
});

test('validateConfig: errors on empty launch executable', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, launch: { executable: '', args: [] } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /executable/);
});

test('validateConfig: errors on missing launch.args array', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, launch: { executable: 'java' } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /args/);
});

test('validateConfig: errors on invalid rconPort', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, rconPort: 99999 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /rconPort/);
});

test('validateConfig: errors on non-integer rconPort', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, rconPort: 'abc' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /rconPort/);
});

test('validateConfig: errors on invalid webPort', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, webPort: 0 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /webPort/);
});

test('validateConfig: errors on invalid bindHost', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, bindHost: 'not-an-ip' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bindHost/);
});

test('validateConfig: accepts 0.0.0.0 as bindHost', () => {
  assert.deepEqual(validateConfig({ ...GOOD_CONFIG, bindHost: '0.0.0.0' }), []);
});

test('validateConfig: allows omitted optional fields', () => {
  const minimal = {
    demoMode: false,
    serverPath: '/srv/mc',
    launch: { executable: 'java', args: ['-jar', 'server.jar'] },
  };
  assert.deepEqual(validateConfig(minimal), []);
});

test('validateConfig: collects multiple errors', () => {
  const errors = validateConfig({ demoMode: false, serverPath: '', rconPort: -1 });
  assert.ok(errors.length >= 3);
});

test('validateConfig: accepts localhost as bindHost', () => {
  assert.deepEqual(validateConfig({ ...GOOD_CONFIG, bindHost: 'localhost' }), []);
});

test('validateConfig: accepts ::1 as bindHost', () => {
  assert.deepEqual(validateConfig({ ...GOOD_CONFIG, bindHost: '::1' }), []);
});

test('validateConfig: rejects whitespace-only serverPath', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, serverPath: '   ' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /serverPath/);
});

test('validateConfig: accepts edge-case valid port numbers', () => {
  assert.deepEqual(validateConfig({ ...GOOD_CONFIG, webPort: 1 }), []);
  assert.deepEqual(validateConfig({ ...GOOD_CONFIG, webPort: 65535 }), []);
  assert.deepEqual(validateConfig({ ...GOOD_CONFIG, rconPort: 1 }), []);
});

test('validateConfig: rejects float port number', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, webPort: 3000.5 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /webPort/);
});

// --- parseLaunchCommand ---

test('parseLaunchCommand: parses simple command', () => {
  const result = parseLaunchCommand('java -jar server.jar nogui');
  assert.deepEqual(result, { executable: 'java', args: ['-jar', 'server.jar', 'nogui'] });
});

test('parseLaunchCommand: handles quoted arguments', () => {
  const result = parseLaunchCommand('java "-Xmx8G" "path with spaces/server.jar"');
  assert.equal(result.executable, 'java');
  assert.deepEqual(result.args, ['"-Xmx8G"', '"path with spaces/server.jar"']);
});

test('parseLaunchCommand: handles @arg files', () => {
  const result = parseLaunchCommand('java @user_jvm_args.txt @libraries/net/forge/unix_args.txt nogui');
  assert.equal(result.executable, 'java');
  assert.ok(result.args.includes('@user_jvm_args.txt'));
});

test('parseLaunchCommand: returns null for empty string', () => {
  assert.equal(parseLaunchCommand(''), null);
  assert.equal(parseLaunchCommand('   '), null);
});

// --- migrateLaunchConfig ---

test('migrateLaunchConfig: converts startCommand to launch', () => {
  const config = { startCommand: 'java -Xmx8G -jar server.jar', serverPath: '/srv' };
  assert.equal(migrateLaunchConfig(config), true);
  assert.deepEqual(config.launch, { executable: 'java', args: ['-Xmx8G', '-jar', 'server.jar'] });
  assert.equal(config.startCommand, undefined);
});

test('migrateLaunchConfig: skips when launch already exists', () => {
  const config = { launch: { executable: 'java', args: [] }, startCommand: 'old' };
  assert.equal(migrateLaunchConfig(config), false);
});

test('migrateLaunchConfig: skips when no startCommand', () => {
  const config = { serverPath: '/srv' };
  assert.equal(migrateLaunchConfig(config), false);
});

// --- launchToString ---

test('launchToString: renders command preview', () => {
  const result = launchToString({ executable: 'java', args: ['-Xmx8G', '-jar', 'server.jar'] });
  assert.equal(result, 'java -Xmx8G -jar server.jar');
});

test('launchToString: quotes args with spaces', () => {
  const result = launchToString({ executable: 'java', args: ['path with spaces/file.jar'] });
  assert.equal(result, 'java "path with spaces/file.jar"');
});

test('launchToString: returns empty string for null/missing', () => {
  assert.equal(launchToString(null), '');
  assert.equal(launchToString({}), '');
});

// --- validateConfig: authorization ---

test('validateConfig: authorization — valid permissionPolicy values produce no errors', () => {
  for (const policy of ['isolated', 'inherit-panel', 'panel-ceiling']) {
    const errors = validateConfig({ ...GOOD_CONFIG, authorization: { permissionPolicy: policy } });
    assert.deepEqual(errors, [], `expected no errors for permissionPolicy "${policy}"`);
  }
});

test('validateConfig: authorization — invalid permissionPolicy reports error', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, authorization: { permissionPolicy: 'bogus' } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /permissionPolicy/);
});

test('validateConfig: authorization — valid opLevelMapping with valid role names produces no errors', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    authorization: {
      opLevelMapping: { 0: 'viewer', 1: 'operator', 2: 'moderator', 3: 'admin', 4: 'owner' },
    },
  });
  assert.deepEqual(errors, []);
});

test('validateConfig: authorization — opLevelMapping with null values accepted', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    authorization: {
      opLevelMapping: { 0: null, 1: null, 2: 'admin' },
    },
  });
  assert.deepEqual(errors, []);
});

test('validateConfig: authorization — opLevelMapping with invalid role name reports error', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    authorization: {
      opLevelMapping: { 0: 'viewer', 1: 'superadmin' },
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /opLevelMapping\[1\]/);
});

test('validateConfig: authorization — valid discordRoleMapping produces no errors', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    authorization: {
      discordRoleMapping: { 123456789: 'admin', 987654321: 'viewer' },
    },
  });
  assert.deepEqual(errors, []);
});

test('validateConfig: authorization — discordRoleMapping with invalid role name reports error', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    authorization: {
      discordRoleMapping: { 123456789: 'admin', 555: 'megaadmin' },
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /discordRoleMapping\[555\]/);
});

test('validateConfig: authorization — multiple errors collected at once', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    authorization: {
      permissionPolicy: 'invalid-policy',
      opLevelMapping: { 0: 'fake-role' },
      discordRoleMapping: { 999: 'also-fake' },
    },
  });
  assert.equal(errors.length, 3);
  assert.match(errors[0], /permissionPolicy/);
  assert.match(errors[1], /opLevelMapping/);
  assert.match(errors[2], /discordRoleMapping/);
});

test('validateConfig: authorization — empty authorization object produces no errors', () => {
  const errors = validateConfig({ ...GOOD_CONFIG, authorization: {} });
  assert.deepEqual(errors, []);
});

test('validateConfig: authorization — no authorization key produces no errors', () => {
  const { authorization: _, ...noAuth } = GOOD_CONFIG;
  const errors = validateConfig(noAuth);
  assert.deepEqual(errors, []);
});

// --- validateConfig: capabilityOverrides ---

test('validateConfig: valid capabilityOverrides produces no errors', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    authorization: {
      capabilityOverrides: {
        admin: { remove: ['server.delete_backup'] },
        viewer: { add: ['server.start'] },
      },
    },
  });
  assert.deepEqual(errors, []);
});

test('validateConfig: capabilityOverrides with unknown role reports error', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    authorization: { capabilityOverrides: { superadmin: { add: ['panel.view'] } } },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /capabilityOverrides.*superadmin/);
});

test('validateConfig: capabilityOverrides with unknown capability reports error', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    authorization: { capabilityOverrides: { admin: { remove: ['nonexistent.cap'] } } },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /capabilityOverrides.*nonexistent\.cap/);
});

// --- validateConfig: environments structure ---

test('validateConfig: accepts valid environments config', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    environments: {
      production: {
        name: 'Production',
        serverPath: '/home/minecraft/server',
        launch: { executable: 'java', args: ['-Xmx8G'] },
      },
    },
    activeEnvironment: 'production',
  });
  assert.deepEqual(errors, []);
});

test('validateConfig: rejects empty environments object', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    environments: {},
    activeEnvironment: 'production',
  });
  assert.ok(errors.some((e) => e.includes('at least one environment')));
});

test('validateConfig: rejects activeEnvironment pointing to nonexistent env', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    environments: {
      production: {
        name: 'Production',
        serverPath: '/home/minecraft/server',
        launch: { executable: 'java', args: [] },
      },
    },
    activeEnvironment: 'staging',
  });
  assert.ok(errors.some((e) => e.includes('staging')));
});

test('validateConfig: rejects invalid environment ID', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    environments: {
      'INVALID ID!': {
        name: 'Bad',
        serverPath: '/test',
        launch: { executable: 'java', args: [] },
      },
    },
    activeEnvironment: 'INVALID ID!',
  });
  assert.ok(errors.some((e) => e.includes('INVALID ID!')));
});

test('validateConfig: reports per-environment validation errors', () => {
  const errors = validateConfig({
    ...GOOD_CONFIG,
    environments: {
      test: {
        name: 'Test',
        serverPath: '', // invalid: empty
        launch: { executable: 'java', args: [] },
      },
    },
    activeEnvironment: 'test',
  });
  assert.ok(errors.some((e) => e.includes('test') && e.includes('serverPath')));
});
