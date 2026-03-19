# CLAUDE.md — Minecraft Manager

> **Self-maintenance rule**: When you modify any file in this project, check whether the change affects
> information in this document (line numbers, file list, exports, patterns, routes). If it does, update
> CLAUDE.md in the same commit. Line numbers shift — keep them accurate.
>
> **Pre-push rule**: ALWAYS run `npm run lint && npx prettier --check .` before committing. Fix any
> issues before pushing. CI fails on lint errors and formatting — never push without checking both.

## Quick Reference

- **Stack**: Node.js + Express backend, vanilla JS frontend (single-page app), PostgreSQL (optional)
- **Module system**: ESM (`"type": "module"` in package.json)
- **Node version**: >=20.19.0
- **Test runner**: `node:test` (built-in, no framework)
- **Lint/format**: ESLint 10 (flat config) + Prettier (120 col, single quotes, trailing commas)

## Commands

```bash
npm test                  # Unit tests (tests/*.test.js)
npm run test:integration  # Network-dependent tests (tests/*.integration.js)
npm run test:e2e          # Playwright browser tests (demo mode)
npm run validate          # lint + format:check + test + e2e (~30s total)
npm run lint              # ESLint
npm run lint:fix          # ESLint autofix
npm run format            # Prettier write
npm run format:check      # Prettier check
npm run dev               # Dev server with --watch
npm start                 # Production start with --env-file=.env
```

## File Map

### Entry Point

| File        | Key Landmarks                                               |
| ----------- | ----------------------------------------------------------- |
| `server.js` | Express bootstrap, middleware, WebSocket, graceful shutdown |
|             | L113: WebSocket server created                              |
|             | L183: Middleware stack begins                               |
|             | L288: Authenticated route mounting                          |
|             | L350: Metrics broadcast interval (10s)                      |
|             | L449: `gracefulShutdown()`                                  |

### Core Modules (`src/`)

| File                  | Purpose                                           | Key Locations                                                                                                                                                |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth.js`             | OIDC (Google/Microsoft) + local password auth     | L49: `buildSessionMiddleware()`, L101: `buildAuthRouter()`                                                                                                   |
| `permissions.js`      | RBAC engine: 5 roles, 30 capabilities, 3 policies | L30: `CAPABILITIES`, L135: `ROLES`, L169: `ROLE_ORDER`, L183: `getCapabilitiesForRole()`, L282: `PERMISSION_POLICIES`, L294: `resolveEffectivePermissions()` |
| `middleware.js`       | Helmet, rate limiting, CSRF, origin checks        | L70: `buildCsrfCheck()`, L133: `requireCapability()`                                                                                                         |
| `db.js`               | PostgreSQL schema + CRUD helpers                  | L15: `SCHEMA_SQL`, L66: `initDatabase()`, L111: `upsertUser()`, L185: `insertAuditLog()`, L231: `upsertDiscordLink()`, L279: `upsertPanelLink()`             |
| `audit.js`            | Structured JSON logging + DB audit trail          | Exports: `audit()`, `info()`, `warn()`, `setNotifyHook()`                                                                                                    |
| `services.js`         | Creates shared `ctx` object                       | L14: `createServices()`                                                                                                                                      |
| `minecraftProcess.js` | Child process, log streaming (2000-line buffer)   | L7: `class MinecraftProcess`, L19: `start()`, L89: `stop()`                                                                                                  |
| `rcon.js`             | Source RCON protocol client                       | L7: `class RconClient`, L20: `connect()`, L98: `sendCommand()`                                                                                               |
| `operationLock.js`    | Mutex for destructive ops                         | L22: `acquireOp()`, L39: `releaseOp()`                                                                                                                       |
| `backup.js`           | tar.gz backup/restore, cron scheduling            | L181: `createBackup()`, L468: `restoreBackup()`, L606: `initBackupScheduler()`                                                                               |
| `metrics.js`          | TPS, CPU, RAM, disk, player count                 | L155: `parseTps()`, L194: `collectMetrics()`                                                                                                                 |
| `notify.js`           | Webhook + Discord notifications                   | L15: `initNotifications()`, L172: `onAuditEvent()`                                                                                                           |
| `validate.js`         | Input validation & config migration               | L9: `isValidMinecraftName()`, L17: `isSafeModFilename()`, L28: `isSafeMrpackFilename()`, L58: `parseLaunchCommand()`, L90: `validateConfig()`                |
| `preflight.js`        | Runtime diagnostic checks                         | Exports: `runPreflight()`                                                                                                                                    |
| `pathUtils.js`        | Path traversal prevention                         | Exports: `safeJoin()`                                                                                                                                        |
| `serverFiles.js`      | CRUD for MC server JSON files & mods              | L27: `getOps()`, L35: `getWhitelist()`, L61: `getServerProperties()`, L112: `listMods()`                                                                     |
| `modrinth.js`         | Modrinth API v2 wrapper                           | L32: `searchMods()`, L177: `downloadModFile()`                                                                                                               |
| `mrpack.js`           | .mrpack ZIP parsing & building                    | L205: `parseMrpack()`, L363: `buildMrpack()`                                                                                                                 |
| `panelLinks.js`       | Panel user ↔ MC player linking                    | L30: `setLink()`                                                                                                                                             |
| `demoData.js`         | Seed data for demo mode                           | L26: `DEMO_ONLINE_PLAYERS`, L147: `DEMO_MODS`, L766: `enrichDemoIcons()`                                                                                     |

### Routes (`src/routes/`)

All export `(ctx) => router`. Mounted under `/api/` in server.js unless noted.

| File          | Factory Line | Endpoints                                                                                                                                                                                                           |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.js`   | L7           | `GET /status`                                                                                                                                                                                                       |
| `server.js`   | L14          | `POST /server/{start,stop,kill,restart,command,stdin,regenerate-world}`                                                                                                                                             |
| `players.js`  | L14          | `GET /players/{online,all,ops,whitelist,banned}`, `GET /players/profile/:name`, `POST /players/{op,whitelist,ban,kick,say}`, `DELETE /players/{op,whitelist,ban}/:name`, `GET/POST/DELETE /players/discord-link(s)` |
| `mods.js`     | L12          | `GET /mods`, `GET /mods/lookup`, `POST /mods/toggle`, `DELETE /mods/:filename`                                                                                                                                      |
| `modrinth.js` | L14          | `GET /modrinth/{browse,search,project/:id,versions/:id,versions/batch}`, `POST /modrinth/download`                                                                                                                  |
| `modpack.js`  | L51          | `GET /modpack/export`, `POST /modpack/{analyze,import}`, `POST /modpack/mrpack/{analyze,import}`, `GET /modpack/mrpack/export`                                                                                      |
| `backups.js`  | L9           | `GET /backups`, `POST /backups`, `POST /backups/{restore,validate}`, `DELETE /backups/:filename`, `GET /backups/{schedule,lock}`, `GET /operations`                                                                 |
| `settings.js` | L23          | `GET/POST /settings/{properties,jvm-args}`, `GET/POST /config`, `GET /browse-dirs`, `POST /mkdir`, `GET /discord/status`, `POST /discord/{test-connection,test-notification,send-message}`, `GET /preflight`        |
| `users.js`    | L10          | `GET /users`, `GET /users/:email`, `PUT /users/:email/{role,admin}`, `DELETE /users/:email`, `GET /roles`                                                                                                           |
| `audit.js`    | L8           | `GET /audit-logs`                                                                                                                                                                                                   |
| `identity.js` | L15          | `GET /identity/me`, `POST /identity/link`, `GET /identity/link/status`, `DELETE /identity/link`, `GET /panel-links`, `POST /panel-link`, `DELETE /panel-link/:email`                                                |
| `health.js`   | L7           | `GET /healthz`, `GET /readyz`, `GET /metrics` (unauthenticated, mounted outside `/api/`)                                                                                                                            |

### Discord Integration (`src/integrations/discord/`)

| File               | Purpose                                                                                        | Key Locations                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `index.js`         | Bot init, chat monitor for `!link`                                                             | L44: `initDiscord()`, L192: `notifyDiscord()`                                 |
| `config.js`        | Config builder from env + config.json                                                          | Exports: `buildDiscordConfig()`                                               |
| `client.js`        | discord.js client lifecycle                                                                    | Exports: `connectDiscord()`, `disconnectDiscord()`, `registerSlashCommands()` |
| `commands.js`      | Central command router + permission checks                                                     | Exports: `handleInteraction()`, `setCommandContext()`                         |
| `registry.js`      | Command registry                                                                               | Exports: `getCommands()`, `registerCommand()`                                 |
| `permissions.js`   | Discord role → app capability resolution                                                       | Exports: `checkPermission()`                                                  |
| `links.js`         | Discord ↔ MC linking + challenge codes                                                         | L201: `createChallenge()`, L257: `verifyChallenge()`                          |
| `notifications.js` | Discord embed notifications                                                                    | Exports: `sendDiscordNotification()`                                          |
| `handlers/`        | Slash commands: status, players, start, stop, restart, say, backup, link, unlink, whoami, help |

### Frontend (`public/`)

| File                       | Purpose                        | Key Locations                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` (~1350 lines) | SPA shell: tabs, modals, menus | L12: login-modal, L103: tab-dashboard, L259: tab-console, L659: tab-mods, L748: tab-players, L799: tab-backups, L923: player-profile-modal, L989: user-profile-modal, L1023: tab-access, L1130: tab-settings, L1287: modpack-modal                                                                                                |
| `app.js` (~4800 lines)     | All frontend logic             | L25: delegated click handler (`data-action`), L161: `can()`, L168: `api()`, L618: `connectWs()`, L791: `updateDashboard()`, L1133: `loadMods()`, L1785: `loadOnlinePlayers()`, L2833: `loadBackups()`, L3519: `handleMrpackProgress()`, L3527: `handleMrpackComplete()`, L4469: `openPlayerProfile()`, L4624: `openUserProfile()` |
| `styles.css` (~2800 lines) | Dark theme, responsive layout  |                                                                                                                                                                                                                                                                                                                                   |

### Tests (`tests/`)

| File                       | What It Tests                                                         |
| -------------------------- | --------------------------------------------------------------------- |
| `auth.test.js`             | `requireSession` guard, OIDC session, demo-mode session               |
| `db.test.js`               | DB CRUD: users, audit logs, Discord/panel links (no-pool fallback)    |
| `backup.test.js`           | Backup create/list/restore/delete, disk-space checks                  |
| `audit.test.js`            | Structured logging, notification hooks                                |
| `permissions.test.js`      | Capability resolution, role mapping, admin-level conversions          |
| `validate.test.js`         | MC names, mod filenames, mrpack filenames, RCON commands, config      |
| `middleware.test.js`       | Rate limiting, CSRF, origin checks, capability guards                 |
| `metrics.test.js`          | TPS parsing, lag detection, CPU/RAM collection                        |
| `operationLock.test.js`    | Lock acquire/release, scope conflicts                                 |
| `minecraftProcess.test.js` | Process spawn, log streaming, events (flaky on Windows)               |
| `notify.test.js`           | Webhook formatting, Discord embeds, event mapping                     |
| `discord.test.js`          | Discord config, permissions, commands, linking                        |
| `pathUtils.test.js`        | `safeJoin()` path traversal prevention                                |
| `mrpack.test.js`           | .mrpack parsing, file classification                                  |
| `serverFiles.test.js`      | ops/whitelist/bans JSON CRUD, server.properties parsing               |
| `panelLinks.test.js`       | Panel ↔ MC linking                                                    |
| `routes.test.js`           | Status, server, player, mod route handlers                            |
| `serverRoutes.test.js`     | Server control routes (start/stop/restart)                            |
| `playerRoutes.test.js`     | Player management routes                                              |
| `settings.test.js`         | Settings/config endpoints                                             |
| `users.test.js`            | User management routes                                                |
| `health.test.js`           | Health check endpoints                                                |
| `identity.test.js`         | Identity/linking routes, challenge flow                               |
| `crashDetection.test.js`   | Auto-restart, restart window                                          |
| `frontend.test.js`         | HTML/CSS parsing (jsdom)                                              |
| `demoIcons.integration.js` | Modrinth API icon fetch (network-dependent, excluded from `npm test`) |
| `e2e/smoke.spec.js`        | 11 Playwright browser tests against demo mode                         |

### Deploy (`deploy/`)

| File                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `mc-manager.service` | systemd service (user: `minecraft`, 45s shutdown timeout) |
| `nginx.conf`         | Reverse proxy: SSL, WebSocket upgrade, 512MB upload limit |

## Key Patterns

### Shared Context (`ctx`)

All route files export `(ctx) => router`. The `ctx` object (built in `services.js:14`) contains: `config`, `mc` (MinecraftProcess), `rconCmd()`, `broadcast()`, `services`, `getStatus()`.

### RBAC

5 roles (viewer < operator < moderator < admin < owner) with cumulative capabilities defined in `permissions.js:135`. Routes guard with `requireCapability('server.start')` from `middleware.js:133`. Frontend checks with `can()` at `app.js:161`.

### Operation Locking

`acquireOp(scope, label)` at `operationLock.js:22` / `releaseOp(id)` at `:39` prevents concurrent destructive ops. Scopes: `'files'` (backup/restore/mod install) and `'lifecycle'` (start/stop/restart).

### WebSocket Messages

Backend broadcasts these `msg.type` values: `log`, `status`, `crash`, `mrpack-progress`, `mrpack-complete`, `panel-link-verified`. Frontend handles them in `connectWs()` at `app.js:618`.

### Demo Mode

When `config.demoMode = true`, all data comes from `demoData.js`. No real server, RCON, or file system access. All routes handle demo mode explicitly.

### Database Fallback

When `DATABASE_URL` is not set, `db.js` functions return empty results. `panelLinks.js` and `discord/links.js` use in-memory Maps. Sessions use MemoryStore.

### Validation

User input validated at route boundaries. `safeJoin()` in `pathUtils.js` prevents path traversal. `isSafeModFilename()` at `validate.js:17` for direct downloads; `isSafeMrpackFilename()` at `:28` for mrpack entries (broader: allows spaces, .zip, .jar.disabled).

### Async Modpack Import

Large mrpack imports (`modpack.js:51`) return `{ jobId }` immediately. Downloads run in background, broadcasting progress via WebSocket. Demo mode runs synchronously and returns report inline.

## Roles & Capabilities

| Role      | Level | Key Capabilities                                                   |
| --------- | ----- | ------------------------------------------------------------------ |
| viewer    | 0     | Read-only: status, logs, console, players, link_self               |
| operator  | 1     | + start, stop, restart, create_backup, broadcast                   |
| moderator | 2     | + send_console_command, manage_whitelist, manage_bans              |
| admin     | 3     | + configure, manage_files, manage_mods, restore_backup, view_links |
| owner     | 4     | + manage_users, manage_world, delete_backup                        |

## DB Tables

Defined in `db.js:15` (`SCHEMA_SQL`):

| Table           | Primary Key  | Purpose                                                   |
| --------------- | ------------ | --------------------------------------------------------- |
| `users`         | `email`      | Panel accounts (email, name, provider, role, admin_level) |
| `audit_logs`    | `id`         | Structured audit trail (action, user, ip, details JSONB)  |
| `session`       | `sid`        | Express sessions (connect-pg-simple)                      |
| `discord_links` | `discord_id` | Discord ↔ MC player links                                 |
| `panel_links`   | `user_email` | Panel ↔ MC player links                                   |

## Identity Linking

```
Panel User (email) --> Minecraft Player (name/UUID) <-- Discord User (ID)
```

Challenge-based verification: user starts challenge from Panel (`identity.js:15`) or Discord (`links.js:201`), types `!link CODE` in Minecraft chat, server log monitor in `discord/index.js` verifies and creates link.

## Config Files

- `.env` — secrets (SESSION_SECRET, OIDC creds, DATABASE_URL, DISCORD_BOT_TOKEN)
- `config.json` — app settings (serverPath, RCON, backups, notifications, discord)
- `config.example.json` — template with all options documented
- `config.lan-example.json` — LAN-only setup (local password, no OIDC)

## Production Deployment

- **Server**: ironspire.to (panel.ironspire.to)
- **Reverse proxy chain**: Raspberry Pi gateway → Server nginx → Express
- **Service**: systemd (`mc-manager.service`), user `minecraft`
- **App path**: `/home/minecraft/minecraft-manager`
- **Deploy**: `cd /home/minecraft/minecraft-manager && git pull origin master && sudo systemctl restart minecraft-manager`

## Testing Notes

- Tests use `node:test` with `node:assert/strict` — no external test framework
- Route tests mock `ctx` with fake services, test Express handlers directly
- `minecraftProcess.test.js` can be flaky on Windows (child/grandchild process management)
- Network-dependent tests are in `*.integration.js` (excluded from `npm test`)
- E2E tests run against demo mode (no real server needed)
- CI runs on Node 20 and 22; e2e only on Node 22

## Common Gotchas

- Express `json()` middleware skips `application/octet-stream` — mrpack upload uses `express.raw()` on specific route
- Nginx `client_max_body_size` must be set on all proxy layers (Pi gateway + server nginx)
- `startCommand` (string) is legacy — current config uses `launch: { executable, args[] }`
- `migrateLaunchConfig()` at `validate.js:67` auto-converts on load
- `admin_level` (0/1) is legacy — current system uses `role` column; both kept in sync by `db.js`
