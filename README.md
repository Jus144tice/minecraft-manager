# Minecraft Manager

A self-hosted web control panel for a Minecraft Forge server running on Linux. Built for small modpacks (tested with ~200 mods) and a small group of players (2–8).

**Defaults to demo mode** — clone, install, and run to see a fully working demo with seed data. No Minecraft server required to try it out. Disable demo mode in Settings when you're ready to connect for real.

**License:** [Apache 2.0](LICENSE)

**Features:**

- Start / stop / restart the server from a browser
- Live streaming console with command input (via RCON)
- Mod manager — enable/disable mods, identify client vs server vs both-sided mods via Modrinth, browse and download new mods directly from Modrinth. Client-only mods are always excluded — they can't run server-side.
- Player management — operators (with permission levels 1–4), whitelist, bans
- Edit `server.properties` in the browser
- OIDC authentication (Google and/or Microsoft) with email allowlist; optional local password fallback
- Role-based access — five granular roles (Viewer, Operator, Moderator, Admin, Owner) with 30 capabilities; first OIDC user auto-promoted to admin
- WebSocket-based live log streaming
- Full backup & restore — scheduled nightly (configurable cron), quiesced snapshots via RCON, disk-space preflight checks, concurrent-operation locking. Restore to any point in time from the Backups tab.
- **Discord bot integration** — slash commands (`/status`, `/start`, `/stop`, `/restart`, `/backup`, `/players`, `/say`) with role-based permissions, plus automatic notifications for server events. See [DISCORD.md](DISCORD.md) for setup.
- Webhook notifications — server crashes, auto-restarts, backups, lag spikes, player bans/kicks, and mod changes delivered to Discord webhooks or any HTTP endpoint
- Ops endpoints — `/healthz`, `/readyz`, and `/metrics` (Prometheus format) for systemd, Nginx, UptimeRobot, or Prometheus/Grafana
- TPS monitoring with configurable lag-spike alerts and auto-restart on crash
- Preflight self-checks — Dashboard warns about missing RCON, bad backup path, insecure bind settings, and other common misconfigurations
- Production-ready deploy files — example systemd unit and Nginx reverse proxy config in `deploy/`

---

## Requirements

| Requirement            | Notes                                  |
| ---------------------- | -------------------------------------- |
| Ubuntu 22.04 or newer  | Any modern Linux should work           |
| Node.js 20 or newer    | Used to run the web panel              |
| Java 17 or newer       | Already needed for Minecraft Forge     |
| Minecraft Forge server | Pre-installed and able to run manually |

---

## Quick start (demo mode)

The app ships in demo mode by default. You can run it immediately after cloning — no Minecraft server needed:

```bash
git clone https://github.com/Jus144tice/minecraft-manager.git
cd minecraft-manager
npm install
cp config.example.json config.json
npm start
# Open http://localhost:3000 — no login required in demo mode
```

You'll see a fully interactive UI with seed data: 22 server-compatible mods with client/server/both tags, a paginated Modrinth browse list, online players, ops, whitelist, bans, and a live-scrolling simulated Forge console. Modrinth search and mod install flows use the real Modrinth API even in demo mode.

When you're ready to connect to a real server, follow the **Configuration** and **Production deployment** sections below, then uncheck **Demo Mode** in **Settings → App Config** and save.

---

## Installation

### 1. Install Node.js on Ubuntu

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:

```bash
node --version   # should be v20 or higher
```

### 2. Clone the repo

```bash
git clone https://github.com/Jus144tice/minecraft-manager.git
cd minecraft-manager
npm install
```

### 3. Create config.json

```bash
cp config.example.json config.json
nano config.json
```

---

## Configuration

### config.json

Fill in `config.json` (copy from `config.example.json`):

```jsonc
{
  // Absolute path to the folder where Minecraft Forge is installed
  "serverPath": "/home/minecraft/server",

  // RCON settings — must match server.properties (see below)
  "rconHost": "127.0.0.1",
  "rconPort": 25575,
  "rconPassword": "pick-a-strong-password",

  // Port the web panel listens on
  "webPort": 3000,

  // Bind address — 127.0.0.1 (default, production) or 0.0.0.0 (LAN testing only)
  // See "Binding & network access" below
  "bindHost": "127.0.0.1",

  // Structured launch config (see "Finding your start command" below)
  "launch": {
    "executable": "java",
    "args": ["-Xms2G", "-Xmx8G", "@user_jvm_args.txt", "@libraries/net/.../unix_args.txt", "nogui"],
  },

  // Minecraft version — used to filter Modrinth search results
  "minecraftVersion": "1.20.1",

  // Mods folders (relative to serverPath)
  "modsFolder": "mods",
  "disabledModsFolder": "mods_disabled",

  // Auto-start the Minecraft server when the manager starts (recommended for systemd service)
  "autoStart": true,

  // Auto-restart on crash (with exponential backoff)
  "autoRestart": true,

  // TPS lag-spike alert threshold (20 = perfect; below this triggers notifications)
  "tpsAlertThreshold": 18,

  // Backups — all settings can also be changed in Settings → App Config
  "backupEnabled": true, // enable scheduled backups
  "backupSchedule": "0 3 * * *", // cron expression (default: daily at 3 AM)
  "backupPath": "/mnt/backups/minecraft", // where to store backup archives
  "maxBackups": 14, // keep last N scheduled backups (0 = keep all)

  // Webhook notifications (Discord or generic JSON POST)
  "notifications": {
    "webhookUrl": "", // Discord webhook URL or any HTTP endpoint
    "events": [
      "SERVER_CRASH",
      "SERVER_AUTO_RESTART",
      "SERVER_START",
      "SERVER_STOP",
      "BACKUP_CREATE",
      "BACKUP_FAILED",
      "LAG_SPIKE",
      "PLAYER_BAN",
      "PLAYER_KICK",
    ],
  },

  // Set to false to connect to your real server; restart the panel after changing
  "demoMode": false,
}
```

> **Note:** `rconPassword` is stored in `config.json` on the server. It is never sent to the browser. `config.json` is in `.gitignore`.

### Binding & network access

The `bindHost` setting controls which network interfaces the web panel listens on:

| Mode                     | `bindHost`  | Who can reach it                                    | Use case                                                             |
| ------------------------ | ----------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| **Production** (default) | `127.0.0.1` | Localhost only — requires Nginx/Caddy reverse proxy | Internet-facing deployment with HTTPS                                |
| **LAN testing**          | `0.0.0.0`   | Any device on the local network                     | Trying the panel from your phone or another PC on a trusted home LAN |

**Production (recommended):** Leave `bindHost` at `127.0.0.1` and put Nginx or Caddy in front (see [Nginx reverse proxy](#nginx-reverse-proxy) below). This is the default and the only safe option for internet-facing deployments.

**Temporary LAN testing:** Set `bindHost` to `0.0.0.0` to access the panel from other devices on your home network (e.g. `http://192.168.1.50:3000`). A startup warning is printed when this is active outside of demo mode. A ready-made config for LAN testing is provided:

```bash
cp config.lan-example.json config.json
```

> **Switch back to `127.0.0.1` before deploying to production.** Binding to `0.0.0.0` without a reverse proxy exposes the panel without HTTPS, making session cookies and credentials vulnerable on untrusted networks.

### Environment variables

Secrets and deployment settings are configured via environment variables (not `config.json`). Copy `.env.example` to `.env` for local development:

```bash
cp .env.example .env
nano .env
```

| Variable                  | Required                 | Description                                                                                                                                                               |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`          | Yes (production)         | Long random string for signing session cookies. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`                                      |
| `TRUST_PROXY`             | Yes (behind Nginx/Caddy) | Set to `1` — enables correct client IP detection and secure cookies                                                                                                       |
| `APP_URL`                 | Yes (OIDC)               | Public base URL, e.g. `https://mc.example.com` — must match OIDC callback URLs                                                                                            |
| `ALLOWED_EMAILS`          | Recommended              | Comma-separated list of emails allowed to log in, e.g. `you@gmail.com,family@outlook.com`. Leave empty to allow any authenticated account.                                |
| `GOOGLE_CLIENT_ID`        | One provider required    | From Google Cloud Console                                                                                                                                                 |
| `GOOGLE_CLIENT_SECRET`    | One provider required    | From Google Cloud Console                                                                                                                                                 |
| `MICROSOFT_CLIENT_ID`     | One provider required    | From Azure Portal                                                                                                                                                         |
| `MICROSOFT_CLIENT_SECRET` | One provider required    | From Azure Portal                                                                                                                                                         |
| `MICROSOFT_TENANT`        | Optional                 | `common` (default), `consumers`, or a tenant ID                                                                                                                           |
| `LOCAL_PASSWORD`          | Optional                 | Fallback password login. Rate-limited to 20 attempts/15 min.                                                                                                              |
| `DATABASE_URL`            | Optional                 | PostgreSQL connection string. Enables persistent sessions, user management with admin levels, and queryable audit logs. See [Database setup](#database-postgresql) below. |
| `BIND_HOST`               | Optional                 | Override `bindHost` from config.json (e.g. `127.0.0.1` or `0.0.0.0`). Useful for switching between production and LAN testing without editing config.                     |
| `WEB_PORT`                | Optional                 | Override `webPort` from config.json.                                                                                                                                      |

In production, set these in the systemd service file (see below) rather than a `.env` file.

> **Note:** `BIND_HOST` and `WEB_PORT` take precedence over their `config.json` equivalents when set. All other settings (`serverPath`, `rconPort`, `launch`, etc.) are configured exclusively in `config.json`.

### Enable RCON in server.properties

Open `server.properties` inside your Minecraft server folder and set:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=pick-a-strong-password
```

> The `rcon.password` must exactly match `rconPassword` in `config.json`. RCON lets the panel send commands (op, ban, whitelist, say, etc.) to a running server in real time.

### Database (PostgreSQL)

A PostgreSQL database is **optional**. Without one, the app works exactly as before (sessions in memory, audit logs to stdout only). With one, you get:

- **Persistent sessions** — survive server restarts (no more logging everyone out on redeploy)
- **User management** — tracks every user who logs in with a role (viewer, operator, moderator, admin, or owner)
- **Queryable audit logs** — every action (login, server start/stop, mod install, ban, etc.) stored with timestamps and searchable via the API

#### Install PostgreSQL

```bash
sudo apt install -y postgresql
sudo systemctl enable postgresql
```

#### Create the database and user

```bash
sudo -u postgres psql
```

```sql
CREATE USER mcmanager WITH PASSWORD 'pick-a-strong-password';
CREATE DATABASE mcmanager OWNER mcmanager;
\q
```

#### Set the connection string

Add `DATABASE_URL` to your `.env` (development) or systemd service file (production):

```
DATABASE_URL=postgres://mcmanager:pick-a-strong-password@localhost:5432/mcmanager
```

Tables are created automatically on first startup — no manual migration step needed.

#### Roles

Access is controlled by five roles, each adding capabilities on top of the previous:

| Role          | Level | Access                                                                                |
| ------------- | ----- | ------------------------------------------------------------------------------------- |
| **Viewer**    | 0     | Read-only: dashboard, console output, player lists, mod list, server status           |
| **Operator**  | 1     | + start/stop/restart server, create backups, broadcast messages                       |
| **Moderator** | 2     | + send console commands, manage whitelist and bans                                    |
| **Admin**     | 3     | + configure panel/server, manage mods and files, restore backups, view identity links |
| **Owner**     | 4     | + manage users and roles, regenerate worlds, delete backups                           |

**Automatic role assignment:**

| Login method                           | Role         | Why                                                                                                              |
| -------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Demo mode** (any password)           | Always owner | Full access needed to demo the UI                                                                                |
| **Local password** (`LOCAL_PASSWORD`)  | Always admin | You have the server password — you're the admin                                                                  |
| **First OIDC user** (Google/Microsoft) | Auto-owner   | When no admins exist in the database yet, the first person to log in via OIDC is automatically promoted to owner |

**Manual promotion** (for additional admins after the first):

Once you're logged in as an owner, promote other users from the Access Control tab, or via the API:

```bash
curl -X PUT http://localhost:3000/api/users/friend@gmail.com/role \
  -H 'Content-Type: application/json' \
  -H 'X-CSRF-Token: <token>' \
  -H 'Cookie: mcm.sid=<session>' \
  -d '{"role": "admin"}'
```

Or connect to the database directly:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@gmail.com';
```

---

### Find your start command

**Modern Forge (1.17+)** generates a `run.sh` script in the server folder:

```bash
cat /home/minecraft/server/run.sh
```

It will look something like:

```
java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt "$@"
```

Use this to build your `launch` config in `config.json` — set the executable to `java` and list each argument separately:

```json
"launch": {
  "executable": "java",
  "args": ["-Xms2G", "-Xmx8G", "@user_jvm_args.txt", "@libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt", "nogui"]
}
```

**Old Forge (pre-1.17):**

```
java -Xms2G -Xmx8G -jar forge-1.16.5-36.2.39.jar nogui
```

**Memory recommendation for a 12 GB machine:**
Use `-Xms2G -Xmx8G` — leaves ~4 GB for the OS, the web panel, and JVM overhead (permgen, metaspace, off-heap). `-Xmx10G` is too aggressive: it crowds out the OS and the Node process, especially under GC pressure with 200+ mods.

---

## Running

### Start manually (development only)

```bash
npm start
# Open http://localhost:3000
```

For auto-restart on file changes:

```bash
npm run dev
```

### Run as a systemd service (production)

In production, you want the manager **and** the Minecraft server to start automatically on boot and shut down gracefully on reboot. The manager handles both:

1. **On start** — if `autoStart` is `true` in `config.json`, the manager launches the Minecraft server and connects RCON automatically
2. **On stop** (reboot, `systemctl stop`, etc.) — the manager sends `save-all` + `stop` to Minecraft via RCON, waits up to 30 seconds for a clean exit, then shuts itself down

This means you only need **one systemd service** — the manager — and it takes care of everything.

#### 1. Enable auto-start in config.json

Set `autoStart` to `true` (or toggle it in **Settings → App Config** in the UI):

```json
{
  "demoMode": false,
  "autoStart": true,
  "serverPath": "/home/minecraft/server",
  "launch": { "executable": "java", "args": ["-Xms2G", "-Xmx8G", "@user_jvm_args.txt", "..."] },
  ...
}
```

#### 2. Create the systemd service file

A ready-to-use service file is included in the repo. Copy it, fill in your secrets, and enable:

```bash
sudo cp deploy/mc-manager.service /etc/systemd/system/mc-manager.service
sudo nano /etc/systemd/system/mc-manager.service   # fill in SESSION_SECRET, auth, etc.
```

Secrets go directly in the service file — they are readable only by root and the service user, and never committed to git. See `deploy/mc-manager.service` for all available options.

#### 3. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable mc-manager    # start on boot
sudo systemctl start mc-manager     # start now
```

#### 4. Check status and logs

```bash
sudo systemctl status mc-manager
sudo journalctl -u mc-manager -f
```

#### What happens on boot

1. System boots → systemd starts `mc-manager.service`
2. Manager loads `config.json`, starts the web panel on port 3000
3. Manager auto-starts the Minecraft server process (if `autoStart: true`)
4. Manager connects RCON after ~15 seconds (retries for up to 2 minutes)
5. Web panel is live — you can manage everything from the browser

#### What happens on shutdown

1. `systemctl stop mc-manager` (or system reboot) sends `SIGTERM`
2. Manager broadcasts "Server shutting down..." to online players
3. Manager runs `save-all` to flush world data, waits 2 seconds
4. Manager sends `stop` to Minecraft via RCON (falls back to stdin if RCON is down)
5. Waits up to 30 seconds for Minecraft to exit cleanly
6. If Minecraft doesn't stop, force-kills it
7. Closes all WebSocket connections and the HTTP server
8. Exits cleanly — systemd sees exit code 0

> **Note:** You can still start/stop the Minecraft server manually from the Dashboard at any time. Auto-start only applies when the manager itself starts up (boot or `systemctl restart`).

---

## Production deployment

The web panel binds to `127.0.0.1` only and is not safe to expose directly. In production, put it behind an HTTPS reverse proxy (Nginx, Caddy, etc.) and configure OIDC authentication.

### OIDC setup

At least one OIDC provider is required in production. Both can be configured simultaneously — the login screen shows whichever buttons are available.

#### Google

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an **OAuth 2.0 Client ID** (type: Web application)
3. Add an **Authorized redirect URI**: `https://mc.example.com/auth/callback/google`
4. Copy the Client ID and Client Secret into your systemd service file

#### Microsoft

1. Go to [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps)
2. Create a new registration (supported account types: personal + work/school = "common")
3. Add a **Redirect URI** (Web platform): `https://mc.example.com/auth/callback/microsoft`
4. Under **Certificates & secrets**, create a new client secret
5. Copy the Application (client) ID and secret into your systemd service file

> **ALLOWED_EMAILS**: Always set this to your own email(s). Without it, anyone who successfully authenticates with Google or Microsoft can access the panel.

### Nginx reverse proxy

A ready-to-use Nginx config is included in the repo. Install Nginx and Certbot, then copy and enable:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mc-manager
sudo nano /etc/nginx/sites-available/mc-manager   # change server_name to your domain
sudo ln -s /etc/nginx/sites-available/mc-manager /etc/nginx/sites-enabled/
sudo certbot --nginx -d mc.example.com
sudo nginx -t && sudo systemctl reload nginx
```

See `deploy/nginx.conf` for the full configuration including WebSocket support, SSL, and health check passthrough.

### Firewall

Only ports 22 (SSH), 80 (HTTP redirect), 443 (HTTPS), and 25565 (Minecraft game) need to be publicly reachable. Close everything else:

```bash
sudo ufw default deny incoming
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 25565/tcp   # Minecraft game port
sudo ufw enable
```

The web panel port (3000) and RCON port (25575) must **not** be opened — they are only used on localhost.

---

## Authentication

In production, log in via **Google** or **Microsoft**. The OIDC flow:

1. Click the provider button → redirected to Google/Microsoft
2. Authenticate → redirected back to `APP_URL/auth/callback/<provider>`
3. Email checked against `ALLOWED_EMAILS` (if set)
4. Session cookie set (httpOnly, SameSite=lax, Secure behind HTTPS)

A **local password** login is available as a fallback if `LOCAL_PASSWORD` is set. It is rate-limited to 20 attempts per 15 minutes per IP.

In **demo mode**, no login is required. Demo mode is for local development only — do not deploy with `"demoMode": true` behind a public URL.

### Roles & permissions

Every user has one of five roles (cumulative — each role includes all capabilities of the roles below it):

| Role          | Access                                                                                |
| ------------- | ------------------------------------------------------------------------------------- |
| **Viewer**    | Read-only — dashboard, console output, player lists, mod list, server status          |
| **Operator**  | + start/stop/restart server, create backups, broadcast messages                       |
| **Moderator** | + send console commands, manage whitelist and bans                                    |
| **Admin**     | + configure panel/server, manage mods and files, restore backups, view identity links |
| **Owner**     | + manage users and roles, regenerate worlds, delete backups                           |

**How roles are assigned:**

- The **first user** to log in via Google or Microsoft OIDC is **automatically promoted to owner** (so you don't get locked out of your own panel).
- All subsequent OIDC users start as **Viewer**.
- **Local password** login (`LOCAL_PASSWORD`) always grants **Admin** access.
- In **demo mode**, everyone is Owner.

**How to change a user's role:**

1. Log in as an **Owner**.
2. Go to the **Access Control → Users** tab.
3. Find the user and select their new role from the dropdown.

You can also use the API (`PUT /api/users/:email/role` with body `{ "role": "admin" }`) or update the database directly (`UPDATE users SET role = 'admin' WHERE email = '...'`).

> **Note:** Roles require a PostgreSQL database (`DATABASE_URL`). Without a database, session data is stored in memory and all OIDC users get the default role (Viewer). Use `LOCAL_PASSWORD` for single-admin setups without a database.

---

## Using the Panel

### Dashboard

- **Start / Stop / Restart** — controls the Minecraft server process
- **Force Kill** — sends SIGKILL if the server is frozen (last resort)
- **Broadcast** — sends a message to all online players via `/say`
- **Online Players** — auto-populates on page load; shows who is online with a quick kick button

### Console

- Streams the server log in real time via WebSocket
- Type commands in the input bar and press Enter — sent via RCON while the server is running

### Mods tab

#### Installed Mods

Lists every `.jar` in your `mods/` folder. Client-only mods are never shown here — they cannot run server-side. You can:

- **Enable / Disable** — disabled mods are moved to `mods_disabled/` and not loaded by Forge
- **Delete** — permanently removes the file
- **Filter** by name or by side (server-only / both / unknown)
- **Identify Mods (Modrinth)** — hashes every `.jar` via SHA1, looks them all up on Modrinth in bulk, and tags each mod as:
  - **Both** — required on client and server (most content mods)
  - **Server-only** — only belongs in the server's mods folder
  - **Unknown** — not found on Modrinth (likely a custom or CurseForge-only mod)

> In demo mode, mods are pre-identified automatically and the Identify button is hidden.

#### Browse Modrinth

- Opens to a paginated list of popular server-compatible Forge mods by download count
- Search by name to filter results
- Filter by side (any / server-only / client+server)
- Client-only mods are excluded from all results — they can't run on a server
- Click **Install** to pick a version and download it directly into the server's `mods/` folder

### Players tab

| Sub-tab       | What it does                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Operators** | Add/remove ops. Level 4 = full admin, Level 3 = moderator (kick/ban), Level 2 = most commands, Level 1 = bypass spawn protection |
| **Whitelist** | Add/remove players. Enable the whitelist in server.properties to restrict who can join                                           |
| **Bans**      | Ban and unban players by name                                                                                                    |

> When RCON is connected, changes take effect immediately on the live server. When the server is offline, the panel edits `ops.json`, `whitelist.json`, and `banned-players.json` directly — changes apply on next start.

### Backups tab

Full point-in-time snapshots of everything needed to restore your server. Each backup is a single `.tar.gz` archive containing:

- **Minecraft server** — world data, mods (enabled + disabled), server configs (`server.properties`, `ops.json`, `whitelist.json`, `banned-players.json`, etc.)
- **App config** — `config.json`
- **PostgreSQL database** — users, admin levels, audit logs, sessions (when connected)

**Create a backup** manually at any time with an optional note (e.g. "Before adding new mods"). The server does not need to be stopped — when RCON is connected, the manager automatically quiesces the server (`save-all` + `save-off`) for a consistent snapshot, then re-enables auto-save afterwards.

**Scheduled backups** run automatically on a cron schedule (default: daily at 3 AM). Configure the schedule, storage path, and retention in **Settings → App Config**:

| Setting               | Default     | Description                                                                                              |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| Scheduled Backups     | Off         | Enable/disable the cron schedule                                                                         |
| Backup Schedule       | `0 3 * * *` | Cron expression (daily at 3 AM)                                                                          |
| Backup Storage Path   | `./backups` | Where archives are stored — set to a separate HDD mount                                                  |
| Max Scheduled Backups | 14          | Keep the last N scheduled backups; older ones are pruned automatically. Manual backups are never pruned. |

**Restore** from any saved backup. This replaces all server files, mods, config, and database contents. The Minecraft server must be stopped first. After restore, restart the manager app and the Minecraft server.

**Use cases:** roll back after a bad mod corrupts the world, undo damage from a griefer, recover from accidental config changes, or simply maintain regular disaster-recovery snapshots.

### Settings tab

- **App Config** — edit all `config.json` values in the browser (no SSH needed after initial setup). Change RCON password, launch config, memory flags, backup schedule, notification webhooks, etc. Toggle demo mode here. Note: secrets like session keys and OIDC credentials are managed as environment variables, not through this UI.
- **server.properties** — full editor for all server properties. Key settings (RCON, whitelist, online-mode, etc.) are shown first. **Restart the Minecraft server** after saving.

### Notifications

The manager can send webhook notifications for important server events. Configure a webhook URL in **Settings → App Config** or directly in `config.json`:

```json
"notifications": {
  "webhookUrl": "https://discord.com/api/webhooks/123456/abcdef...",
  "events": ["SERVER_CRASH", "SERVER_AUTO_RESTART", "BACKUP_FAILED", "LAG_SPIKE"]
}
```

**Supported events:** `SERVER_START`, `SERVER_STOP`, `SERVER_KILL`, `SERVER_RESTART`, `SERVER_CRASH`, `SERVER_AUTO_RESTART`, `BACKUP_CREATE`, `BACKUP_RESTORE`, `BACKUP_FAILED`, `PLAYER_BAN`, `PLAYER_UNBAN`, `PLAYER_KICK`, `MOD_INSTALL`, `MOD_DELETE`, `MODPACK_IMPORT`, `LAG_SPIKE`, `LOGIN_FAILED`, `LOGIN_DENIED`

If the `events` array is omitted, all events are sent. If present, only listed events trigger notifications.

**Discord:** When the webhook URL points to `discord.com` or `discordapp.com`, the manager sends rich embeds with color-coded severity (green for starts/backups, red for crashes/failures, orange for warnings). **Other endpoints:** receive a plain JSON POST with `event`, `title`, `message`, `details`, and `timestamp` fields.

Lag spike notifications have a 5-minute cooldown to prevent spam during sustained low-TPS periods.

---

## Monitoring & health endpoints

Three unauthenticated endpoints are available for external monitoring tools. They are mounted before the auth middleware, so probes and scrapers work without session cookies.

| Endpoint   | Purpose                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `/healthz` | Liveness check — returns `200 { status: "ok", uptime }` if the process is running                            |
| `/readyz`  | Readiness check — returns `200` when the database and config are loaded; `503` otherwise                     |
| `/metrics` | Prometheus text exposition format — exports process memory/CPU, database status, Minecraft TPS/players/state |

**Example uses:**

- **systemd:** `ExecStartPost=/usr/bin/curl -sf http://127.0.0.1:3000/healthz` to verify the service started
- **Nginx upstream:** `proxy_pass` with health checks against `/readyz`
- **UptimeRobot / Uptime Kuma:** monitor `/healthz`
- **Prometheus/Grafana:** scrape `/metrics` for dashboards and alerting

---

## About client vs server vs both-sided mods

This is a common source of confusion when building a Forge modpack:

| Type            | Install on server? | Players need it?                       |
| --------------- | ------------------ | -------------------------------------- |
| **Both**        | Yes                | Yes — must be in their mod profile too |
| **Server-only** | Yes                | No — clients don't need it installed   |
| **Client-only** | **No**             | Yes — they install it locally only     |

Examples of client-only mods: minimaps (JourneyMap), shader loaders (Oculus), performance mods (Rubidium), HUD mods. These will crash the server if loaded server-side.

Minecraft Manager automatically excludes client-only mods from the installed list and from all Modrinth browse/search results. Use **Identify Mods** to find and disable any unrecognized mods that ended up in the wrong place.

When players connect via Modrinth, they install the modpack profile which should contain the **Both** + **Client-only** mods. The server only runs **Both** + **Server-only** mods.

---

## Troubleshooting

**Panel won't start:**

- Check `config.json` exists and is valid JSON
- Make sure Node.js 20+ is installed: `node --version`
- The manager validates config on startup and prints clear errors if `serverPath`, `launch`, `rconPort`, `webPort`, or `bindHost` are invalid. Fix the listed fields and restart.

**"RCON not connected" error:**

- Verify `enable-rcon=true` is in `server.properties`
- The `rcon.password` in `server.properties` must match `rconPassword` in `config.json`
- RCON only becomes available after Forge fully loads — this can take 1–3 minutes with 200 mods. Use the **Reconnect RCON** button in **Settings → App Config** after the server finishes starting.

**Server won't start from the panel:**

- Test the start command manually in a terminal first: `cd /your/server && java -Xms2G -Xmx8G ...`
- Make sure `serverPath` in `config.json` points to the correct folder
- Check the Console tab for the full error output

**Mods not identified after clicking "Identify Mods":**

- The mod was likely not downloaded from Modrinth (e.g., from a website or CurseForge directly). The SHA1 hash won't match Modrinth's database.
- You can manually check a mod's side requirements at [modrinth.com](https://modrinth.com).

**Changes to config.json not taking effect:**

- The panel must be restarted after changing `webPort` or `demoMode`. Other settings (RCON paths, launch config) take effect on the next action.
- Environment variable changes (auth secrets, `ALLOWED_EMAILS`) require a service restart: `sudo systemctl restart mc-manager`

### Common failure modes

These are the issues most likely to trip up a first install:

| Symptom                        | Cause                                                                                     | Fix                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Login button does nothing      | `APP_URL` not set or doesn't match the OIDC callback URL registered with Google/Microsoft | Set `APP_URL` in the systemd service to your exact public URL (e.g. `https://mc.example.com`) |
| "Forbidden" or CSRF errors     | `TRUST_PROXY` not set to `1` behind a reverse proxy                                       | Add `Environment=TRUST_PROXY=1` to the systemd service                                        |
| Sessions lost on restart       | `SESSION_SECRET` not set (using a temporary secret)                                       | Generate a permanent secret and set `SESSION_SECRET` in the systemd service                   |
| Anyone can log in              | `ALLOWED_EMAILS` not set                                                                  | Set `ALLOWED_EMAILS` to a comma-separated list of permitted email addresses                   |
| RCON won't connect             | `enable-rcon=true` missing from `server.properties`, or password mismatch                 | Verify `rcon.password` in `server.properties` matches `rconPassword` in `config.json`         |
| Backups fail silently          | `backupPath` doesn't exist or isn't writable                                              | Create the directory and `chown` it to the service user                                       |
| Server won't start             | `launch.executable` (e.g. `java`) not on PATH for the service user                        | Use an absolute path like `/usr/bin/java` in `launch.executable`                              |
| WebSocket disconnects          | Nginx not configured for WebSocket upgrade                                                | Use the provided `deploy/nginx.conf` which includes `proxy_set_header Upgrade`                |
| Panel unreachable from network | `bindHost` is `127.0.0.1` (default) without a reverse proxy                               | Set up Nginx (see `deploy/nginx.conf`) or temporarily use `0.0.0.0` for LAN testing           |

### Preflight checks

The Dashboard shows a **Setup Checks** panel that automatically detects common misconfigurations: missing server path, RCON not configured, backup path issues, insecure bind settings, missing authentication, and more. Fix the flagged items to get a clean bill of health. The same checks are available via `GET /api/preflight` (requires login).

---

## Security notes

- **Never expose port 3000 directly.** The panel binds to `127.0.0.1` only. Always put it behind an HTTPS reverse proxy (Nginx, Caddy) in production.
- **RCON stays on localhost.** `rconHost` defaults to `127.0.0.1` and should stay that way. The RCON port (25575) must not be opened in the firewall.
- **OIDC is preferred over local password.** Google/Microsoft auth is phishing-resistant and doesn't require storing a password hash. The local password fallback is rate-limited but is lower security.
- **Always set ALLOWED_EMAILS in production.** Without it, anyone with a Google or Microsoft account can log in.
- **Secrets stay out of git.** `config.json` and `.env` are both in `.gitignore`. In production, secrets are injected via the systemd `Environment=` directives (readable only by root).
- **RCON password is never sent to the browser.** The `/api/config` endpoint strips `rconPassword` before responding.
- **All mod downloads are hash-verified.** Files downloaded from Modrinth are verified against Modrinth's SHA1 before being written to disk.
- **WebSocket origin validation.** The live console WebSocket rejects connections from cross-origin pages. When `APP_URL` is set, only that origin is allowed. Without `APP_URL`, the manager falls back to the `Host` header (a startup warning is printed in non-demo mode).
- **Config validation on startup.** The manager checks `serverPath`, `launch`, port values, and `bindHost` before starting. Invalid config prints clear errors and exits immediately — no silent misconfigurations.
- **Run the tests** to verify security utilities are working: `npm test`

---

## License

Copyright 2026 Jus144tice. Licensed under the [Apache License, Version 2.0](LICENSE).
