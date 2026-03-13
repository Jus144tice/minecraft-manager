// Scope-based operation lock for mutual exclusion of destructive actions.
// Two operations conflict if they share any scope. This prevents races like
// starting the server mid-restore or importing mods during a backup.
//
// Scopes:
//   'files'     — touches server files (backup, restore, modpack import)
//   'lifecycle' — changes server running state (start, restart, restore)
//
// Kill is intentionally excluded — it's an emergency escape hatch.
// Stop is excluded — backup quiesce already handles live→stopped transitions.

import { info } from './audit.js';

const activeOps = new Map(); // id → { name, scopes, startedAt }
let nextId = 1;

/**
 * Acquire a lock for an operation with the given scopes.
 * Throws if a conflicting operation is already active.
 * Returns an opaque ID to pass to releaseOp().
 */
export function acquireOp(name, scopes) {
  for (const [, op] of activeOps) {
    if (op.scopes.some((s) => scopes.includes(s))) {
      throw new Error(
        `Cannot ${name}: ${op.name} is already in progress (started ${new Date(op.startedAt).toISOString()}). Wait for it to finish.`,
      );
    }
  }
  const id = nextId++;
  activeOps.set(id, { name, scopes, startedAt: Date.now() });
  info(`Operation lock acquired: ${name}`, { id, scopes });
  return id;
}

/**
 * Release a previously acquired operation lock.
 */
export function releaseOp(id) {
  const op = activeOps.get(id);
  if (op) {
    info(`Operation lock released: ${op.name}`, { id });
    activeOps.delete(id);
  }
}

/**
 * Return all active operations (for the /api/operations endpoint and UI).
 */
export function getActiveOps() {
  return [...activeOps.values()];
}
