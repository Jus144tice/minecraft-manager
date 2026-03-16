// Identity routes: unified panel↔Minecraft linking and identity view.
// Self-linking uses the challenge-code system (shared with Discord linking).
// Admin endpoints allow managing panel links directly.

import { Router } from 'express';
import { audit } from '../audit.js';
import { isValidMinecraftName } from '../validate.js';
import { requireCapability } from '../middleware.js';
import * as panelLinks from '../panelLinks.js';
import { createChallenge, getPendingChallenge, getChallengeTimeout } from '../integrations/discord/links.js';
import { getLinkByMinecraftName as getDiscordLinkByMcName } from '../integrations/discord/links.js';
import * as SF from '../serverFiles.js';
import * as Demo from '../demoData.js';

export default function identityRoutes(ctx) {
  const router = Router();

  // ---- Self-service identity endpoints (any authenticated user) ----

  /** GET /identity/me — unified identity view for the logged-in user */
  router.get('/identity/me', async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });

    const { email, name, provider, adminLevel, role } = req.session.user;
    const result = { email, name, provider, adminLevel: adminLevel || 0, role: role || 'viewer' };

    // Panel↔MC link
    const link = await panelLinks.getLink(email);
    if (link) {
      result.minecraft = {
        name: link.minecraftName,
        verified: link.verified,
        linkedAt: link.linkedAt,
      };

      // Enrich with server data
      try {
        let ops, whitelist, onlinePlayers;
        if (ctx.config.demoMode) {
          ops = Demo.DEMO_OPS;
          whitelist = Demo.DEMO_WHITELIST;
          onlinePlayers = ctx.demoState.running ? Demo.DEMO_ONLINE_PLAYERS : [];
        } else {
          [ops, whitelist] = await Promise.all([
            SF.getOps(ctx.config.serverPath),
            SF.getWhitelist(ctx.config.serverPath),
          ]);
          try {
            const r = await ctx.rconCmd('list');
            const m = r.match(/There are \d+ of a max of \d+ players online: (.*)/);
            onlinePlayers = m && m[1].trim() ? m[1].split(', ').map((n) => n.trim()) : [];
          } catch {
            onlinePlayers = null;
          }
        }

        const lowerName = link.minecraftName.toLowerCase();
        const op = ops.find((o) => o.name.toLowerCase() === lowerName);
        const wl = whitelist.find((e) => e.name.toLowerCase() === lowerName);

        if (op) result.minecraft.opLevel = op.level;
        result.minecraft.whitelisted = !!wl;
        if (onlinePlayers !== null) {
          result.minecraft.online = onlinePlayers.some((n) => n.toLowerCase() === lowerName);
        }
      } catch {
        // Non-critical enrichment — don't fail the response
      }

      // Discord link for same MC player
      const discordLink = await getDiscordLinkByMcName(link.minecraftName);
      if (discordLink) {
        result.discord = {
          discordId: discordLink.discordId,
          linkedAt: discordLink.linkedAt,
        };
      }
    }

    res.json(result);
  });

  /** POST /identity/link — start self-link challenge: { minecraftName } → returns challenge code */
  router.post('/identity/link', async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });

    const { minecraftName } = req.body;
    if (!minecraftName) return res.status(400).json({ error: 'minecraftName required' });
    if (!isValidMinecraftName(minecraftName)) {
      return res.status(400).json({ error: 'Invalid Minecraft player name' });
    }

    const email = req.session.user.email;

    // Check if already linked
    const existing = await panelLinks.getLink(email);
    if (existing) {
      return res.status(409).json({
        error: `Already linked to ${existing.minecraftName}. Unlink first.`,
      });
    }

    // Check if this MC name is already linked to another panel user
    const existingClaim = await panelLinks.getLinkByMinecraftName(minecraftName);
    if (existingClaim && existingClaim.email !== email) {
      return res.status(409).json({
        error: `${minecraftName} is already linked to another panel account.`,
      });
    }

    // Check server online (needed for verification)
    if (!ctx.config.demoMode && !ctx.mc.running) {
      return res.status(503).json({
        error: 'Minecraft server is offline. Start the server first — you need to type a verification code in-game.',
      });
    }

    // Create challenge with sourceType 'panel'
    const challenge = createChallenge(email, minecraftName, 'panel');
    const timeoutMinutes = Math.round(getChallengeTimeout() / 60_000);

    audit('PANEL_LINK_CHALLENGE', { email, minecraftName, ip: req.ip });

    res.json({
      code: challenge.code,
      minecraftName,
      expiresInMinutes: timeoutMinutes,
      instructions: `Join the server as ${minecraftName} and type: !link ${challenge.code}`,
    });
  });

  /** GET /identity/link/status — check if a pending challenge has been completed */
  router.get('/identity/link/status', async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });

    const email = req.session.user.email;

    // Check if link now exists (challenge was completed)
    const link = await panelLinks.getLink(email);
    if (link) {
      return res.json({ linked: true, minecraftName: link.minecraftName, verified: link.verified });
    }

    // Check if challenge is still pending
    const pending = getPendingChallenge(email, 'panel');
    if (pending) {
      return res.json({ linked: false, pending: true, code: pending.code, minecraftName: pending.minecraftName });
    }

    res.json({ linked: false, pending: false });
  });

  /** DELETE /identity/link — remove own MC link */
  router.delete('/identity/link', async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });

    const email = req.session.user.email;
    const existed = await panelLinks.removeLink(email);
    if (existed) {
      audit('PANEL_UNLINK_SELF', { email, ip: req.ip });
    }
    res.json({ ok: true, existed });
  });

  // ---- Admin panel-link management ----

  /** GET /panel-links — list all panel↔MC links */
  router.get('/panel-links', requireCapability('identity.view_links'), async (_req, res) => {
    try {
      res.json(await panelLinks.getAllLinks());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /panel-link — admin-create a link: { email, minecraftName } */
  router.post('/panel-link', requireCapability('panel.link_identities'), async (req, res) => {
    const { email, minecraftName } = req.body;
    if (!email || !minecraftName) return res.status(400).json({ error: 'email and minecraftName required' });
    if (!isValidMinecraftName(minecraftName)) return res.status(400).json({ error: 'Invalid player name' });

    try {
      await panelLinks.setLink(email, minecraftName, `admin:${req.session.user.email}`, false);
      audit('PANEL_LINK_ADMIN', { admin: req.session.user.email, email, minecraftName, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** DELETE /panel-link/:email — admin-remove a link */
  router.delete('/panel-link/:email', requireCapability('panel.link_identities'), async (req, res) => {
    const { email } = req.params;
    try {
      const existed = await panelLinks.removeLink(email);
      if (existed) {
        audit('PANEL_UNLINK_ADMIN', { admin: req.session.user.email, email, ip: req.ip });
      }
      res.json({ ok: true, existed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
