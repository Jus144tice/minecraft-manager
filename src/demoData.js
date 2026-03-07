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
  { uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'Steve',           level: 4, bypassesPlayerLimit: true },
  { uuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', name: 'Alex',            level: 3, bypassesPlayerLimit: false },
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
    { uuid: 'f6a7b8c9-d0e1-2345-fabc-456789012345', name: 'Griefer99',   source: 'Steve',   reason: 'Griefing spawn area', created: '2025-12-01T14:22:00Z', expires: 'forever' },
    { uuid: 'a7b8c9d0-e1f2-3456-abcd-567890123456', name: 'SpamAccount', source: 'Manager', reason: 'Chat spam / bot',      created: '2026-01-15T09:10:00Z', expires: 'forever' },
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

// --- Helpers ---
// cdn(projectId) returns the Modrinth CDN icon URL for a known project.
const cdn = id => `https://cdn.modrinth.com/data/${id}/icon.png`;

// M builds an installed mod entry. projectId (optional) is the Modrinth project ID,
// used to fetch the real icon from the CDN.
const M = (filename, size, enabled, title, desc, clientSide, serverSide, version, slug, projectId = null) => ({
  filename, size, enabled,
  modrinthData: {
    projectTitle: title,
    projectDescription: desc,
    clientSide, serverSide,
    versionNumber: version,
    projectSlug: slug,
    iconUrl: projectId ? cdn(projectId) : null,
  },
});

// --- Installed mods (server-compatible Forge 1.20.1 mods only) ---
// Project IDs sourced from Modrinth; used for CDN icon URLs.
export const DEMO_MODS = [
  M('jei-1.20.1-forge-15.3.0.4.jar',          1_241_800, true,  'Just Enough Items',       'A recipe and item viewing mod.',                          'required',    'optional',    '15.3.0.4',   'jei',                'u6dRKJwZ'),
  M('appliedenergistics2-15.2.1.jar',          7_483_200, true,  'Applied Energistics 2',   'A mod about Matter, Energy, and using them.',             'required',    'required',    '15.2.1',     'ae2',                'XxWD5pD3'),
  M('create-1.20.1-0.5.1.f.jar',             11_204_100, true,  'Create',                  'Aesthetic tech and automation using rotational force.',   'required',    'required',    '0.5.1.f',    'create',             'LNytIlws'),
  M('thermal_expansion-1.20.1-10.6.0.jar',    4_921_500, true,  'Thermal Expansion',       'Expansion of the Thermal Series.',                        'required',    'required',    '10.6.0',     'thermal-expansion',  'LLoGQIHb'),
  M('Mekanism-1.20.1-10.4.7.19.jar',         14_832_700, true,  'Mekanism',                'High-tech machinery and tools.',                          'required',    'required',    '10.4.7.19',  'mekanism',           'bWcHCo3h'),
  M('Botania-1.20.1-445.jar',                  6_341_000, true,  'Botania',                 'A tech mod themed around natural magic.',                 'required',    'required',    '445',        'botania',            '3YsQxDLY'),
  M('immersiveengineering-1.20.1-10.1.0.jar',  9_128_300, true,  'Immersive Engineering',   'A retro-futuristic tech mod with multiblocks.',           'required',    'required',    '10.1.0',     'immersive-engineering','SSZIhh21'),
  M('TConstruct-1.20.1-3.8.4.272.jar',         5_673_400, true,  "Tinkers' Construct",      'Tool and weapon crafting with materials.',                'required',    'required',    '3.8.4.272',  'tinkers-construct',  'Ew0lFCBT'),
  M('StorageDrawers-1.20.1-12.0.2.jar',        1_892_600, true,  'Storage Drawers',         'Multi-drawer storage blocks.',                           'required',    'required',    '12.0.2',     'storage-drawers',    'HHc9OBmQ'),
  M('ironchest-1.20.1-14.4.4.jar',               734_900, true,  'Iron Chests',             'Bigger and better chests.',                              'required',    'required',    '14.4.4',     'iron-chests',        'vCOjNHwj'),
  M('Waystones-1.20.1-forge-14.1.3.jar',       1_243_100, true,  'Waystones',               'Teleportation waystone blocks.',                         'required',    'required',    '14.1.3',     'waystones',          'LOpKHB2A'),
  M('farmersdelight-1.20.1-1.2.3.jar',         2_134_600, true,  "Farmer's Delight",        'Expands farming and cooking.',                           'required',    'required',    '1.2.3',      'farmers-delight',    'R2OftAxM'),
  M('alexsmobs-1.22.7.jar',                    8_942_300, true,  "Alex's Mobs",             'Adds many unique mobs to the game.',                     'required',    'required',    '1.22.7',     'alexs-mobs',         'bHH9uBjy'),
  M('biomesoplenty-1.20.1-18.0.0.596.jar',     5_218_400, true,  "Biomes O' Plenty",        'Adds a ton of new biomes.',                              'required',    'required',    '18.0.0.596', 'biomes-o-plenty',    'bahp5X2Z'),
  M('Quark-4.0-460.jar',                       4_103_700, true,  'Quark',                   'Small tweaks and improvements to vanilla.',              'required',    'required',    '4.0-460',    'quark',              'qvIfYCYJ'),
  M('supplementaries-1.20.1-2.8.14.jar',       3_847_200, true,  'Supplementaries',         'Decorative blocks and items.',                           'required',    'required',    '2.8.14',     'supplementaries',    'xGpgrBLS'),
  M('enderstorage-1.20.1-2.8.0.172.jar',         612_800, true,  'EnderStorage',            'Wireless storage using ender chests.',                   'required',    'required',    '2.8.0.172',  'ender-storage',       null),
  M('lootr-0.7.35.80.jar',                       389_400, true,  'Lootr',                   'Unique loot for each player in chests.',                 'unsupported', 'required',    '0.7.35.80',  'lootr',              'jtR4KmQh'),
  M('spark-1.10.73-forge.jar',                   923_600, true,  'spark',                   'Performance profiler for the server.',                   'optional',    'required',    '1.10.73',    'spark',              'Wnxd13zP'),
  M('corail_tombstone-1.20.1-8.6.7.jar',       1_673_100, true,  'Corail Tombstone',        'Collects your items in a grave when you die.',          'required',    'required',    '8.6.7',      'corail-tombstone',   'EIjPCBLY'),
  // Disabled mods
  M('configured-2.2.3-1.20.1.jar',              241_100, false, 'Configured',              'In-game mod config editor.',                             'optional',    'optional',    '2.2.3',      'configured',          null),
  M('ftb-chunks-forge-2001.0.7.jar',           1_834_200, false, 'FTB Chunks',              'Chunk claiming and team map system.',                    'required',    'required',    '2001.0.7',   'ftb-chunks',          null),
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

// --- Paginated browse list shown by default in the Browse Modrinth tab ---
const B = (project_id, slug, title, description, author, client_side, server_side, downloads, follows, categories) =>
  ({ project_id, slug, title, description, author, client_side, server_side, downloads, follows,
     icon_url: cdn(project_id), versions: ['1.20.1', '1.20'], categories });

export const DEMO_BROWSE_RESULTS = {
  hits: [
    B('u6dRKJwZ', 'jei',                    'Just Enough Items (JEI)',         'View all items and recipes. Built from the ground up for stability and performance.',                                  'mezz',          'required',    'optional',  87_543_219, 12_847, ['forge','utility']),
    B('LNytIlws', 'create',                  'Create',                          'Aesthetic tech and automation using rotational force. Build elaborate contraptions and automated factories.',           'simibubi',      'required',    'required',  62_384_001, 28_441, ['forge','technology']),
    B('LOpKHB2A', 'waystones',               'Waystones',                       'Fast travel via waystone blocks. Place stones in your world and teleport between them.',                               'BlayTheNinth',  'required',    'required',  58_221_093, 8_632,  ['forge','utility']),
    B('HHc9OBmQ', 'storage-drawers',         'Storage Drawers',                 'Compact, stackable drawer storage blocks with easy visual access to your item counts.',                                'jaquadro',      'required',    'required',  52_174_839, 7_219,  ['forge','storage']),
    B('WIi6ssHi', 'sophisticated-backpacks', 'Sophisticated Backpacks',         'Highly configurable backpacks with upgrade slots for sorting, refilling, and auto-picking.',                          'P3pp3rF1y',     'required',    'required',  47_832_441, 9_105,  ['forge','utility']),
    B('XxWD5pD3', 'ae2',                     'Applied Energistics 2',           'A digital storage and autocrafting network built around Matter, Energy, and using them to their fullest potential.',  'AlgorithmX2',   'required',    'required',  45_993_102, 10_388, ['forge','technology']),
    B('LLoGQIHb', 'thermal-expansion',       'Thermal Expansion',               'Expansion of the Thermal Series — machines, dynamos, and tools centered around Redstone Flux.',                      'TeamCoFH',      'required',    'required',  44_217_650, 6_541,  ['forge','technology']),
    B('vCOjNHwj', 'iron-chests',             'Iron Chests',                     'Adds larger, tiered chests (iron through crystal) with more storage slots than vanilla chests.',                     'ProgWML6',      'required',    'required',  43_108_774, 5_933,  ['forge','storage']),
    B('bWcHCo3h', 'mekanism',                'Mekanism',                        'Advanced and highly configurable machines and tools. Ore processing, energy generation, and more.',                   'bradyaidanc',   'required',    'required',  41_884_320, 9_876,  ['forge','technology']),
    B('3YsQxDLY', 'botania',                 'Botania',                         'A tech mod themed around natural magic. Harness mana from flowers, craft powerful equipment, fight boss challenges.', 'Vazkii',        'required',    'required',  40_223_851, 11_204, ['forge','magic']),
    B('R2OftAxM', 'farmers-delight',         "Farmer's Delight",                'Expands farming with new crops, cooking, and food mechanics. Adds knives, cutting boards, and cooking pots.',        'vectorwing',    'required',    'required',  38_441_276, 8_003,  ['forge','food']),
    B('bHH9uBjy', 'alexs-mobs',              "Alex's Mobs",                     'Adds over 80 new mobs to the game, each with unique behaviours, loot, and interactions.',                            'sbom_4',        'required',    'required',  36_778_932, 10_541, ['forge','mobs']),
    B('Ew0lFCBT', 'tinkers-construct',       "Tinkers' Construct",              'Build custom tools and weapons from materials like bone, cobalt, and manyullyn. Each material has unique traits.',   'boni',          'required',    'required',  35_992_410, 9_887,  ['forge','tools']),
    B('qvIfYCYJ', 'quark',                   'Quark',                           'Small additions and improvements to vanilla gameplay — hundreds of toggleable tweaks and features.',                  'Vazkii',        'required',    'required',  34_551_033, 8_212,  ['forge','utility']),
    B('bahp5X2Z', 'biomes-o-plenty',         "Biomes O' Plenty",                'Adds 80+ new biomes to explore with unique terrain, plants, and building blocks.',                                   'Forstride',     'required',    'required',  33_284_901, 7_654,  ['forge','world-generation']),
    B('SSZIhh21', 'immersive-engineering',   'Immersive Engineering',           'A retro-futuristic power and automation mod with multiblock machines, wires, and conveyor belts.',                   'BluSunrize',    'required',    'required',  31_108_441, 8_003,  ['forge','technology']),
    B('xGpgrBLS', 'supplementaries',         'Supplementaries',                 'Many decorative blocks and interactive gadgets: signposts, bomb flowers, blackboards, and more.',                    'MehVahdJukaar', 'required',    'required',  28_774_320, 6_441,  ['forge','decoration']),
    B('jtR4KmQh', 'lootr',                   'Lootr',                           'Each player gets their own loot from chests — no more racing to open chests before other players.',                  'Noobanidus',    'unsupported', 'required',  24_551_033, 5_107,  ['forge','utility']),
    B('EIjPCBLY', 'corail-tombstone',        'Corail Tombstone',                'Stores your items in a grave when you die. Compatible with most mods and fully configurable.',                       'Corail31',      'required',    'required',  22_338_910, 4_882,  ['forge','utility']),
    B('Wnxd13zP', 'spark',                   'spark',                           'A performance profiler for Minecraft servers. Identify lag sources with detailed reports.',                          'lucko',         'optional',    'required',  19_774_220, 5_661,  ['forge','utility']),
  ],
  total_hits: 20,
  offset: 0,
  limit: 20,
};
