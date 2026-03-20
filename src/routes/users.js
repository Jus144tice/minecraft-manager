// User management routes: list, get, set role, delete.
// All endpoints require panel.manage_users capability (Owner role).

import { Router } from 'express';
import { listUsers, getUser, setUserRole, deleteUser } from '../db.js';
import { audit } from '../audit.js';
import { requireCapability } from '../middleware.js';
import {
  ROLES,
  ROLE_ORDER,
  CAPABILITIES,
  getCapabilitiesForRole,
  getDefaultCapabilitiesForRole,
  getCapabilityOverrides,
  setCapabilityOverrides,
} from '../permissions.js';

export default function userRoutes(ctx) {
  const router = Router();

  /** GET /users — list all panel users */
  router.get('/users', requireCapability('panel.manage_users'), async (req, res) => {
    try {
      res.json(await listUsers());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /users/:email — get a single user */
  router.get('/users/:email', requireCapability('panel.manage_users'), async (req, res) => {
    try {
      const user = await getUser(req.params.email);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** PUT /users/:email/role — set a user's role (viewer/operator/moderator/admin/owner) */
  router.put('/users/:email/role', requireCapability('panel.manage_users'), async (req, res) => {
    const { role } = req.body;
    if (!ROLE_ORDER.includes(role)) {
      return res.status(400).json({
        error: `Invalid role. Must be one of: ${ROLE_ORDER.join(', ')}`,
      });
    }
    try {
      const user = await setUserRole(req.params.email, role);
      if (!user) return res.status(404).json({ error: 'User not found' });
      audit('USER_ROLE_CHANGE', {
        user: req.session.user.email,
        target: req.params.email,
        role,
        ip: req.ip,
      });
      res.json(user);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** PUT /users/:email/admin — legacy endpoint for setting admin level (backward compat) */
  router.put('/users/:email/admin', requireCapability('panel.manage_users'), async (req, res) => {
    const { level } = req.body;
    if (![0, 1].includes(Number(level))) return res.status(400).json({ error: 'level must be 0 or 1' });
    // Map legacy admin levels to roles
    const role = Number(level) >= 1 ? 'admin' : 'viewer';
    try {
      const user = await setUserRole(req.params.email, role);
      if (!user) return res.status(404).json({ error: 'User not found' });
      audit('USER_ROLE_CHANGE', {
        user: req.session.user.email,
        target: req.params.email,
        role,
        level: Number(level),
        ip: req.ip,
      });
      res.json(user);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** DELETE /users/:email — delete a user account */
  router.delete('/users/:email', requireCapability('panel.manage_users'), async (req, res) => {
    if (req.params.email === req.session.user.email) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    try {
      const ok = await deleteUser(req.params.email);
      if (!ok) return res.status(404).json({ error: 'User not found' });
      audit('USER_DELETE', { user: req.session.user.email, target: req.params.email, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /roles — list available role definitions with effective + default capabilities */
  router.get('/roles', (req, res) => {
    const isOwner = req.session?.user?.role === 'owner';
    const overrides = getCapabilityOverrides();
    const roles = {};
    for (const [key, role] of Object.entries(ROLES)) {
      roles[key] = {
        name: role.name,
        level: role.level,
        description: role.description,
        capabilities: [...getCapabilitiesForRole(key)],
        defaultCapabilities: [...getDefaultCapabilitiesForRole(key)],
      };
    }
    res.json({
      roles,
      allCapabilities: Object.keys(CAPABILITIES),
      capabilityDescriptions: CAPABILITIES,
      overrides,
      editable: isOwner,
    });
  });

  /** PUT /roles/capabilities — update capability overrides (Owner only) */
  router.put('/roles/capabilities', requireCapability('panel.manage_users'), async (req, res) => {
    const { roles: desired } = req.body;
    if (!desired || typeof desired !== 'object') {
      return res.status(400).json({ error: 'Request body must contain a "roles" object' });
    }

    // Compute overrides by diffing desired vs defaults
    const overrides = {};
    const allCapKeys = new Set(Object.keys(CAPABILITIES));
    for (const roleName of ROLE_ORDER) {
      const desiredCaps = desired[roleName];
      if (!Array.isArray(desiredCaps)) continue;
      const defaultCaps = getDefaultCapabilitiesForRole(roleName);
      const desiredSet = new Set(desiredCaps.filter((c) => allCapKeys.has(c)));

      const add = [];
      const remove = [];
      // Capabilities in desired but not in default → add
      for (const cap of desiredSet) {
        if (!defaultCaps.has(cap)) add.push(cap);
      }
      // Capabilities in default but not in desired → remove
      for (const cap of defaultCaps) {
        if (!desiredSet.has(cap)) remove.push(cap);
      }

      // Safety: panel.view can never be removed; panel.manage_users can never be removed from owner
      const safeRemove = remove.filter((c) => {
        if (c === 'panel.view') return false;
        if (c === 'panel.manage_users' && roleName === 'owner') return false;
        return true;
      });

      if (add.length > 0 || safeRemove.length > 0) {
        overrides[roleName] = {};
        if (add.length > 0) overrides[roleName].add = add;
        if (safeRemove.length > 0) overrides[roleName].remove = safeRemove;
      }
    }

    // Apply overrides to the runtime permission engine
    setCapabilityOverrides(overrides);

    // Persist to config.json
    try {
      const fs = await import('fs');
      const path = await import('path');
      const configPath = path.default.resolve('config.json');
      const raw = fs.default.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);
      if (!config.authorization) config.authorization = {};
      if (Object.keys(overrides).length > 0) {
        config.authorization.capabilityOverrides = overrides;
      } else {
        delete config.authorization.capabilityOverrides;
      }
      // Also update runtime config
      ctx.config.authorization = config.authorization;
      fs.default.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    } catch (err) {
      // Non-critical in demo mode — overrides still applied to runtime
      if (!ctx.config.demoMode) {
        return res.status(500).json({ error: 'Failed to save config: ' + err.message });
      }
    }

    audit('RBAC_OVERRIDES_CHANGED', {
      user: req.session.user.email,
      overrides,
      ip: req.ip,
    });

    // Return the updated role definitions
    const result = {};
    for (const [key, role] of Object.entries(ROLES)) {
      result[key] = {
        name: role.name,
        level: role.level,
        description: role.description,
        capabilities: [...getCapabilitiesForRole(key)],
        defaultCapabilities: [...getDefaultCapabilitiesForRole(key)],
      };
    }
    res.json({
      roles: result,
      allCapabilities: Object.keys(CAPABILITIES),
      capabilityDescriptions: CAPABILITIES,
      overrides: getCapabilityOverrides(),
      editable: true,
    });
  });

  return router;
}
