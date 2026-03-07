# Minecraft Manager

A self-hosted web control panel for a Minecraft Forge server running on Linux. Built for small modpacks (tested with ~200 mods) and a small group of players (2–8).

**Defaults to demo mode** — clone, install, and run to see a fully working demo with seed data. No Minecraft server required to try it out. Disable demo mode in Settings when you're ready to connect for real.

**Features:**
- Start / stop / restart the server from a browser
- Live streaming console with command input
- Mod manager — enable/disable mods, identify client vs server vs both-sided mods via Modrinth, search and download new mods directly from Modrinth
- Player management — operators (with permission levels), whitelist, bans
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

### 2. Copy the manager to your server

Option A — clone from GitHub:
```bash
git clone https://github.com/Jus144tice/minecraft-manager.git
cd minecraft-manager
```

Option B — copy manually via SCP from another machine:
```bash
scp -r minecraft-manager/ youruser@your-server-ip:~/
```

### 3. Install dependencies

```bash
cd minecraft-manager
npm install
```

---

## Configuration

### Step 0 — Try demo mode first (optional)

The app ships in demo mode by default. You can run it immediately after `npm install` without any Minecraft server:

```bash
cp config.example.json config.json
node server.js
# Open http://localhost:3000 — password is "changeme"
```

You'll see a fully interactive UI with seed data: 26 fake mods with client/server/both tags, online players, ops, whitelist, bans, a live-scrolling console, and server start/stop simulation. Modrinth search and mod install flows use the real Modrinth API even in demo mode.

When you're ready to go real, continue with Steps 1–3 below, then uncheck **Demo Mode** in **Settings → App Config** and save.

---

### Step 1 — Create config.json

```bash
cp config.example.json config.json
nano config.json
```

Fill in each field:

```jsonc
{
  // Absolute path to the folder where Minecraft Forge is installed
  "serverPath": "/home/minecraft/server",

  // RCON settings — must match server.properties (see below)
  "rconHost": "127.0.0.1",
  "rconPort": 25575,
  "rconPassword": "pick-a-strong-password",

  // Web UI settings
  "webPort": 3000,
  "webPassword": "pick-a-web-login-password",

  // The command used to launch the server (see "Finding your start command" below)
  "startCommand": "java -Xms6G -Xmx10G @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt nogui",

  // Minecraft version — used to filter Modrinth search results
  "minecraftVersion": "1.20.1",

  // Mods folders (relative to serverPath)
  "modsFolder": "mods",
  "disabledModsFolder": "mods_disabled"
}
```

### Step 2 — Enable RCON in server.properties

Open `server.properties` inside your Minecraft server folder and set:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=pick-a-strong-password
```

> The `rcon.password` must exactly match `rconPassword` in `config.json`. RCON lets the panel send commands (op, ban, whitelist, etc.) to a running server in real time.

### Step 3 — Find your start command

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
Use `-Xms6G -Xmx10G` — this leaves ~2 GB for the OS and the web panel.

---

## Running

### Start manually

```bash
cd minecraft-manager
node server.js
```

Then open a browser and go to `http://your-server-ip:3000`. Log in with your `webPassword`.

### Run as a background service (recommended)

This makes the manager start automatically on boot and restart if it crashes.

Create a systemd service file:

```bash
sudo nano /etc/systemd/system/mc-manager.service
```

Paste the following (adjust `User` and `WorkingDirectory` for your setup):

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

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable mc-manager
sudo systemctl start mc-manager
```

Check status:
```bash
sudo systemctl status mc-manager
sudo journalctl -u mc-manager -f   # live logs from the panel itself
```

---

## Using the Panel

### Dashboard
- **Start / Stop / Restart** — controls the Minecraft server process
- **Force Kill** — sends SIGKILL if the server is frozen (last resort)
- **Broadcast** — sends a message to all online players via `/say`
- **Online Players** — shows who is online with a quick kick button

### Console
- Streams the server log in real time via WebSocket
- Type commands in the input bar and press Enter — sent via RCON while the server is running

### Mods tab

#### Installed Mods
Lists every `.jar` in your `mods/` folder. You can:
- **Enable / Disable** — disabled mods are moved to `mods_disabled/` and are not loaded by Forge
- **Delete** — permanently removes the file
- **Filter** by name or by side (client-only / server-only / both)
- **Identify Mods (Modrinth)** — hashes every `.jar` via SHA1, looks them all up on Modrinth, and tags each mod as:
  - **Both** — required on client and server (most content mods)
  - **Server-only** — only belongs in the server's mods folder (clients don't need it)
  - **Client-only** — should NOT be in the server's mods folder (minimap mods, shaders, etc.)

#### Browse Modrinth
- Search Modrinth for Forge mods filtered to your configured Minecraft version
- Filter results by side
- Click **Install** to pick a version and download it directly into the server's mods folder

### Players tab

| Sub-tab | What it does |
|---|---|
| **Operators** | Add/remove ops. Level 4 = full admin, Level 3 = moderator (kick/ban), Level 2 = most commands, Level 1 = bypass spawn protection |
| **Whitelist** | Add/remove players. Enable the whitelist in server.properties to restrict who can join |
| **Bans** | Ban and unban players by name |

> When RCON is connected, changes take effect immediately on the live server. When the server is offline, the panel edits `ops.json`, `whitelist.json`, and `banned-players.json` directly — changes apply on next start.

### Settings tab

- **App Config** — edit all `config.json` values in the browser (no SSH needed after initial setup). Change the RCON password, start command, memory, etc.
- **server.properties** — full editor for all server properties. Key settings (RCON, whitelist, online-mode, etc.) are highlighted. **Restart the Minecraft server** after saving.

---

## About client vs server vs both-sided mods

This is a common source of confusion when building a Forge modpack:

| Type | Install on server? | Players need it? |
|---|---|---|
| **Both** | Yes | Yes — must be in their Modrinth/CurseForge profile too |
| **Server-only** | Yes | No — they don't need it installed |
| **Client-only** | **No** | Yes — they install it locally only |

Examples of client-only mods: minimaps (JourneyMap), shader loaders (Oculus), performance mods (Rubidium), HUD mods. These will crash the server if loaded server-side. Use the **Identify Mods** button to find and disable any that are in the wrong place.

When players connect via Modrinth, they install the modpack profile which should contain the **Both** + **Client-only** mods. The server only runs **Both** + **Server-only** mods.

---

## Troubleshooting

**Panel won't start:**
- Check `config.json` exists and is valid JSON
- Make sure Node.js 18+ is installed: `node --version`

**"RCON not connected" error:**
- Verify `enable-rcon=true` is in `server.properties`
- The `rcon.password` in `server.properties` must match `rconPassword` in `config.json`
- RCON only becomes available after Forge fully loads (can take 1–3 minutes with 200 mods). Use the **Reconnect RCON** button in Settings after the server finishes starting.

**Server won't start from the panel:**
- Test the start command manually in a terminal first: `cd /your/server && java -Xmx10G ...`
- Make sure the `serverPath` in `config.json` is correct
- Check the Console tab for the full error output

**Mods not identified after clicking "Identify Mods":**
- The mod was likely not downloaded through Modrinth (e.g., downloaded directly from a website or CurseForge). The SHA1 hash won't match Modrinth's database.
- You can still manually check a mod's side requirements on [modrinth.com](https://modrinth.com).

---

## Security notes

- This panel is intended to run on a **local home network**. Do not expose port 3000 to the internet without adding HTTPS and stronger authentication.
- `config.json` contains your passwords — keep it out of version control (it is in `.gitignore`).
- The RCON port (25575) should be firewalled from external access: `sudo ufw deny 25575`.
