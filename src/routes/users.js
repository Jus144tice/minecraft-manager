import { Router } from 'express';
import { listUsers, getUser, setAdminLevel, deleteUser } from '../db.js';
import { audit } from '../audit.js';
import { requireAdmin } from '../middleware.js';

export default function userRoutes() {
  const router = Router();

  router.get('/users', requireAdmin, async (req, res) => {
    try { res.json(await listUsers()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/users/:email', requireAdmin, async (req, res) => {
    try {
      const user = await getUser(req.params.email);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put('/users/:email/admin', requireAdmin, async (req, res) => {
    const { level } = req.body;
    if (![0, 1].includes(Number(level))) return res.status(400).json({ error: 'level must be 0 or 1' });
    try {
      const user = await setAdminLevel(req.params.email, Number(level));
      if (!user) return res.status(404).json({ error: 'User not found' });
      audit('ADMIN_LEVEL_CHANGE', { user: req.session.user.email, target: req.params.email, level: Number(level), ip: req.ip });
      res.json(user);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/users/:email', requireAdmin, async (req, res) => {
    if (req.params.email === req.session.user.email) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    try {
      const ok = await deleteUser(req.params.email);
      if (!ok) return res.status(404).json({ error: 'User not found' });
      audit('USER_DELETE', { user: req.session.user.email, target: req.params.email, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
