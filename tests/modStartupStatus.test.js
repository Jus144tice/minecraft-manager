// Tests for src/modStartupStatus.js — Forge log parsing and mod status tracking.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModStartupParser } from '../src/modStartupStatus.js';

let parser;

beforeEach(() => {
  parser = new ModStartupParser();
  parser.reset();
  // Set up a test mod ID map (after reset so buffered lines can be replayed)
  parser.setModIdMap(
    new Map([
      ['voicechat', 'voicechat-1.20.1-2.6.12.jar'],
      ['create', 'create-1.20.1-0.5.1.f.jar'],
      ['quark', 'quark-1.20.1-4.0-460.jar'],
      ['quark-zeta', 'quark-1.20.1-4.0-460.jar'],
      ['supplementaries', 'supplementaries-1.20-3.1.42.jar'],
      ['overweight_farming', 'overweight_farming-1.20.1-1.2.jar'],
      ['railways', 'railways-1.20.1-1.6.13.jar'],
      ['create deco', 'create-deco-1.20.1-2.0.2.jar'],
    ]),
  );
});

test('parseLine returns null before reset', () => {
  const p = new ModStartupParser();
  const result = p.parseLine('[00:00:00] [main/INFO] [voicechat/]: hello');
  assert.equal(result, null);
});

test('parseLine tracks INFO as loaded', () => {
  const result = parser.parseLine(
    '[00:06:27] [modloading-worker-0/INFO] [voicechat/]: [voicechat] Compatibility version 20',
  );
  assert.ok(result);
  assert.equal(result.type, 'status');
  assert.equal(result.filename, 'voicechat-1.20.1-2.6.12.jar');
  assert.equal(result.status, 'loaded');
});

test('parseLine tracks WARN as warning', () => {
  const result = parser.parseLine('[00:06:28] [main/WARN] [quark/WP]: Something is not quite right');
  assert.ok(result);
  assert.equal(result.type, 'status');
  assert.equal(result.filename, 'quark-1.20.1-4.0-460.jar');
  assert.equal(result.status, 'warning');
  assert.equal(result.message.level, 'WARN');
  assert.equal(result.message.text, 'Something is not quite right');
});

test('parseLine tracks ERROR as error', () => {
  const result = parser.parseLine('[00:06:39] [Worker-Main-1/ERROR] [create/]: Something broke badly');
  assert.ok(result);
  assert.equal(result.status, 'error');
  assert.equal(result.filename, 'create-1.20.1-0.5.1.f.jar');
});

test('status only escalates, never downgrades', () => {
  parser.parseLine('[00:06:27] [main/ERROR] [voicechat/]: an error');
  parser.parseLine('[00:06:28] [main/WARN] [voicechat/]: a warning');
  parser.parseLine('[00:06:29] [main/INFO] [voicechat/]: loaded fine');

  const status = parser.getStatusForFile('voicechat-1.20.1-2.6.12.jar');
  assert.equal(status.status, 'error'); // stays at error, not downgraded
});

test('stack trace lines are collected', () => {
  parser.parseLine('[00:06:28] [main/WARN] [voicechat/]: Failed to process');
  parser.parseLine('com.google.gson.JsonSyntaxException: bad json');
  parser.parseLine('\tat com.example.Foo.bar(Foo.java:42)');
  parser.parseLine('\tat com.example.Baz.run(Baz.java:10)');
  parser.parseLine('[00:06:29] [main/INFO] [create/]: Create loaded'); // ends stack trace

  const status = parser.getStatusForFile('voicechat-1.20.1-2.6.12.jar');
  assert.equal(status.messages.length, 1);
  assert.ok(status.messages[0].stackTrace);
  assert.equal(status.messages[0].stackTrace.length, 3);
});

test('finalize marks unmapped mods as loaded', () => {
  // Only voicechat appeared in logs
  parser.parseLine('[00:06:27] [modloading-worker-0/INFO] [voicechat/]: loaded');
  parser.finalize();

  // voicechat was explicitly loaded
  assert.equal(parser.getStatusForFile('voicechat-1.20.1-2.6.12.jar').status, 'loaded');
  // create never appeared in logs but should be marked loaded after finalize
  assert.equal(parser.getStatusForFile('create-1.20.1-0.5.1.f.jar').status, 'loaded');
});

test('Done pattern triggers complete event', () => {
  const result = parser.parseLine('[00:07:15] [Server thread/INFO] [minecraft/DedicatedServer]: Done (48.234s)!');
  assert.ok(result);
  assert.equal(result.type, 'complete');
});

test('critical failure detected from LoadingFailedException', () => {
  const result = parser.parseLine(
    '[00:06:05] [main/ERROR] [minecraft/Main]: quark (quark) has failed to load correctly',
  );
  // Note: "minecraft" is in SYSTEM_SOURCES but critical pattern is checked first
  assert.ok(result);
  assert.equal(result.status, 'critical');
  assert.equal(result.filename, 'quark-1.20.1-4.0-460.jar');
});

test('system sources are ignored for normal lines', () => {
  const result = parser.parseLine('[00:06:30] [main/INFO] [minecraft/DedicatedServer]: Starting server');
  assert.equal(result, null);
});

test('getStatuses returns all tracked mods', () => {
  parser.parseLine('[00:06:27] [main/INFO] [voicechat/]: loaded');
  parser.parseLine('[00:06:28] [main/WARN] [create/]: warning msg');

  const statuses = parser.getStatuses();
  assert.ok(statuses['voicechat-1.20.1-2.6.12.jar']);
  assert.ok(statuses['create-1.20.1-0.5.1.f.jar']);
  assert.equal(statuses['voicechat-1.20.1-2.6.12.jar'].status, 'loaded');
  assert.equal(statuses['create-1.20.1-0.5.1.f.jar'].status, 'warning');
});

test('reset clears all state', () => {
  parser.parseLine('[00:06:27] [main/INFO] [voicechat/]: loaded');
  parser.reset();
  assert.equal(Object.keys(parser.getStatuses()).length, 0);
});

test('multiple messages for same mod are collected', () => {
  parser.parseLine('[00:06:28] [main/WARN] [create/]: first warning');
  parser.parseLine('[00:06:29] [main/ERROR] [create/]: then an error');

  const status = parser.getStatusForFile('create-1.20.1-0.5.1.f.jar');
  assert.equal(status.status, 'error');
  assert.equal(status.messages.length, 2);
});

test('fuzzy matching maps source to mod ID', () => {
  // Source "quark-zeta" should match directly (registered as key)
  const result = parser.parseLine('[00:06:28] [main/WARN] [quark-zeta/]: config issue');
  assert.ok(result);
  assert.equal(result.filename, 'quark-1.20.1-4.0-460.jar');
});

test('display name matching works', () => {
  const result = parser.parseLine('[00:06:28] [main/INFO] [Create Deco/]: Registering items');
  assert.ok(result);
  assert.equal(result.filename, 'create-deco-1.20.1-2.0.2.jar');
});

test('class path last segment resolves to mod', () => {
  // "co.si.cr.Create" -> last segment "Create" -> matches "create"
  const p = new ModStartupParser();
  p.reset();
  p.setModIdMap(new Map([['create', 'create-1.20.1-0.5.1.f.jar']]));
  const result = p.parseLine('[00:06:27] [main/INFO] [co.si.cr.Create/]: Create initializing');
  assert.ok(result);
  assert.equal(result.filename, 'create-1.20.1-0.5.1.f.jar');
});

test('buffering replays lines when map becomes available', () => {
  const p = new ModStartupParser();
  p.reset(); // started but no map yet

  // These lines are buffered (map not ready)
  p.parseLine('[00:06:27] [main/INFO] [voicechat/]: loaded');
  p.parseLine('[00:06:28] [main/WARN] [create/]: warning msg');

  // Now set the map — buffered lines should replay
  const events = p.setModIdMap(
    new Map([
      ['voicechat', 'vc.jar'],
      ['create', 'create.jar'],
    ]),
  );

  assert.ok(events.length >= 2);
  assert.equal(p.getStatusForFile('vc.jar').status, 'loaded');
  assert.equal(p.getStatusForFile('create.jar').status, 'warning');
});

test('system sources are ignored', () => {
  const result = parser.parseLine('[00:06:30] [main/INFO] [ne.mi.co.Co.placebo/COREMODLOG]: Patching something');
  assert.equal(result, null);
});

test('railways direct match works', () => {
  const result = parser.parseLine('[00:06:29] [modloading-worker-0/INFO] [Railways/]: Steam n Rails initializing');
  assert.ok(result);
  assert.equal(result.filename, 'railways-1.20.1-1.6.13.jar');
});

test('system-sourced ERROR with namespace ref is warning (mod loaded, data issue)', () => {
  const result = parser.parseLine(
    "[00:06:39] [Worker-Main-1/ERROR] [minecraft/TagLoader]: Couldn't load tag create:crushed_ores",
  );
  assert.ok(result);
  assert.equal(result.filename, 'create-1.20.1-0.5.1.f.jar');
  assert.equal(result.status, 'warning'); // system-sourced = warning, not error
});

test('system-sourced WARN with mixin ref attributes to correct mod', () => {
  // "quark" is registered in the map but source is "mixin" (system)
  const p = new ModStartupParser();
  p.reset();
  p.setModIdMap(new Map([['quark', 'quark.jar']]));
  const result = p.parseLine("[00:06:28] [main/WARN] [mixin/]: Reference map 'quark.refmap.json' could not be read");
  assert.ok(result);
  assert.equal(result.filename, 'quark.jar');
  assert.equal(result.status, 'warning');
});

test('system-sourced Missing data pack attributes to correct mod', () => {
  const result = parser.parseLine('[00:06:32] [main/WARN] [minecraft/MinecraftServer]: Missing data pack mod:create');
  assert.ok(result);
  assert.equal(result.filename, 'create-1.20.1-0.5.1.f.jar');
  assert.equal(result.status, 'warning');
});

test('mixin config error attributes to correct mod', () => {
  // Add furniture to the map
  const p = new ModStartupParser();
  p.reset();
  p.setModIdMap(new Map([['furniture', 'furniture-1.0.jar']]));
  const result = p.parseLine(
    '[09:35:10] [main/ERROR] [mixin/]: Mixin config furniture-common.mixins.json does not specify "minVersion" property',
  );
  assert.ok(result);
  assert.equal(result.filename, 'furniture-1.0.jar');
  assert.equal(result.status, 'warning');
});

test('mixin refmap warning attributes to correct mod', () => {
  const p = new ModStartupParser();
  p.reset();
  p.setModIdMap(new Map([['createframed', 'createframed-1.0.jar']]));
  const result = p.parseLine(
    "[09:35:11] [main/WARN] [mixin/]: Reference map 'createframed.refmap.json' for createframed.mixins.json could not be read",
  );
  assert.ok(result);
  assert.equal(result.filename, 'createframed-1.0.jar');
});

test('mixin target not found attributes to correct mod', () => {
  const p = new ModStartupParser();
  p.reset();
  p.setModIdMap(new Map([['relics', 'relics-1.0.jar']]));
  const result = p.parseLine(
    '[09:35:13] [main/WARN] [mixin/]: @Mixin target net.minecraft.client.gui.screens.Screen was not found relics.mixins.json:ScreenMixin',
  );
  assert.ok(result);
  assert.equal(result.filename, 'relics-1.0.jar');
});

test('config file correction attributes to correct mod', () => {
  const p = new ModStartupParser();
  p.reset();
  p.setModIdMap(new Map([['sliceanddice', 'sliceanddice-1.0.jar']]));
  const result = p.parseLine(
    '[09:35:52] [main/WARN] [ne.mi.co.ForgeConfigSpec/CORE]: Configuration file /home/minecraft/server/config/sliceanddice-common.toml is not correct. Correcting',
  );
  assert.ok(result);
  assert.equal(result.filename, 'sliceanddice-1.0.jar');
});

test('registry entry warning attributes to correct mod', () => {
  const result = parser.parseLine(
    '[09:35:49] [main/WARN] [de.ar.re.re.fo.RegistrarManagerImpl/]: Registry entry listened Registry Entry [minecraft:entity_type / create:contraption] was not realized!',
  );
  assert.ok(result);
  assert.equal(result.filename, 'create-1.20.1-0.5.1.f.jar');
});

test('version check failure attributes to last checked mod', () => {
  const p = new ModStartupParser();
  p.reset();
  p.setModIdMap(new Map([['framework', 'framework-1.0.jar']]));
  // First line sets the last version check mod
  p.parseLine(
    '[09:35:53] [Forge Version Check/INFO] [ne.mi.fm.VersionChecker/]: [framework] Starting version check at https://example.com',
  );
  // Failure line should be attributed to framework
  const result = p.parseLine(
    '[09:35:53] [Forge Version Check/WARN] [ne.mi.fm.VersionChecker/]: Failed to process update information',
  );
  assert.ok(result);
  assert.equal(result.filename, 'framework-1.0.jar');
  assert.equal(result.status, 'warning');
});

test('version check failure captures stack trace', () => {
  const p = new ModStartupParser();
  p.reset();
  p.setModIdMap(new Map([['framework', 'framework-1.0.jar']]));
  p.parseLine(
    '[09:45:55] [Forge Version Check/INFO] [ne.mi.fm.VersionChecker/]: [framework] Starting version check at https://example.com',
  );
  p.parseLine('[09:45:56] [Forge Version Check/WARN] [ne.mi.fm.VersionChecker/]: Failed to process update information');
  p.parseLine(
    'com.google.gson.JsonSyntaxException: java.lang.IllegalStateException: Expected BEGIN_OBJECT but was STRING',
  );
  p.parseLine('\tat com.google.gson.Gson.fromJson(Gson.java:1226) ~[gson-2.10.jar%2372!/:?] {}');
  p.parseLine('\tat com.google.gson.Gson.fromJson(Gson.java:1124) ~[gson-2.10.jar%2372!/:?] {}');
  p.parseLine('Caused by: java.lang.IllegalStateException: Expected BEGIN_OBJECT but was STRING');
  p.parseLine('\tat com.google.gson.stream.JsonReader.beginObject(JsonReader.java:393) ~[gson-2.10.jar%2372!/:?] {}');
  p.parseLine('\t... 6 more');
  // Next structured log line ends the stack trace
  p.parseLine(
    '[09:45:56] [Forge Version Check/INFO] [ne.mi.fm.VersionChecker/]: [toms_storage] Starting version check',
  );

  const status = p.getStatusForFile('framework-1.0.jar');
  assert.ok(status, 'framework should have a status entry');
  assert.equal(status.messages.length, 1);
  assert.ok(status.messages[0].stackTrace, 'stack trace should be captured');
  assert.ok(
    status.messages[0].stackTrace.length >= 5,
    `expected >= 5 stack lines, got ${status.messages[0].stackTrace?.length}`,
  );
});

test('system-sourced tag error captures stack trace', () => {
  // Simulate: tag loading error with stack trace from minecraft source
  parser.parseLine(
    "[09:46:06] [Worker-Main-1/ERROR] [minecraft/TagLoader]: Couldn't load tag create:crushed_ores as it is missing following references",
  );
  parser.parseLine('\tminecraft:crushed_calorite_ore (from create_ad_astra_compat-forge-1.20.1-1.0.0.jar)');
  parser.parseLine('\tminecraft:crushed_desh_ore (from create_ad_astra_compat-forge-1.20.1-1.0.0.jar)');
  parser.parseLine('[09:46:07] [main/INFO] [create/]: something else');

  const status = parser.getStatusForFile('create-1.20.1-0.5.1.f.jar');
  assert.ok(status);
  // Should have a warning message with the tag lines as stack trace
  const tagMsg = status.messages.find((m) => m.text.includes('crushed_ores'));
  assert.ok(tagMsg, 'should have the tag loading message');
  assert.ok(tagMsg.stackTrace, 'should have stack trace lines');
  assert.equal(tagMsg.stackTrace.length, 2);
});

test('ForgeHooks loot table error captures stack trace for the mod', () => {
  parser.parseLine(
    "[09:46:40] [Worker-Main-4/ERROR] [ne.mi.co.ForgeHooks/]: Couldn't parse element loot_tables:overweight_farming:blocks/overweight_ginger_block",
  );
  parser.parseLine(
    "com.google.gson.JsonSyntaxException: Expected name to be an item, was unknown string 'snowyspirit:ginger'",
  );
  parser.parseLine('\tat net.minecraft.util.GsonHelper.m_13866_(GsonHelper.java:145) ~[server.jar%23413!/:?]');
  parser.parseLine('\tat java.util.Optional.orElseThrow(Optional.java:403) ~[?:?]');
  parser.parseLine('[09:46:41] [main/INFO] [create/]: something else'); // ends stack trace

  const status = parser.getStatusForFile('overweight_farming-1.20.1-1.2.jar');
  assert.ok(status, 'overweight_farming should have a status');
  assert.equal(status.status, 'warning');
  const msg = status.messages.find((m) => m.text.includes('overweight_ginger_block'));
  assert.ok(msg, 'should have the loot table message');
  assert.ok(msg.stackTrace, 'stack trace should be captured');
  assert.ok(msg.stackTrace.length >= 3, `expected >= 3 stack lines, got ${msg.stackTrace?.length}`);
});

test('LootModifierManager error with stack trace attributes to mod via namespace', () => {
  const p = new ModStartupParser();
  p.reset();
  p.setModIdMap(new Map([['nethersdelight', 'nethersdelight-1.0.jar']]));
  p.parseLine(
    "[09:46:12] [main/WARN] [ne.mi.co.lo.LootModifierManager/]: Could not decode GlobalLootModifier with json id nethersdelight:chopping_leather - error: Unknown type 'minecraft:alternatives'",
  );
  p.parseLine('[09:46:12] [main/WARN] [ne.mi.co.lo.LootModifierManager/]: Unable to decode loot conditions');
  p.parseLine("com.google.gson.JsonSyntaxException: Unknown type 'minecraft:alternatives'");
  p.parseLine(
    '\tat net.minecraft.world.level.storage.loot.GsonAdapterFactory$JsonAdapter.deserialize(GsonAdapterFactory.java:99)',
  );
  p.parseLine('\tat com.google.gson.internal.bind.TreeTypeAdapter.read(TreeTypeAdapter.java:76)');
  p.parseLine('[09:46:12] [main/INFO] [create/]: next log line');

  const status = p.getStatusForFile('nethersdelight-1.0.jar');
  assert.ok(status, 'nethersdelight should have a status');
  assert.equal(status.status, 'warning');
  // Should have at least one message with a stack trace
  const msgWithTrace = status.messages.find((m) => m.stackTrace && m.stackTrace.length > 0);
  assert.ok(msgWithTrace, 'should have a message with stack trace');
});

test('finalize does not mark unmapped mods (missing mods.toml)', () => {
  parser.parseLine('[00:06:27] [main/INFO] [voicechat/]: loaded');
  parser.finalize();

  assert.equal(parser.getStatusForFile('voicechat-1.20.1-2.6.12.jar').status, 'loaded');
  // A mod not in the modIdMap should NOT get a status — needs investigation
  assert.equal(parser.getStatusForFile('botarium-1.20.1-2.3.4.jar'), null);
});
