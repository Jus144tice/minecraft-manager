// Settings routes: server.properties editor, app config (config.json), directory browser.
// Config POST validates cron expressions and refreshes the backup schedule when changed.
// GET /config redacts rconPassword and webPassword before responding.

import { Router } from 'express';
import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import * as SF from '../serverFiles.js';
import * as Demo from '../demoData.js';
import cron from 'node-cron';
import * as Backup from '../backup.js';
import { audit } from '../audit.js';
import { runPreflight } from '../preflight.js';
import { requireCapability } from '../middleware.js';
import { getSelectedConfig } from '../environments.js';
import {
  getDiscordStatus,
  testDiscordConnection,
  testDiscordNotification,
  sendDiscordMessage,
} from '../integrations/discord/index.js';

export default function settingsRoutes(ctx) {
  const router = Router();

  router.get('/settings/properties', async (req, res) => {
    if (ctx.config.demoMode) return res.json(Demo.DEMO_PROPERTIES);
    try {
      const env = getSelectedConfig(ctx, req);
      res.json(await SF.getServerProperties(env.serverPath));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/settings/properties', requireCapability('panel.configure'), async (req, res) => {
    if (ctx.config.demoMode) {
      Object.assign(Demo.DEMO_PROPERTIES, req.body);
      return res.json({ ok: true, demo: true });
    }
    try {
      const env = getSelectedConfig(ctx, req);
      await SF.setServerProperties(env.serverPath, req.body);
      audit('PROPS_SAVE', { user: req.session.user.email, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- JVM arguments (user_jvm_args.txt) ---

  const JVM_ARGS_FILE = 'user_jvm_args.txt';

  router.get('/settings/jvm-args', async (req, res) => {
    if (ctx.config.demoMode) {
      return res.json({
        content: [
          '# Memory allocation',
          '-Xms4G',
          '-Xmx8G',
          '',
          '# Garbage Collector',
          '-XX:+UseG1GC',
          '-XX:+ParallelRefProcEnabled',
          '-XX:MaxGCPauseMillis=200',
        ].join('\n'),
      });
    }
    try {
      const env = getSelectedConfig(ctx, req);
      const filePath = path.join(env.serverPath, JVM_ARGS_FILE);
      const content = await readFile(filePath, 'utf8');
      res.json({ content });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ content: null });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/settings/jvm-args', requireCapability('panel.configure'), async (req, res) => {
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (ctx.config.demoMode) return res.json({ ok: true, demo: true });
    try {
      const env = getSelectedConfig(ctx, req);
      const filePath = path.join(env.serverPath, JVM_ARGS_FILE);
      await writeFile(filePath, content, 'utf8');
      audit('JVM_ARGS_SAVE', { user: req.session.user.email, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Simple Voice Chat config ---

  router.get('/settings/voicechat', async (req, res) => {
    if (ctx.config.demoMode) {
      return res.json({
        port: '24454',
        max_voice_distance: '48.0',
        whisper_distance: '24.0',
        enable_groups: 'true',
        allow_recording: 'true',
        force_voice_chat: 'false',
      });
    }
    try {
      const env = getSelectedConfig(ctx, req);
      const props = await SF.getVoicechatProperties(env.serverPath);
      res.json(props); // null = mod not installed
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/settings/voicechat', requireCapability('panel.configure'), async (req, res) => {
    if (ctx.config.demoMode) return res.json({ ok: true, demo: true });
    try {
      const env = getSelectedConfig(ctx, req);
      await SF.setVoicechatProperties(env.serverPath, req.body);
      audit('VOICECHAT_PROPS_SAVE', { user: req.session.user.email, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- FTB Chunks config ---

  router.get('/settings/ftbchunks', async (req, res) => {
    if (ctx.config.demoMode) {
      return res.json({
        max_claimed_chunks: '500',
        max_force_loaded_chunks: '25',
        hard_team_claim_limit: '0',
        hard_team_force_limit: '0',
        party_limit_mode: 'LARGEST',
        _path: 'world/serverconfig/ftbchunks-server.snbt',
        ftbRanksInstalled: false,
      });
    }
    try {
      const env = getSelectedConfig(ctx, req);
      const config = await SF.getFtbChunksConfig(env.serverPath);
      if (!config) return res.json(null); // mod not installed
      config.ftbRanksInstalled = await SF.isFtbRanksInstalled(env.serverPath, env.modsFolder);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/settings/ftbchunks', requireCapability('panel.configure'), async (req, res) => {
    if (ctx.config.demoMode) return res.json({ ok: true, demo: true });
    try {
      const env = getSelectedConfig(ctx, req);
      await SF.setFtbChunksConfig(env.serverPath, req.body);
      audit('FTBCHUNKS_CONFIG_SAVE', { user: req.session.user.email, ip: req.ip });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/config', (req, res) => {
    const { webPassword: _1, rconPassword: _2, ...safe } = ctx.config;
    // Redact Discord bot token — it comes from env vars, but never echo it
    if (safe.discord) {
      safe.discord = { ...safe.discord };
      delete safe.discord.botToken;
    }
    res.json(safe);
  });

  router.post('/config', requireCapability('panel.configure'), async (req, res) => {
    const allowed = [
      'serverPath',
      'serverAddress',
      'rconHost',
      'rconPort',
      'rconPassword',
      'launch',
      'minecraftVersion',
      'modsFolder',
      'disabledModsFolder',
      'demoMode',
      'backupPath',
      'backupSchedule',
      'backupEnabled',
      'maxBackups',
      'backupTimezone',
      'bindHost',
      'autoStart',
      'autoRestart',
      'tpsAlertThreshold',
      'notifications',
      'discord',
      'authorization',
    ];
    const updates = {};
    for (const k of allowed) {
      if (k in req.body) updates[k] = req.body[k];
    }
    // Validate launch config structure
    if (updates.launch) {
      if (typeof updates.launch !== 'object' || !updates.launch.executable || !Array.isArray(updates.launch.args)) {
        return res.status(400).json({
          error: 'Invalid launch config: must include "executable" (string) and "args" (array).',
        });
      }
      if (!updates.launch.executable.trim()) {
        return res.status(400).json({ error: 'Launch executable cannot be empty.' });
      }
      // Sanitize: only keep known keys
      updates.launch = {
        executable: updates.launch.executable,
        args: updates.launch.args.map(String),
        ...(updates.launch.env && typeof updates.launch.env === 'object' ? { env: updates.launch.env } : {}),
      };
    }
    // Sanitize notifications config
    if (updates.notifications) {
      if (typeof updates.notifications !== 'object' || Array.isArray(updates.notifications)) {
        return res.status(400).json({ error: 'notifications must be an object.' });
      }
      const n = updates.notifications;
      updates.notifications = {
        ...(n.webhookUrl && typeof n.webhookUrl === 'string' ? { webhookUrl: n.webhookUrl.trim() } : {}),
        ...(Array.isArray(n.events) ? { events: n.events.filter((e) => typeof e === 'string') } : {}),
      };
    }
    // Sanitize Discord config — never allow botToken to be saved in config.json
    if (updates.discord) {
      if (typeof updates.discord !== 'object' || Array.isArray(updates.discord)) {
        return res.status(400).json({ error: 'discord must be an object.' });
      }
      const d = updates.discord;
      const DISCORD_ALLOWED = [
        'enabled',
        'applicationId',
        'guildId',
        'botAdminRoleIds',
        'adminRoleIds', // legacy key, mapped to botAdminRoleIds
        'allowedRoleIds',
        'ownerOverrideRoleIds',
        'notificationChannelId',
        'commandChannelIds',
        'allowDMs',
        'registerCommandsOnStartup',
        'linkChallengeTimeoutMinutes',
      ];
      const sanitized = {};
      for (const k of DISCORD_ALLOWED) {
        if (k in d) sanitized[k] = d[k];
      }
      // Merge with existing discord config (preserve fields not being updated)
      updates.discord = { ...(ctx.config.discord || {}), ...sanitized };
    }
    // Sanitize authorization config
    if (updates.authorization) {
      if (typeof updates.authorization !== 'object' || Array.isArray(updates.authorization)) {
        return res.status(400).json({ error: 'authorization must be an object.' });
      }
      const a = updates.authorization;
      const sanitized = {};
      if (a.permissionPolicy && typeof a.permissionPolicy === 'string') {
        sanitized.permissionPolicy = a.permissionPolicy;
      }
      if (a.opLevelMapping && typeof a.opLevelMapping === 'object') {
        sanitized.opLevelMapping = a.opLevelMapping;
      }
      if (a.discordRoleMapping && typeof a.discordRoleMapping === 'object') {
        sanitized.discordRoleMapping = a.discordRoleMapping;
      }
      updates.authorization = { ...(ctx.config.authorization || {}), ...sanitized };
    }
    // Validate cron expression before saving
    if (updates.backupSchedule && !cron.validate(updates.backupSchedule)) {
      return res.status(400).json({
        error: `Invalid cron expression: "${updates.backupSchedule}". Use a format like "0 3 * * *" (minute hour day month weekday).`,
      });
    }

    try {
      await ctx.saveConfig(updates);
      if (updates.demoMode === false) ctx.stopDemoActivityTimer();
      if (updates.demoMode === true) ctx.startDemoActivityTimer();
      if (['backupPath', 'backupSchedule', 'backupEnabled', 'maxBackups', 'backupTimezone'].some((k) => k in updates)) {
        Backup.setupBackupSchedule(ctx.config, {
          rconCmd: ctx.rconCmd,
          get rconConnected() {
            return ctx.rconConnected;
          },
        });
      }
      audit('CONFIG_SAVE', {
        user: req.session.user.email,
        keys: Object.keys(updates).filter((k) => k !== 'rconPassword'),
        ip: req.ip,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Discord integration status & testing ---

  router.get('/discord/status', (_req, res) => {
    res.json(getDiscordStatus());
  });

  router.post('/discord/test-connection', requireCapability('discord.manage'), async (_req, res) => {
    const result = await testDiscordConnection();
    res.json(result);
  });

  router.post('/discord/test-notification', requireCapability('discord.manage'), async (_req, res) => {
    const result = await testDiscordNotification();
    res.json(result);
  });

  router.post('/discord/send-message', requireCapability('chat.broadcast'), async (req, res) => {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    const result = await sendDiscordMessage(message.trim());
    if (result.ok) {
      audit('DISCORD_SEND_MESSAGE', { user: req.session.user.email, ip: req.ip });
    }
    res.json(result);
  });

  // --- Server-side directory browser ---
  router.get('/browse-dirs', async (req, res) => {
    const isWin = os.platform() === 'win32';
    const requested = req.query.path || '';

    try {
      // No path requested: return filesystem roots
      if (!requested) {
        if (isWin) {
          const drives = [];
          for (let c = 65; c <= 90; c++) {
            const letter = String.fromCharCode(c);
            try {
              await stat(`${letter}:\\`);
              drives.push({ name: `${letter}:\\`, path: `${letter}:\\` });
            } catch {
              /* drive not available */
            }
          }
          return res.json({ current: '', sep: '\\', crumbs: [], dirs: drives });
        }
        return res.json({ current: '/', sep: '/', crumbs: [{ name: '/', path: '/' }], dirs: [] });
      }

      // Resolve to absolute, walk up to the nearest existing ancestor if needed
      let resolved = path.resolve(requested);
      for (let attempts = 0; attempts < 50; attempts++) {
        try {
          const info = await stat(resolved);
          if (info.isDirectory()) break;
          resolved = path.dirname(resolved);
        } catch {
          const parent = path.dirname(resolved);
          if (parent === resolved) break; // hit root
          resolved = parent;
        }
      }

      const entries = await readdir(resolved, { withFileTypes: true });
      const dirs = entries
        .filter((e) => {
          try {
            return e.isDirectory() && !e.name.startsWith('.');
          } catch {
            return false;
          } // permission errors on some dirs
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((e) => ({
          name: e.name,
          path: path.join(resolved, e.name),
        }));

      // Build breadcrumb segments for the current path
      const crumbs = [];
      let crumbPath = resolved;
      while (true) {
        const name = path.basename(crumbPath) || crumbPath; // root has no basename
        crumbs.unshift({ name, path: crumbPath });
        const parent = path.dirname(crumbPath);
        if (parent === crumbPath) break; // hit root
        crumbPath = parent;
      }

      res.json({ current: resolved, sep: path.sep, crumbs, dirs });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Preflight checks ----
  router.get('/preflight', async (_req, res) => {
    try {
      const result = await runPreflight(ctx.config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a directory (used by the directory browser's "New Folder" button)
  router.post('/mkdir', requireCapability('server.manage_files'), async (req, res) => {
    const { path: dirPath } = req.body;
    if (!dirPath || typeof dirPath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    try {
      const resolved = path.resolve(dirPath);
      await mkdir(resolved, { recursive: true });
      res.json({ ok: true, path: resolved });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
