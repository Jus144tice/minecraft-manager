// User management routes: list, get, set role, delete.
// All endpoints require panel.manage_users capability (Owner role).

import { Router } from 'express';
import { listUsers, getUser, setUserRole, deleteUser } from '../db.js';
import { audit } from '../audit.js';
import { requireCapability } from '../middleware.js';
import { ROLES, ROLE_ORDER, getCapabilitiesForRole } from '../permissions.js';

export default function userRoutes() {
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

  /** GET /roles — list available role definitions (public info for UI) */
  router.get('/roles', (_req, res) => {
    const roles = {};
    for (const [key, role] of Object.entries(ROLES)) {
      roles[key] = {
        name: role.name,
        level: role.level,
        description: role.description,
        capabilities: [...getCapabilitiesForRole(key)],
      };
    }
    res.json(roles);
  });

  return router;
}
