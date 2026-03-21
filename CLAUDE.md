# CLAUDE.md — Minecraft Manager

> **Self-maintenance rule**: When you modify any file in this project, check whether the change affects
> this document or `README.md`. Update both in the same commit if needed. For CLAUDE.md, keep symbol
> references and structural landmarks accurate. For README.md, keep feature descriptions and role/auth
> documentation consistent with the implementation.
>
> **Pre-push rule**: ALWAYS run `npm run lint && npx prettier --check .` before committing. Fix any
> issues before pushing. CI fails on lint errors and formatting — never push without checking both.

## Source of Truth

When docs conflict, prefer implementation in this order:

1. `src/permissions.js` — roles, capabilities, permission policies
2. `server.js` — route mounting, auth boundaries, WebSocket flow, startup/shutdown
3. `src/routes/*` — API behavior
4. `src/integrations/discord/*` — Discord command and linking behavior
5. `public/app.js` + `public/index.html` — UI behavior

`README.md` may lag behind implementation. When updating auth, RBAC, or identity behavior, update README too.

## Quick Reference

- **Stack**: Node.js + Express backend, vanilla JS frontend (single-page app), PostgreSQL (optional)
- **Module system**: ESM (`"type": "module"` in package.json)
- **Node version**: >=20.19.0
- **Test runner**: `node:test` (built-in, no framework)
- **Lint/format**: ESLint 10 (flat config) + Prettier (120 col, single quotes, trailing commas)
- **Target environment**: Linux production host, systemd, Nginx reverse proxy, localhost binding. Dev/demo on Windows or Linux.

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

## High-Risk Change Checklist

If you touch **auth, RBAC, or identity linking**, review all of these — they are tightly coupled:

- `src/permissions.js` — role definitions, capability sets, permission policies
- `src/middleware.js` — `requireCapability()` route guards
- `server.js` — session payloads, guest vs authenticated route boundary
- `src/routes/identity.js` — identity linking endpoints
- `src/integrations/discord/permissions.js` — Discord role → capability resolution
- `src/integrations/discord/links.js` — challenge system, link storage
- `public/app.js` — `can()` permission gating, user/session rendering, role-based UI visibility
- Tests: `permissions.test.js`, `identity.test.js`, `discord.test.js`, `middleware.test.js`, route tests, e2e smoke

## Guest vs Authenticated Route Boundary

In `server.js`, routes are mounted in two groups. **Do not move routes between groups without understanding the security implications.**

**Guest-accessible** (before `requireSession`, ~L323): `status`, `players`, `mods`, `modrinth`, `settings` (read-only GET endpoints within these; mutating POST/PUT/DELETE endpoints use `requireCapability` internally)

**Authenticated** (after `requireSession` + CSRF, ~L338): `server`, `users`, `backups`, `modpack`, `audit`, `identity`, `environments`, `rcon/connect`

**Always unauthenticated** (mounted before all API middleware): `health` routes (`/healthz`, `/readyz`, `/metrics`)

## Frontend Warning

`public/app.js` is a single-file SPA controller (~5500 lines). `public/index.html` defines all DOM structure. They are tightly coupled:

- DOM element IDs and `data-action` attributes are referenced by name across both files
- E2E tests depend on specific selectors and UI flows
- Role-based visibility (`can()`) controls which sections/buttons appear
- If you rename or restructure DOM IDs, `data-action` values, or modal structures, you must update app.js, index.html, and e2e tests together

## File Map

### Entry Point

`server.js` — Express bootstrap, middleware stack, WebSocket server, graceful shutdown. Key structural landmarks: WebSocket server creation (~L168), middleware stack (~L249), guest route mounting (~L323), authenticated route mounting (~L338), metrics broadcast interval (~L184), `gracefulShutdown()` (~L516).

### Core Modules (`src/`)

| File                  | Purpose                                             | Key Exports                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.js`             | OIDC (Google/Microsoft) + local password auth       | `buildSessionMiddleware()`, `buildAuthRouter()`, `requireSession`                                                                                                                                                                                                                                    |
| `permissions.js`      | RBAC engine: 5 roles, 31 capabilities, 3 policies   | `CAPABILITIES`, `ROLES`, `ROLE_ORDER`, `getCapabilitiesForRole()`, `setCapabilityOverrides()`, `getDefaultCapabilitiesForRole()`, `resolveEffectivePermissions()`                                                                                                                                    |
| `middleware.js`       | Helmet, rate limiting, CSRF, origin checks          | `buildCsrfCheck()`, `requireCapability()`, `buildSameOriginCheck()`, `checkWsOrigin()`                                                                                                                                                                                                               |
| `db.js`               | PostgreSQL schema + CRUD helpers                    | `initDatabase()`, `upsertUser()`, `insertAuditLog()`, `upsertDiscordLink()`, `upsertPanelLink()`                                                                                                                                                                                                     |
| `audit.js`            | Structured JSON logging + DB audit trail            | `audit()`, `info()`, `warn()`, `setNotifyHook()`                                                                                                                                                                                                                                                     |
| `services.js`         | Creates shared `ctx` object                         | `createServices()`                                                                                                                                                                                                                                                                                   |
| `minecraftProcess.js` | Child process, log streaming (2000-line buffer)     | `class MinecraftProcess` — `start()`, `stop()`, `kill()`, `sendConsoleCommand()`                                                                                                                                                                                                                     |
| `rcon.js`             | Source RCON protocol client                         | `class RconClient` — `connect()`, `sendCommand()`, `disconnect()`                                                                                                                                                                                                                                    |
| `operationLock.js`    | Mutex for destructive ops                           | `acquireOp()`, `releaseOp()`, `getActiveOps()`                                                                                                                                                                                                                                                       |
| `backup.js`           | tar.gz backup/restore, cron scheduling              | `createBackup()`, `restoreBackup()`, `listBackups()`, `initBackupScheduler()`                                                                                                                                                                                                                        |
| `environments.js`     | Multi-environment management, migration, resolution | `ENV_KEYS`, `validateEnvironmentId()`, `validateEnvironmentConfig()`, `slugify()`, `migrateToEnvironments()`, `resolveConfig()`, `getSelectedConfig()`, `getSelectedEnvId()`, `listEnvironments()`, `createEnvironment()`, `updateEnvironment()`, `deleteEnvironment()`, `switchActiveEnvironment()` |
| `metrics.js`          | TPS, CPU, RAM, disk, player count                   | `collectMetrics()`, `parseTps()`, `collectDemoMetrics()`, `resetCaches()`                                                                                                                                                                                                                            |
| `notify.js`           | Webhook + Discord notifications                     | `initNotifications()`, `onAuditEvent()`, `notifyLagSpike()`                                                                                                                                                                                                                                          |
| `validate.js`         | Input validation & config migration                 | `isValidMinecraftName()`, `isSafeModFilename()`, `isSafeMrpackFilename()`, `validateConfig()`, `parseLaunchCommand()`, `migrateLaunchConfig()`                                                                                                                                                       |
| `preflight.js`        | Runtime diagnostic checks                           | `runPreflight()`                                                                                                                                                                                                                                                                                     |
| `pathUtils.js`        | Path traversal prevention                           | `safeJoin()`                                                                                                                                                                                                                                                                                         |
| `serverFiles.js`      | CRUD for MC server JSON files & mods                | `getOps()`, `getWhitelist()`, `getServerProperties()`, `listMods()`, `hashMods()`, `saveMod()`                                                                                                                                                                                                       |
| `modrinth.js`         | Modrinth API v2 wrapper                             | `searchMods()`, `lookupByHashes()`, `downloadModFile()`, `getVersion()`, `getVersionsBatch()`                                                                                                                                                                                                        |
| `mrpack.js`           | .mrpack ZIP parsing & building                      | `parseMrpack()`, `buildMrpack()`, `analyzeForServer()`, `classifyEntry()`, `extractOverrides()`                                                                                                                                                                                                      |
| `panelLinks.js`       | Panel user ↔ MC player linking                      | `setLink()`, `getLink()`, `removeLink()`, `getLinkByMinecraftName()`                                                                                                                                                                                                                                 |
| `demoData.js`         | Seed data for demo mode                             | `DEMO_ONLINE_PLAYERS`, `DEMO_MODS`, `DEMO_OPS`, `DEMO_ENVIRONMENTS`, `enrichDemoIcons()`                                                                                                                                                                                                             |

### Routes (`src/routes/`)

All export `(ctx) => router`. Mounted under `/api/` in server.js unless noted.

| File              | Endpoints                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.js`       | `GET /status`                                                                                                                                                                                                       |
| `server.js`       | `POST /server/{start,stop,kill,restart,command,stdin,regenerate-world}`                                                                                                                                             |
| `players.js`      | `GET /players/{online,all,ops,whitelist,banned}`, `GET /players/profile/:name`, `POST /players/{op,whitelist,ban,kick,say}`, `DELETE /players/{op,whitelist,ban}/:name`, `GET/POST/DELETE /players/discord-link(s)` |
| `mods.js`         | `GET /mods`, `GET /mods/lookup`, `POST /mods/toggle`, `DELETE /mods/:filename`                                                                                                                                      |
| `modrinth.js`     | `GET /modrinth/{browse,search,project/:id,versions/:id,versions/batch}`, `POST /modrinth/download`. Browse/search support `excludeSlugs` for server-side installed-mod filtering with guaranteed page sizes.        |
| `modpack.js`      | `GET /modpack/export`, `POST /modpack/{analyze,import}`, `POST /modpack/mrpack/{analyze,import}`, `GET /modpack/mrpack/export`                                                                                      |
| `backups.js`      | `GET /backups`, `POST /backups`, `POST /backups/{restore,validate}`, `DELETE /backups/:filename`, `GET /backups/{schedule,lock}`, `GET /operations`                                                                 |
| `settings.js`     | `GET/POST /settings/{properties,jvm-args}`, `GET/POST /config`, `GET /browse-dirs`, `POST /mkdir`, `GET /discord/status`, `POST /discord/{test-connection,test-notification,send-message}`, `GET /preflight`        |
| `users.js`        | `GET /users`, `GET /users/:email`, `PUT /users/:email/{role,admin}`, `DELETE /users/:email`, `GET /roles`, `PUT /roles/capabilities`                                                                                |
| `environments.js` | `GET/POST /environments`, `GET/PUT/DELETE /environments/:id`, `POST /environments/:id/deploy`, `POST /environments/select`                                                                                          |
| `audit.js`        | `GET /audit-logs`                                                                                                                                                                                                   |
| `identity.js`     | `GET /identity/me`, `POST /identity/link`, `GET /identity/link/status`, `DELETE /identity/link`, `GET /panel-links`, `POST /panel-link`, `DELETE /panel-link/:email`                                                |
| `health.js`       | `GET /healthz`, `GET /readyz`, `GET /metrics` (unauthenticated, mounted outside `/api/`)                                                                                                                            |

### Discord Integration (`src/integrations/discord/`)

| File               | Purpose                                                                                        | Key Exports                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `index.js`         | Bot init, chat monitor for `!link`                                                             | `initDiscord()`, `notifyDiscord()`, `getDiscordStatus()`              |
| `config.js`        | Config builder from env + config.json                                                          | `buildDiscordConfig()`                                                |
| `client.js`        | discord.js client lifecycle                                                                    | `connectDiscord()`, `disconnectDiscord()`, `registerSlashCommands()`  |
| `commands.js`      | Central command router + permission checks                                                     | `handleInteraction()`, `setCommandContext()`                          |
| `registry.js`      | Command registry                                                                               | `getCommands()`, `registerCommand()`                                  |
| `permissions.js`   | Discord role → app capability resolution                                                       | `checkPermission()`                                                   |
| `links.js`         | Discord ↔ MC linking + challenge codes                                                         | `createChallenge()`, `verifyChallenge()`, `setLink()`, `removeLink()` |
| `notifications.js` | Discord embed notifications                                                                    | `sendDiscordNotification()`                                           |
| `handlers/`        | Slash commands: status, players, start, stop, restart, say, backup, link, unlink, whoami, help |                                                                       |

### Frontend (`public/`)

| File                       | Purpose                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` (~1480 lines) | SPA shell: 7 tabs (dashboard, console, mods, players, backups, access control, settings), 10+ modals (login, player profile, user profile, modpack, version picker, env create/edit, deploy, etc.), user menu, environment selector |
| `app.js` (~5500 lines)     | All frontend logic: delegated click handler (`data-action`), `can()` permission check, `api()` fetch wrapper, `connectWs()` WebSocket, tab/modal management, environment management, all data loading and rendering functions       |
| `styles.css` (~2970 lines) | Dark theme, responsive layout                                                                                                                                                                                                       |

### Tests (`tests/`)

| File                        | What It Tests                                                                  |
| --------------------------- | ------------------------------------------------------------------------------ |
| `auth.test.js`              | `requireSession` guard, OIDC session, demo-mode session                        |
| `db.test.js`                | DB CRUD: users, audit logs, Discord/panel links (no-pool fallback)             |
| `backup.test.js`            | Backup create/list/restore/delete, disk-space checks                           |
| `audit.test.js`             | Structured logging, notification hooks                                         |
| `permissions.test.js`       | Capability resolution, role mapping, admin-level conversions                   |
| `validate.test.js`          | MC names, mod filenames, mrpack filenames, RCON commands, config, environments |
| `middleware.test.js`        | Rate limiting, CSRF, origin checks, capability guards                          |
| `metrics.test.js`           | TPS parsing, lag detection, CPU/RAM collection                                 |
| `operationLock.test.js`     | Lock acquire/release, scope conflicts                                          |
| `minecraftProcess.test.js`  | Process spawn, log streaming, events (flaky on Windows)                        |
| `notify.test.js`            | Webhook formatting, Discord embeds, event mapping                              |
| `discord.test.js`           | Discord config, permissions, commands, linking                                 |
| `pathUtils.test.js`         | `safeJoin()` path traversal prevention                                         |
| `mrpack.test.js`            | .mrpack parsing, file classification                                           |
| `serverFiles.test.js`       | ops/whitelist/bans JSON CRUD, server.properties parsing                        |
| `panelLinks.test.js`        | Panel ↔ MC linking                                                             |
| `routes.test.js`            | Status, server, player, mod route handlers                                     |
| `serverRoutes.test.js`      | Server control routes (start/stop/restart)                                     |
| `playerRoutes.test.js`      | Player management routes                                                       |
| `settings.test.js`          | Settings/config endpoints                                                      |
| `users.test.js`             | User management routes                                                         |
| `health.test.js`            | Health check endpoints                                                         |
| `identity.test.js`          | Identity/linking routes, challenge flow                                        |
| `environments.test.js`      | Environment migration, resolution, CRUD, validation, slugification             |
| `environmentRoutes.test.js` | Environment REST API endpoints, permission checks, deploy flow                 |
| `crashDetection.test.js`    | Auto-restart, restart window                                                   |
| `frontend.test.js`          | HTML/CSS parsing (jsdom)                                                       |
| `demoIcons.integration.js`  | Modrinth API icon fetch (network-dependent, excluded from `npm test`)          |
| `e2e/smoke.spec.js`         | Playwright browser tests against demo mode                                     |

### Deploy (`deploy/`)

| File                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `mc-manager.service` | systemd service (user: `minecraft`, 45s shutdown timeout) |
| `nginx.conf`         | Reverse proxy: SSL, WebSocket upgrade, 512MB upload limit |

## Key Patterns

### Shared Context (`ctx`)

All route files export `(ctx) => router`. The `ctx` object (built in `services.js` → `createServices()`) contains: `config` (materialized active env), `rawConfig` (full config with all environments), `mc` (MinecraftProcess), `rconCmd()`, `broadcast()`, `services`, `getStatus()`, `switchEnvironment()`, `saveRawConfig()`, `saveEnvConfig()`.

### RBAC

5 roles (viewer < operator < moderator < admin < owner) with cumulative capabilities defined in `permissions.js` → `ROLES`. Routes guard with `requireCapability()` from `middleware.js`. Frontend checks with `can()` in `app.js`. Owners can customize which capabilities each role grants via the Access Control → Role Reference UI or `PUT /roles/capabilities`. Overrides are stored in `config.json` → `authorization.capabilityOverrides` as `{ roleName: { add: [], remove: [] } }` diffs from defaults. Safety: `panel.view` can never be removed; `panel.manage_users` can never be removed from owner.

### Operation Locking

`acquireOp(scope, label)` / `releaseOp(id)` in `operationLock.js` prevents concurrent destructive ops. Scopes: `'files'` (backup/restore/mod install) and `'lifecycle'` (start/stop/restart).

### WebSocket Messages

Backend broadcasts these `msg.type` values: `log`, `status`, `crash`, `mrpack-progress`, `mrpack-complete`, `panel-link-verified`, `environment-switched`. Frontend handles them in `connectWs()` in `app.js`.

### Multi-Environment

`environments.js` manages multiple server environments (production, staging, testing, etc.) with isolated configs. Only one server runs at a time. Key concepts:

- **Active environment**: deployed/running, targeted by runtime operations (start/stop, RCON, console)
- **Selected environment**: UI context for browsing/configuring, stored in `req.session.selectedEnvironment`
- **`resolveConfig(rawConfig, envId)`**: materializes an environment's per-env keys onto shared top-level keys, producing a flat config object identical to the legacy shape — zero changes in code that reads `ctx.config.serverPath`
- **`getSelectedConfig(ctx, req)`**: returns the materialized config for the user's currently selected environment
- **Per-env keys** (`ENV_KEYS`): `serverPath`, `launch`, `rconHost`, `rconPort`, `rconPassword`, `minecraftVersion`, `modsFolder`, `disabledModsFolder`, `serverAddress`, `autoStart`, `autoRestart`, `tpsAlertThreshold`
- **Auto-migration**: `migrateToEnvironments()` converts legacy flat config → `{ environments: { default: {...} }, activeEnvironment: 'default' }` on startup
- File-based routes (mods, modpack, settings, players) use `getSelectedConfig()` for serverPath; RCON commands only sent when editing the active environment

### Demo Mode

When `config.demoMode = true`, all data comes from `demoData.js`. No real server, RCON, or file system access. All routes handle demo mode explicitly.

### Database Fallback

When `DATABASE_URL` is not set, `db.js` functions return empty results. `panelLinks.js` and `discord/links.js` use in-memory Maps. Sessions use MemoryStore.

### Validation

User input validated at route boundaries. `safeJoin()` in `pathUtils.js` prevents path traversal. `isSafeModFilename()` for direct downloads; `isSafeMrpackFilename()` for mrpack entries (broader: allows spaces, .zip, .jar.disabled).

### Async Modpack Import

Large mrpack imports return `{ jobId }` immediately from `modpack.js` route. Downloads run in background, broadcasting progress via WebSocket. Modrinth hash lookup filters client-only mods before downloading. Demo mode runs synchronously and returns report inline.

## Roles & Capabilities

Default capabilities (owners can customize per-role via Access Control UI):

| Role      | Level | Key Capabilities (defaults)                                        |
| --------- | ----- | ------------------------------------------------------------------ |
| viewer    | 0     | Read-only: status, logs, console, players, link_self               |
| operator  | 1     | + start, stop, restart, create_backup, broadcast                   |
| moderator | 2     | + send_console_command, manage_whitelist, manage_bans              |
| admin     | 3     | + configure, manage_files, manage_mods, restore_backup, view_links |
| owner     | 4     | + manage_users, manage_world, delete_backup, environments.manage   |

## DB Tables

Defined in `db.js` → `SCHEMA_SQL`:

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

Challenge-based verification: user starts challenge from Panel (`identity.js`) or Discord (`links.js` → `createChallenge()`), types `!link CODE` in Minecraft chat, server log monitor in `discord/index.js` verifies and creates link.

## Config Files

- `.env` — secrets (SESSION_SECRET, OIDC creds, DATABASE_URL, DISCORD_BOT_TOKEN)
- `config.json` — app settings (serverPath, RCON, backups, notifications, discord, authorization.capabilityOverrides)
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
- `migrateLaunchConfig()` in `validate.js` auto-converts on load
- `admin_level` (0/1) is legacy — current system uses `role` column; both kept in sync by `db.js`
