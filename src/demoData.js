// Seed data for demo mode. None of this touches the real server.

export const DEMO_CONFIG_OVERLAY = {
  serverPath: '/home/minecraft/server',
  rconHost: '127.0.0.1',
  rconPort: 25575,
  minecraftVersion: '1.20.1',
  modsFolder: 'mods',
  disabledModsFolder: 'mods_disabled',
};

// --- Server status ---
export function getDemoStatus(running, uptime) {
  return {
    running,
    uptime,
    rconConnected: running,
    onlineCount: running ? 3 : 0,
    serverPath: '/home/minecraft/server',
    minecraftVersion: '1.20.1',
    demoMode: true,
  };
}

// --- Online players ---
export const DEMO_ONLINE_PLAYERS = ['Steve', 'Alex', 'CreeperSlayer99'];

// --- Operators ---
export const DEMO_OPS = [
  { uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'Steve',          level: 4, bypassesPlayerLimit: true },
  { uuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', name: 'Alex',           level: 3, bypassesPlayerLimit: false },
  { uuid: 'c3d4e5f6-a7b8-9012-cdef-123456789012', name: 'CreeperSlayer99', level: 2, bypassesPlayerLimit: false },
];

// --- Whitelist ---
export const DEMO_WHITELIST = [
  { uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'Steve' },
  { uuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', name: 'Alex' },
  { uuid: 'c3d4e5f6-a7b8-9012-cdef-123456789012', name: 'CreeperSlayer99' },
  { uuid: 'd4e5f6a7-b8c9-0123-defa-234567890123', name: 'DiamondDigger' },
  { uuid: 'e5f6a7b8-c9d0-1234-efab-345678901234', name: 'NightOwl_MC' },
];

// --- Bans ---
export const DEMO_BANS = {
  players: [
    { uuid: 'f6a7b8c9-d0e1-2345-fabc-456789012345', name: 'Griefer99',   source: 'Steve',   reason: 'Griefing spawn area',  created: '2025-12-01T14:22:00Z', expires: 'forever' },
    { uuid: 'a7b8c9d0-e1f2-3456-abcd-567890123456', name: 'SpamAccount', source: 'Manager', reason: 'Chat spam / bot',        created: '2026-01-15T09:10:00Z', expires: 'forever' },
  ],
  ips: [],
};

// --- server.properties ---
export const DEMO_PROPERTIES = {
  'enable-rcon':          'true',
  'rcon.port':            '25575',
  'rcon.password':        '(hidden in demo)',
  'white-list':           'true',
  'online-mode':          'true',
  'max-players':          '8',
  'server-port':          '25565',
  'motd':                 'A Forge Modpack Server',
  'gamemode':             'survival',
  'difficulty':           'normal',
  'level-name':           'world',
  'pvp':                  'true',
  'spawn-protection':     '16',
  'op-permission-level':  '4',
  'view-distance':        '10',
  'simulation-distance':  '8',
  'allow-flight':         'false',
  'spawn-monsters':       'true',
  'spawn-animals':        'true',
  'spawn-npcs':           'true',
  'enable-command-block': 'false',
  'level-type':           'minecraft:normal',
  'generate-structures':  'true',
  'max-world-size':       '29999984',
};

// --- Installed mods (realistic Forge modpack) ---
// clientSide / serverSide: "required" | "optional" | "unsupported"
const M = (filename, size, enabled, title, desc, clientSide, serverSide, version, slug) => ({
  filename, size, enabled,
  modrinthData: { projectTitle: title, projectDescription: desc, clientSide, serverSide, versionNumber: version, projectSlug: slug, iconUrl: null },
});

export const DEMO_MODS = [
  M('jei-1.20.1-forge-15.3.0.4.jar',          1_241_800, true,  'Just Enough Items',       'A recipe and item viewing mod.',                           'required',    'optional',    '15.3.0.4',  'jei'),
  M('journeymap-1.20.1-5.9.18-forge.jar',      3_812_400, true,  'JourneyMap',              'Real-time mapping in-game or in a browser.',               'required',    'unsupported', '5.9.18',    'journeymap'),
  M('rubidium-0.7.2-forge.jar',                1_034_200, true,  'Rubidium',                'Unofficial Forge port of the Sodium rendering engine.',    'required',    'unsupported', '0.7.2',     'rubidium'),
  M('oculus-1.20.1-1.7.0.jar',                 2_187_600, true,  'Oculus',                  'Unofficial Forge port of Iris Shaders.',                   'required',    'unsupported', '1.7.0',     'oculus'),
  M('appliedenergistics2-15.2.1.jar',          7_483_200, true,  'Applied Energistics 2',   'A mod about Matter, Energy, and using them.',              'required',    'required',    '15.2.1',    'ae2'),
  M('create-1.20.1-0.5.1.f.jar',              11_204_100, true,  'Create',                  'Aesthetic tech and automation using rotational force.',    'required',    'required',    '0.5.1.f',   'create'),
  M('thermal_expansion-1.20.1-10.6.0.jar',     4_921_500, true,  'Thermal Expansion',       'Expansion of the Thermal Series.',                         'required',    'required',    '10.6.0',    'thermal-expansion'),
  M('Mekanism-1.20.1-10.4.7.19.jar',          14_832_700, true,  'Mekanism',                'High-tech machinery and tools.',                           'required',    'required',    '10.4.7.19', 'mekanism'),
  M('Botania-1.20.1-445.jar',                  6_341_000, true,  'Botania',                 'A tech mod themed around natural magic.',                  'required',    'required',    '445',       'botania'),
  M('immersiveengineering-1.20.1-10.1.0.jar',  9_128_300, true,  'Immersive Engineering',   'A retro-futuristic tech mod with multiblocks.',            'required',    'required',    '10.1.0',    'immersive-engineering'),
  M('TConstruct-1.20.1-3.8.4.272.jar',         5_673_400, true,  "Tinkers' Construct",      'Tool and weapon crafting with materials.',                 'required',    'required',    '3.8.4.272', 'tinkers-construct'),
  M('StorageDrawers-1.20.1-12.0.2.jar',        1_892_600, true,  'Storage Drawers',         'Multi-drawer storage blocks.',                             'required',    'required',    '12.0.2',    'storage-drawers'),
  M('ironchest-1.20.1-14.4.4.jar',               734_900, true,  'Iron Chests',             'Bigger and better chests.',                                'required',    'required',    '14.4.4',    'iron-chests'),
  M('Waystones-1.20.1-forge-14.1.3.jar',       1_243_100, true,  'Waystones',               'Teleportation waystone blocks.',                          'required',    'required',    '14.1.3',    'waystones'),
  M('farmersdelight-1.20.1-1.2.3.jar',         2_134_600, true,  "Farmer's Delight",        'Expands farming and cooking.',                            'required',    'required',    '1.2.3',     'farmers-delight'),
  M('alexsmobs-1.22.7.jar',                    8_942_300, true,  "Alex's Mobs",             'Adds many unique mobs to the game.',                      'required',    'required',    '1.22.7',    'alexs-mobs'),
  M('biomesoplenty-1.20.1-18.0.0.596.jar',     5_218_400, true,  "Biomes O' Plenty",        'Adds a ton of new biomes.',                               'required',    'required',    '18.0.0.596','biomes-o-plenty'),
  M('Quark-4.0-460.jar',                       4_103_700, true,  'Quark',                   'Small tweaks and improvements to vanilla.',               'required',    'required',    '4.0-460',   'quark'),
  M('supplementaries-1.20.1-2.8.14.jar',       3_847_200, true,  'Supplementaries',         'Decorative blocks and items.',                            'required',    'required',    '2.8.14',    'supplementaries'),
  M('enderstorage-1.20.1-2.8.0.172.jar',         612_800, true,  'EnderStorage',            'Wireless storage using ender chests.',                    'required',    'required',    '2.8.0.172', 'ender-storage'),
  M('lootr-0.7.35.80.jar',                       389_400, true,  'Lootr',                   'Unique loot for each player in chests.',                  'unsupported', 'required',    '0.7.35.80', 'lootr'),
  M('spark-1.10.73-forge.jar',                   923_600, true,  'spark',                   'Performance profiler for the server.',                    'optional',    'required',    '1.10.73',   'spark'),
  M('corail_tombstone-1.20.1-8.6.7.jar',       1_673_100, true,  'Corail Tombstone',        'Collects your items in a grave when you die.',           'required',    'required',    '8.6.7',     'corail-tombstone'),
  M('mousetweaks-2.25-mc1.20.jar',               187_300, true,  'Mouse Tweaks',            'Improved mouse inventory management.',                    'required',    'unsupported', '2.25',      'mouse-tweaks'),
  // A few disabled mods
  M('xaeroworldmap-1.37.6-forge-1.20.1.jar',  2_041_500, false, "Xaero's World Map",        'A world map for Minecraft.',                             'required',    'unsupported', '1.37.6',    'xaeros-world-map'),
  M('configured-2.2.3-1.20.1.jar',              241_100, false, 'Configured',               'In-game mod config editor.',                             'required',    'unsupported', '2.2.3',     'configured'),
];

// --- Console log simulation ---
export const DEMO_STARTUP_LOGS = [
  '[00:00:00] [main/INFO] [cp.mo.mo.Launcher/MODLAUNCHER]: ModLauncher 10.0.9+10.0.9+main.dcd20a69 starting: java version 17.0.9 by Eclipse Adoptium',
  '[00:00:00] [main/INFO] [cp.mo.mo.Launcher/MODLAUNCHER]: JVM identified as Java 17 HotSpot VM by Eclipse Adoptium',
  '[00:00:01] [main/INFO] [ne.mi.fm.lo.LoadingModList/]: Forge mod loading, 204 mods to load',
  '[00:00:02] [main/INFO] [ne.mi.fm.lo.ModLoader/]: Loading mod: forge@47.3.0',
  '[00:00:02] [main/INFO] [ne.mi.fm.lo.ModLoader/]: Loading mod: minecraft@1.20.1',
  '[00:00:03] [main/INFO] [ne.mi.fm.lo.ModLoader/]: Loading mod: jei@15.3.0.4',
  '[00:00:03] [main/INFO] [ne.mi.fm.lo.ModLoader/]: Loading mod: create@0.5.1.f',
  '[00:00:04] [main/INFO] [ne.mi.fm.lo.ModLoader/]: Loading mod: mekanism@10.4.7.19',
  '[00:00:05] [main/INFO] [ne.mi.fm.lo.ModLoader/]: Loading mod: ae2@15.2.1',
  '[00:00:06] [main/INFO] [ne.mi.fm.lo.ModLoader/]: Loading mod: botania@445',
  '[00:00:07] [ForkJoinPool-1-worker-3/INFO] [ne.mi.fm.lo.ModLoader/]: Parallel mod loading: 200 mods',
  '[00:00:09] [Forge Version Check/INFO] [ne.mi.forge.VersionChecker/]: [create] Starting version check at https://maven.tterrag.com/...',
  '[00:00:12] [Worker-Main-1/INFO] [ne.mi.re.GameData/REGISTRIES]: Registering blocks for create',
  '[00:00:15] [Worker-Main-1/INFO] [ne.mi.re.GameData/REGISTRIES]: Registering items for mekanism',
  '[00:00:18] [Worker-Main-1/INFO] [ne.mi.re.GameData/REGISTRIES]: Registering entities for alexsmobs',
  '[00:00:23] [Server thread/INFO] [ne.mi.co.se.GameTestServer/]: Starting server',
  '[00:00:24] [Server thread/INFO] [minecraft/DedicatedServer]: Starting minecraft server version 1.20.1',
  '[00:00:24] [Server thread/INFO] [minecraft/DedicatedServer]: Loading properties',
  '[00:00:24] [Server thread/INFO] [minecraft/MinecraftServer]: Default game type: SURVIVAL',
  '[00:00:24] [Server thread/INFO] [minecraft/MinecraftServer]: Generating keypair',
  '[00:00:25] [Server thread/INFO] [minecraft/MinecraftServer]: Starting Minecraft server on *:25565',
  '[00:00:25] [Server thread/INFO] [minecraft/MinecraftServer]: Using epoll channel type',
  '[00:00:26] [Server thread/INFO] [ne.mi.fm.co.FMLCommonSetupEvent/]: FML Setup: loading complete',
  '[00:00:28] [Server thread/INFO] [minecraft/MinecraftServer]: Preparing level "world"',
  '[00:00:30] [Server thread/INFO] [minecraft/MinecraftServer]: Preparing start region for dimension minecraft:overworld',
  '[00:00:31] [Worker-Main-1/INFO] [minecraft/ChunkMap]: Preparing spawn area: 0%',
  '[00:00:33] [Worker-Main-1/INFO] [minecraft/ChunkMap]: Preparing spawn area: 42%',
  '[00:00:35] [Worker-Main-1/INFO] [minecraft/ChunkMap]: Preparing spawn area: 89%',
  '[00:00:37] [Server thread/INFO] [minecraft/MinecraftServer]: Time elapsed: 37224 ms',
  '[00:00:37] [Server thread/INFO] [minecraft/DedicatedServer]: Done (37.224s)! For help, type "help"',
  '[00:00:37] [Server thread/INFO] [minecraft/MinecraftServer]: Starting RCON on 0.0.0.0:25575',
  '[Manager] Server ready. RCON connected.',
];

// Periodic fake activity log lines (cycled through over time)
export const DEMO_ACTIVITY_LOGS = [
  '[Server thread/INFO] [minecraft/PlayerList]: Steve[/127.0.0.1:51234] logged in with entity id 412 at (128.5, 68.0, -204.3)',
  '[Server thread/INFO] [minecraft/MinecraftServer]: Steve joined the game',
  '[Server thread/INFO] [minecraft/MinecraftServer]: <Steve> hey guys',
  '[Server thread/INFO] [minecraft/PlayerList]: Alex[/192.168.1.5:55210] logged in with entity id 413 at (0.5, 64.0, 0.5)',
  '[Server thread/INFO] [minecraft/MinecraftServer]: Alex joined the game',
  '[Server thread/INFO] [minecraft/MinecraftServer]: <Alex> what are we building today',
  '[Server thread/INFO] [minecraft/MinecraftServer]: <Steve> working on the AE2 autocrafting setup',
  '[Server thread/INFO] [minecraft/DedicatedServer]: Saving the game (this may take a moment!)',
  '[Server thread/INFO] [minecraft/MinecraftServer]: Saved the game',
  '[Server thread/INFO] [minecraft/MinecraftServer]: <Alex> CreeperSlayer want to come help?',
  '[Server thread/INFO] [minecraft/PlayerList]: CreeperSlayer99[/192.168.1.7:60001] logged in with entity id 501 at (310.2, 72.0, 88.9)',
  '[Server thread/INFO] [minecraft/MinecraftServer]: CreeperSlayer99 joined the game',
  '[Server thread/INFO] [minecraft/MinecraftServer]: <CreeperSlayer99> omw',
  '[Server thread/WARN] [minecraft/MinecraftServer]: Can\'t keep up! Is the server overloaded? Running 2100ms or 42 ticks behind',
  '[Server thread/INFO] [minecraft/MinecraftServer]: <Steve> anybody need iron?',
  '[Server thread/INFO] [minecraft/DedicatedServer]: Saving the game (this may take a moment!)',
  '[Server thread/INFO] [minecraft/MinecraftServer]: Saved the game',
  '[Server thread/INFO] [minecraft/MinecraftServer]: CreeperSlayer99 left the game',
  '[Server thread/INFO] [minecraft/MinecraftServer]: <Alex> gg',
];
