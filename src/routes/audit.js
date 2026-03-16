// Audit log route: paginated, filterable query of all audited actions.
// Requires admin access and PostgreSQL (db.js).

import { Router } from 'express';
import { queryAuditLogs } from '../db.js';
import { requireCapability } from '../middleware.js';

export default function auditRoutes() {
  const router = Router();

  router.get('/audit-logs', requireCapability('audit.view'), async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const action = req.query.action || undefined;
    const email = req.query.email || undefined;
    try {
      res.json(await queryAuditLogs({ action, email, limit, offset }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
