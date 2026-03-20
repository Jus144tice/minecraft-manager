// ============================================================
// Granular RBAC Permission Engine
// ============================================================
//
// This module is the single source of truth for authorization
// in the app.  It defines:
//
//   1. CAPABILITIES — atomic permission strings
//   2. ROLES        — named presets that expand to capability sets
//   3. Resolution   — how effective permissions are computed per
//                     identity channel (panel / Discord / game)
//   4. Mappings     — configurable MC-op-level → role and
//                     Discord-role-ID → role translations
//
// Design principles:
//   • Capabilities are the true authority, never raw levels.
//   • Roles are convenience presets; every role expands to an
//     explicit, auditable set of capabilities.
//   • Each identity channel (panel session, Discord command,
//     game action) resolves permissions independently by default
//     ("isolated" policy).  Linked identities do NOT auto-inherit
//     the panel user's full permissions unless explicitly configured.
//   • Mappings are conservative defaults — MC op 4 maps to "admin",
//     NOT "owner".  Owner must be granted explicitly.
// ============================================================

// ---- Capability definitions --------------------------------

/** @type {Record<string, string>} capability key → human description */
export const CAPABILITIES = {
  // Panel
  'panel.view': 'View the web panel dashboard',
  'panel.configure': 'Edit app configuration, server.properties, and JVM args',
  'panel.manage_users': 'Manage panel user accounts and roles',
  'panel.link_identities': 'Manage identity links for other users',

  // Server lifecycle
  'server.view_status': 'View server status and metrics',
  'server.view_logs': 'View server console logs',
  'server.view_console': 'View the live console output',
  'server.send_console_command': 'Send commands via console / RCON',
  'server.start': 'Start the Minecraft server',
  'server.stop': 'Stop the Minecraft server',
  'server.restart': 'Restart the Minecraft server',
  'server.manage_files': 'Browse and manage server files',
  'server.manage_mods': 'Install, toggle, and remove mods; import modpacks',
  'server.manage_world': 'Regenerate or delete worlds',

  // Backups
  'server.view_backups': 'View the backup list',
  'server.create_backup': 'Create new backups',
  'server.restore_backup': 'Restore from a backup',
  'server.delete_backup': 'Delete backups',

  // Players
  'players.view': 'View player lists and profiles',
  'players.manage_ops': 'Add or remove server operators',
  'players.manage_whitelist': 'Add or remove whitelist entries',
  'players.manage_bans': 'Ban, unban, or kick players',

  // Chat
  'chat.broadcast': 'Broadcast messages to the server',

  // Discord
  'discord.use_commands': 'Use read-only Discord bot commands',
  'discord.use_control': 'Use server-control Discord bot commands',
  'discord.link_self': 'Link own Discord account',
  'discord.manage': 'Test Discord connection and configure integration',

  // Identity
  'identity.link_self': 'Link own Minecraft or Discord account',
  'identity.view_links': 'View all identity links',

  // Audit
  'audit.view': 'View audit logs',

  // Environments
  'environments.manage': 'Create, edit, delete, and deploy environments',
};

// ---- Role definitions --------------------------------------

/**
 * Each role is a named preset with a numeric level (for ordering /
 * display only — the level is NOT used for authorization decisions)
 * and an explicit, complete list of capabilities.
 *
 * Roles are cumulative: each level includes everything from the
 * levels below it, plus its own additions.
 */

const VIEWER_CAPS = [
  'panel.view',
  'server.view_status',
  'server.view_logs',
  'server.view_console',
  'players.view',
  'identity.link_self',
  'discord.link_self',
  'discord.use_commands',
];

const OPERATOR_CAPS = [
  ...VIEWER_CAPS,
  'server.start',
  'server.stop',
  'server.restart',
  'server.view_backups',
  'server.create_backup',
  'chat.broadcast',
  'discord.use_control',
];

const MODERATOR_CAPS = [
  ...OPERATOR_CAPS,
  'server.send_console_command',
  'players.manage_whitelist',
  'players.manage_bans',
];

const ADMIN_CAPS = [
  ...MODERATOR_CAPS,
  'panel.configure',
  'server.manage_files',
  'server.manage_mods',
  'server.restore_backup',
  'server.delete_backup',
  'players.manage_ops',
  'audit.view',
  'identity.view_links',
  'panel.link_identities',
  'discord.manage',
];

const OWNER_CAPS = [...ADMIN_CAPS, 'panel.manage_users', 'server.manage_world', 'environments.manage'];

/** @type {Record<string, { name: string, level: number, description: string, capabilities: string[] }>} */
export const ROLES = {
  viewer: {
    name: 'Viewer',
    level: 0,
    description: 'Read-only access to the panel',
    capabilities: VIEWER_CAPS,
  },
  operator: {
    name: 'Operator',
    level: 1,
    description: 'Can start/stop the server and create backups',
    capabilities: OPERATOR_CAPS,
  },
  moderator: {
    name: 'Moderator',
    level: 2,
    description: 'Can manage players and send console commands',
    capabilities: MODERATOR_CAPS,
  },
  admin: {
    name: 'Admin',
    level: 3,
    description: 'Full operational control of the server and panel configuration',
    capabilities: ADMIN_CAPS,
  },
  owner: {
    name: 'Owner',
    level: 4,
    description: 'Full control including user management and world operations',
    capabilities: OWNER_CAPS,
  },
};

/** Ordered list of role keys from lowest to highest */
export const ROLE_ORDER = ['viewer', 'operator', 'moderator', 'admin', 'owner'];

// ---- Capability resolution ---------------------------------

/** Default (immutable) Set<string> per role for fast lookups */
const _defaultCapSets = {};
for (const [key, role] of Object.entries(ROLES)) {
  _defaultCapSets[key] = new Set(role.capabilities);
}

/** Effective (overridden) Set<string> per role — rebuilt by setCapabilityOverrides() */
let _effectiveCapSets = { ..._defaultCapSets };

/** Currently active overrides (for inspection by GET /roles) */
let _activeOverrides = {};

/**
 * Apply capability overrides from config.authorization.capabilityOverrides.
 * Rebuilds the effective capability sets.  Call at startup and after config saves.
 *
 * @param {Record<string, { add?: string[], remove?: string[] }>} overrides
 */
export function setCapabilityOverrides(overrides) {
  _activeOverrides = overrides && typeof overrides === 'object' ? overrides : {};
  const rebuilt = {};
  for (const key of ROLE_ORDER) {
    const base = new Set(_defaultCapSets[key]);
    const ov = _activeOverrides[key];
    if (ov) {
      if (Array.isArray(ov.remove)) {
        for (const cap of ov.remove) base.delete(cap);
      }
      if (Array.isArray(ov.add)) {
        for (const cap of ov.add) {
          if (CAPABILITIES[cap]) base.add(cap);
        }
      }
    }
    // Safety: panel.view can never be removed; panel.manage_users can never be removed from owner
    base.add('panel.view');
    if (key === 'owner') base.add('panel.manage_users');
    rebuilt[key] = base;
  }
  _effectiveCapSets = rebuilt;
}

/** Return the currently active capability overrides (for API responses). */
export function getCapabilityOverrides() {
  return _activeOverrides;
}

/**
 * Return the Set of capabilities granted by a role name (with overrides applied).
 * Returns the viewer set for unknown role names (safe default).
 */
export function getCapabilitiesForRole(roleName) {
  return _effectiveCapSets[roleName] || _effectiveCapSets.viewer;
}

/**
 * Return the default (un-overridden) Set of capabilities for a role.
 */
export function getDefaultCapabilitiesForRole(roleName) {
  return _defaultCapSets[roleName] || _defaultCapSets.viewer;
}

/**
 * Return the numeric level for a role name (for ordering/display).
 * Returns 0 for unknown roles.
 */
export function getRoleLevel(roleName) {
  return ROLES[roleName]?.level ?? 0;
}

/**
 * Return the role name for a numeric level.
 * Returns 'viewer' for unknown levels.
 */
export function getRoleByLevel(level) {
  return ROLE_ORDER[level] || 'viewer';
}

/**
 * Check whether a role has a specific capability.
 */
export function roleHasCapability(roleName, capability) {
  const caps = getCapabilitiesForRole(roleName);
  return caps.has(capability);
}

// ---- Mapping: MC op level → app role -----------------------

/**
 * Default mapping from Minecraft operator level to app role.
 * Conservative: op 4 → admin (not owner). Owner must be granted
 * explicitly via the panel.
 */
export const DEFAULT_OP_LEVEL_MAPPING = {
  0: null, // no app permissions from op level 0
  1: 'viewer',
  2: 'operator',
  3: 'moderator',
  4: 'admin',
};

/**
 * Resolve an app role from a Minecraft op level using the given mapping.
 * Returns null if the op level has no mapped role.
 */
export function resolveOpLevelRole(opLevel, mapping) {
  const m = mapping || DEFAULT_OP_LEVEL_MAPPING;
  return m[opLevel] ?? m[String(opLevel)] ?? null;
}

// ---- Mapping: Discord role → app role ----------------------

/**
 * Resolve an app role from a Discord member's role IDs using the
 * configured mapping.  Returns the highest-level mapped role, or
 * null if no roles match.
 *
 * @param {string[]} memberRoleIds - Discord role IDs the member has
 * @param {Record<string, string>} mapping - Discord role ID → app role name
 * @returns {string|null} app role name or null
 */
export function resolveDiscordRoleMapping(memberRoleIds, mapping) {
  if (!mapping || !memberRoleIds?.length) return null;
  let bestRole = null;
  let bestLevel = -1;
  for (const roleId of memberRoleIds) {
    const appRole = mapping[roleId];
    if (appRole && ROLES[appRole]) {
      const level = ROLES[appRole].level;
      if (level > bestLevel) {
        bestLevel = level;
        bestRole = appRole;
      }
    }
  }
  return bestRole;
}

// ---- Permission policy / merge logic -----------------------

/**
 * Permission policies control how linked identities interact.
 *
 * - "isolated" (default, recommended):
 *     Each identity channel uses ONLY its own grants.
 *     A panel Owner with a Discord Viewer mapping can only do
 *     viewer-level things through Discord.
 *
 * - "inherit-panel":
 *     Linked Discord/game identities inherit ALL of the panel
 *     user's capabilities.  Use with caution.
 *
 * - "panel-ceiling":
 *     Linked identities use the HIGHER of their own channel role
 *     and the panel user's role.  The panel role acts as a ceiling
 *     that can elevate but never restrict.
 */
export const PERMISSION_POLICIES = ['isolated', 'inherit-panel', 'panel-ceiling'];

/**
 * Compute effective capabilities for a given identity context.
 *
 * @param {object} opts
 * @param {string}  opts.channel          - 'panel' | 'discord' | 'game'
 * @param {string}  [opts.channelRole]    - app role for this channel (from mapping)
 * @param {string}  [opts.panelRole]      - linked panel user's role (if any)
 * @param {string}  [opts.policy]         - permission policy name
 * @returns {{ role: string, capabilities: Set<string> }}
 */
export function resolveEffectivePermissions({ channel, channelRole, panelRole, policy = 'isolated' }) {
  // Start with the channel's own role
  let effectiveRole = channelRole || 'viewer';

  if (channel === 'panel') {
    // Panel sessions always use the panel user's own role directly
    effectiveRole = panelRole || effectiveRole;
  } else if (panelRole && policy !== 'isolated') {
    // Non-panel channels may inherit from the linked panel user
    if (policy === 'inherit-panel') {
      // Use the panel user's role entirely
      effectiveRole = panelRole;
    } else if (policy === 'panel-ceiling') {
      // Use the higher of channel role and panel role
      const channelLevel = getRoleLevel(effectiveRole);
      const panelLevel = getRoleLevel(panelRole);
      effectiveRole = panelLevel > channelLevel ? panelRole : effectiveRole;
    }
  }

  return {
    role: effectiveRole,
    capabilities: getCapabilitiesForRole(effectiveRole),
  };
}

// ---- Legacy compatibility ----------------------------------

/**
 * Convert a legacy admin_level (0 or 1) to a role name.
 * Used during migration.
 */
export function adminLevelToRole(adminLevel) {
  return adminLevel >= 1 ? 'admin' : 'viewer';
}

/**
 * Derive a legacy-compatible adminLevel from a role name.
 * Anything >= admin (level 3) counts as "admin" in the old model.
 */
export function roleToAdminLevel(roleName) {
  return getRoleLevel(roleName) >= 3 ? 1 : 0;
}

// ---- Authorization config defaults ------------------------

/**
 * Default authorization configuration block for config.json.
 */
export const DEFAULT_AUTHORIZATION_CONFIG = {
  permissionPolicy: 'isolated',
  opLevelMapping: { ...DEFAULT_OP_LEVEL_MAPPING },
  discordRoleMapping: {},
};

/**
 * Merge user authorization config with defaults, returning
 * a complete config object.
 */
export function mergeAuthorizationConfig(userConfig) {
  const base = { ...DEFAULT_AUTHORIZATION_CONFIG };
  if (!userConfig) return base;
  return {
    permissionPolicy: PERMISSION_POLICIES.includes(userConfig.permissionPolicy)
      ? userConfig.permissionPolicy
      : base.permissionPolicy,
    opLevelMapping: { ...base.opLevelMapping, ...(userConfig.opLevelMapping || {}) },
    discordRoleMapping: { ...(userConfig.discordRoleMapping || {}) },
  };
}
