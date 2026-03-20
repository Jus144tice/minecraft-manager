// ============================================================
// Multi-Environment Management
// ============================================================
//
// Supports multiple isolated Minecraft server environments
// (production, staging, testing, etc.) within a single panel
// instance.  Only one environment runs at a time ("active"),
// but any environment can be selected for configuration.
//
// Config structure after migration:
//   {
//     environments: { <id>: { name, serverPath, launch, ... } },
//     activeEnvironment: '<id>',
//     // ...shared keys (webPort, backupPath, etc.)
//   }
// ============================================================

// ---- Per-environment config keys ----------------------------
// These keys live inside each environment object.  Everything
// else in config.json is shared across all environments.

export const ENV_KEYS = [
  'serverPath',
  'launch',
  'rconHost',
  'rconPort',
  'rconPassword',
  'minecraftVersion',
  'modsFolder',
  'disabledModsFolder',
  'serverAddress',
  'autoStart',
  'autoRestart',
  'tpsAlertThreshold',
];

// ---- Validation helpers ------------------------------------

const ENV_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validateEnvironmentId(id) {
  return typeof id === 'string' && ENV_ID_RE.test(id);
}

export function validateEnvironmentConfig(env) {
  const errors = [];

  if (!env.name || typeof env.name !== 'string' || !env.name.trim()) {
    errors.push('Environment name is required.');
  }
  if (!env.serverPath || typeof env.serverPath !== 'string' || !env.serverPath.trim()) {
    errors.push('serverPath is required.');
  }
  if (env.launch !== undefined) {
    if (!env.launch || typeof env.launch !== 'object') {
      errors.push('launch must be an object with executable and args.');
    } else {
      if (!env.launch.executable || typeof env.launch.executable !== 'string' || !env.launch.executable.trim()) {
        errors.push('launch.executable is required.');
      }
      if (!Array.isArray(env.launch.args)) {
        errors.push('launch.args must be an array.');
      }
    }
  }

  const rconPort = env.rconPort;
  if (
    rconPort !== undefined &&
    (typeof rconPort !== 'number' || !Number.isInteger(rconPort) || rconPort < 1 || rconPort > 65535)
  ) {
    errors.push(`rconPort must be an integer between 1 and 65535 (got ${JSON.stringify(rconPort)}).`);
  }

  return errors;
}

// ---- Slug generation ---------------------------------------

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

// ---- Migration ---------------------------------------------

/**
 * Migrate a flat (pre-environments) config to the environments
 * structure.  Idempotent — returns `{ migrated: false }` if
 * already migrated.
 */
export function migrateToEnvironments(config) {
  if (config.environments && typeof config.environments === 'object') {
    // Already migrated — ensure activeEnvironment is set
    if (!config.activeEnvironment) {
      const firstId = Object.keys(config.environments)[0];
      if (firstId) {
        config.activeEnvironment = firstId;
        return { migrated: true, config };
      }
    }
    return { migrated: false, config };
  }

  // Extract per-env keys into a "default" environment
  const env = { name: 'Production v1.0' };
  for (const key of ENV_KEYS) {
    if (key in config) {
      env[key] = config[key];
    }
  }
  env.createdAt = new Date().toISOString();

  // Build new config: shared keys + environments structure
  const newConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (!ENV_KEYS.includes(key)) {
      newConfig[key] = value;
    }
  }
  newConfig.environments = { default: env };
  newConfig.activeEnvironment = 'default';

  return { migrated: true, config: newConfig };
}

// ---- Resolution --------------------------------------------

/**
 * Materialize a flat config by merging an environment's keys
 * onto the shared top-level keys.  The result looks exactly
 * like the old flat config shape, so existing code that reads
 * `config.serverPath` etc. works unchanged.
 */
export function resolveConfig(rawConfig, envId) {
  const id = envId || rawConfig.activeEnvironment;
  const env = rawConfig.environments?.[id];
  if (!env) {
    throw new Error(`Unknown environment: "${id}"`);
  }

  // Start with shared keys (everything except environments/activeEnvironment)
  const flat = {};
  for (const [key, value] of Object.entries(rawConfig)) {
    if (key !== 'environments' && key !== 'activeEnvironment') {
      flat[key] = value;
    }
  }

  // Overlay per-env keys
  for (const key of ENV_KEYS) {
    if (key in env) {
      flat[key] = env[key];
    }
  }

  // Include environment metadata for convenience
  flat.activeEnvironment = rawConfig.activeEnvironment;

  return flat;
}

/**
 * Get the resolved config for the session's selected environment.
 * Falls back to the active environment if no selection is set.
 */
export function getSelectedConfig(ctx, req) {
  const envId = req.session?.selectedEnvironment || ctx.rawConfig.activeEnvironment;
  return resolveConfig(ctx.rawConfig, envId);
}

/**
 * Get the selected environment ID from the request session,
 * falling back to the active environment.
 */
export function getSelectedEnvId(ctx, req) {
  return req.session?.selectedEnvironment || ctx.rawConfig.activeEnvironment;
}

// ---- CRUD --------------------------------------------------

export function listEnvironments(rawConfig) {
  const envs = rawConfig.environments || {};
  const activeId = rawConfig.activeEnvironment;
  return Object.entries(envs).map(([id, env]) => ({
    id,
    name: env.name || id,
    isActive: id === activeId,
    serverPath: env.serverPath,
    minecraftVersion: env.minecraftVersion,
    createdAt: env.createdAt,
  }));
}

export function getEnvironment(rawConfig, envId) {
  return rawConfig.environments?.[envId] || null;
}

export function createEnvironment(rawConfig, id, envConfig) {
  if (!validateEnvironmentId(id)) {
    throw new Error(`Invalid environment ID "${id}". Use lowercase letters, numbers, and hyphens (1-32 chars).`);
  }
  if (rawConfig.environments?.[id]) {
    throw new Error(`Environment "${id}" already exists.`);
  }

  const errors = validateEnvironmentConfig(envConfig);
  if (errors.length > 0) {
    throw new Error(`Invalid environment config: ${errors.join(' ')}`);
  }

  const env = { ...envConfig, createdAt: envConfig.createdAt || new Date().toISOString() };
  const updated = {
    ...rawConfig,
    environments: { ...rawConfig.environments, [id]: env },
  };
  return updated;
}

export function updateEnvironment(rawConfig, envId, updates) {
  const existing = rawConfig.environments?.[envId];
  if (!existing) {
    throw new Error(`Environment "${envId}" not found.`);
  }

  // Only allow updating known env keys + name
  const merged = { ...existing };
  if (updates.name !== undefined) merged.name = updates.name;
  for (const key of ENV_KEYS) {
    if (key in updates) {
      merged[key] = updates[key];
    }
  }

  const updated = {
    ...rawConfig,
    environments: { ...rawConfig.environments, [envId]: merged },
  };
  return updated;
}

export function deleteEnvironment(rawConfig, envId) {
  if (!rawConfig.environments?.[envId]) {
    throw new Error(`Environment "${envId}" not found.`);
  }
  if (envId === rawConfig.activeEnvironment) {
    throw new Error('Cannot delete the active environment. Deploy a different environment first.');
  }

  const { [envId]: _removed, ...remaining } = rawConfig.environments;
  return { ...rawConfig, environments: remaining };
}

export function switchActiveEnvironment(rawConfig, envId) {
  if (!rawConfig.environments?.[envId]) {
    throw new Error(`Environment "${envId}" not found.`);
  }
  return { ...rawConfig, activeEnvironment: envId };
}
