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
- Password-protected web UI
- WebSocket-based live log streaming

---

## Requirements

| Requirement | Notes |
|---|---|
| Ubuntu 22.04 or newer | Any modern Linux should work |
| Node.js 18 or newer | Used to run the web panel |
| Java 17 or newer | Already needed for Minecraft Forge |
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
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:
```bash
node --version   # should be v18 or higher
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

  // Port the web panel listens on (only exposed to localhost — behind a reverse proxy)
  "webPort": 3000,

  // The command used to launch the server (see "Finding your start command" below)
  "startCommand": "java -Xms6G -Xmx10G @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt nogui",

  // Minecraft version — used to filter Modrinth search results
  "minecraftVersion": "1.20.1",

  // Mods folders (relative to serverPath)
  "modsFolder": "mods",
  "disabledModsFolder": "mods_disabled",

  // Set to false to connect to your real server; restart the panel after changing
  "demoMode": false
}
```

> **Note:** `rconPassword` is stored in `config.json` on the server. It is never sent to the browser. `config.json` is in `.gitignore`.

### Environment variables

Secrets and deployment settings are configured via environment variables (not `config.json`). Copy `.env.example` to `.env` for local development:

```bash
cp .env.example .env
nano .env
```

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | Yes (production) | Long random string for signing session cookies. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `TRUST_PROXY` | Yes (behind Nginx/Caddy) | Set to `1` — enables correct client IP detection and secure cookies |
| `APP_URL` | Yes (OIDC) | Public base URL, e.g. `https://mc.example.com` — must match OIDC callback URLs |
| `ALLOWED_EMAILS` | Recommended | Comma-separated list of emails allowed to log in, e.g. `you@gmail.com,family@outlook.com`. Leave empty to allow any authenticated account. |
| `GOOGLE_CLIENT_ID` | One provider required | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | One provider required | From Google Cloud Console |
| `MICROSOFT_CLIENT_ID` | One provider required | From Azure Portal |
| `MICROSOFT_CLIENT_SECRET` | One provider required | From Azure Portal |
| `MICROSOFT_TENANT` | Optional | `common` (default), `consumers`, or a tenant ID |
| `LOCAL_PASSWORD` | Optional | Fallback password login. Rate-limited to 20 attempts/15 min. |

In production, set these in the systemd service file (see below) rather than a `.env` file.

### Enable RCON in server.properties

Open `server.properties` inside your Minecraft server folder and set:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=pick-a-strong-password
```

> The `rcon.password` must exactly match `rconPassword` in `config.json`. RCON lets the panel send commands (op, ban, whitelist, say, etc.) to a running server in real time.

### Find your start command

**Modern Forge (1.17+)** generates a `run.sh` script in the server folder:

```bash
cat /home/minecraft/server/run.sh
```

It will look something like:
```
java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt "$@"
```

Copy that line into `startCommand` in `config.json`, replace `"$@"` with `nogui`, and add your memory flags:
```
java -Xms6G -Xmx10G @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt nogui
```

**Old Forge (pre-1.17):**
```
java -Xms6G -Xmx10G -jar forge-1.16.5-36.2.39.jar nogui
```

**Memory recommendation for a 12 GB machine:**
Use `-Xms6G -Xmx10G` — leaves ~2 GB for the OS and the web panel.

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

### Run as a background service (production)

Create a systemd service file. Secrets go directly in the service file — they are readable only by root and the service user, and never committed to git.

```bash
sudo nano /etc/systemd/system/mc-manager.service
```

```ini
[Unit]
Description=Minecraft Manager Web Panel
After=network.target

[Service]
User=minecraft
WorkingDirectory=/home/minecraft/minecraft-manager
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

# --- Secrets and deployment config ---
# Generate SESSION_SECRET with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
Environment=SESSION_SECRET=replace-with-a-long-random-string
Environment=TRUST_PROXY=1
Environment=APP_URL=https://mc.example.com
Environment=ALLOWED_EMAILS=you@gmail.com,family@outlook.com

# At least one auth provider (Google and/or Microsoft):
Environment=GOOGLE_CLIENT_ID=
Environment=GOOGLE_CLIENT_SECRET=
# Environment=MICROSOFT_CLIENT_ID=
# Environment=MICROSOFT_CLIENT_SECRET=
# Environment=MICROSOFT_TENANT=common

# Optional local password fallback:
# Environment=LOCAL_PASSWORD=your-password-here

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable mc-manager
sudo systemctl start mc-manager
```

Check status and live logs:
```bash
sudo systemctl status mc-manager
sudo journalctl -u mc-manager -f
```

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

Install Nginx and Certbot, then create a site config:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d mc.example.com
```

Create `/etc/nginx/sites-available/mc-manager`:

```nginx
server {
    listen 443 ssl;
    server_name mc.example.com;

    # Certbot will populate these:
    ssl_certificate     /etc/letsencrypt/live/mc.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mc.example.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket support (live console)
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name mc.example.com;
    return 301 https://$host$request_uri;
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/mc-manager /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

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

| Sub-tab | What it does |
|---|---|
| **Operators** | Add/remove ops. Level 4 = full admin, Level 3 = moderator (kick/ban), Level 2 = most commands, Level 1 = bypass spawn protection |
| **Whitelist** | Add/remove players. Enable the whitelist in server.properties to restrict who can join |
| **Bans** | Ban and unban players by name |

> When RCON is connected, changes take effect immediately on the live server. When the server is offline, the panel edits `ops.json`, `whitelist.json`, and `banned-players.json` directly — changes apply on next start.

### Settings tab

- **App Config** — edit all `config.json` values in the browser (no SSH needed after initial setup). Change RCON password, start command, memory flags, etc. Toggle demo mode here. Note: secrets like session keys and OIDC credentials are managed as environment variables, not through this UI.
- **server.properties** — full editor for all server properties. Key settings (RCON, whitelist, online-mode, etc.) are shown first. **Restart the Minecraft server** after saving.

---

## About client vs server vs both-sided mods

This is a common source of confusion when building a Forge modpack:

| Type | Install on server? | Players need it? |
|---|---|---|
| **Both** | Yes | Yes — must be in their mod profile too |
| **Server-only** | Yes | No — clients don't need it installed |
| **Client-only** | **No** | Yes — they install it locally only |

Examples of client-only mods: minimaps (JourneyMap), shader loaders (Oculus), performance mods (Rubidium), HUD mods. These will crash the server if loaded server-side.

Minecraft Manager automatically excludes client-only mods from the installed list and from all Modrinth browse/search results. Use **Identify Mods** to find and disable any unrecognized mods that ended up in the wrong place.

When players connect via Modrinth, they install the modpack profile which should contain the **Both** + **Client-only** mods. The server only runs **Both** + **Server-only** mods.

---

## Troubleshooting

**Panel won't start:**
- Check `config.json` exists and is valid JSON
- Make sure Node.js 18+ is installed: `node --version`

**"RCON not connected" error:**
- Verify `enable-rcon=true` is in `server.properties`
- The `rcon.password` in `server.properties` must match `rconPassword` in `config.json`
- RCON only becomes available after Forge fully loads — this can take 1–3 minutes with 200 mods. Use the **Reconnect RCON** button in **Settings → App Config** after the server finishes starting.

**Server won't start from the panel:**
- Test the start command manually in a terminal first: `cd /your/server && java -Xmx10G ...`
- Make sure `serverPath` in `config.json` points to the correct folder
- Check the Console tab for the full error output

**Mods not identified after clicking "Identify Mods":**
- The mod was likely not downloaded from Modrinth (e.g., from a website or CurseForge directly). The SHA1 hash won't match Modrinth's database.
- You can manually check a mod's side requirements at [modrinth.com](https://modrinth.com).

**Changes to config.json not taking effect:**
- The panel must be restarted after changing `webPort` or `demoMode`. Other settings (RCON paths, start command) take effect on the next action.
- Environment variable changes (auth secrets, `ALLOWED_EMAILS`) require a service restart: `sudo systemctl restart mc-manager`

---

## Security notes

- **Never expose port 3000 directly.** The panel binds to `127.0.0.1` only. Always put it behind an HTTPS reverse proxy (Nginx, Caddy) in production.
- **RCON stays on localhost.** `rconHost` defaults to `127.0.0.1` and should stay that way. The RCON port (25575) must not be opened in the firewall.
- **OIDC is preferred over local password.** Google/Microsoft auth is phishing-resistant and doesn't require storing a password hash. The local password fallback is rate-limited but is lower security.
- **Always set ALLOWED_EMAILS in production.** Without it, anyone with a Google or Microsoft account can log in.
- **Secrets stay out of git.** `config.json` and `.env` are both in `.gitignore`. In production, secrets are injected via the systemd `Environment=` directives (readable only by root).
- **RCON password is never sent to the browser.** The `/api/config` endpoint strips `rconPassword` before responding.
- **All mod downloads are hash-verified.** Files downloaded from Modrinth are verified against Modrinth's SHA1 before being written to disk.
- **Run the tests** to verify security utilities are working: `npm test`

---

## License

Copyright 2026 Jus144tice. Licensed under the [Apache License, Version 2.0](LICENSE).
