# Discord Integration

Minecraft Manager includes an embedded Discord bot that lets you monitor and control your Minecraft server directly from Discord using slash commands.

## How It Works

The Discord bot runs inside the same process as the web panel. It uses the same internal services — status, start/stop/restart, backup, player list, RCON — so there's no logic duplication. Discord is just another interface into the app, alongside the web UI.

The bot is **completely optional**. If no Discord credentials are configured, the app runs exactly as before. If the bot fails to connect, the rest of the app continues normally.

## Setup

### 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name (e.g., "MC Manager")
3. Go to the **Bot** tab and click **Reset Token** to generate a bot token
4. Copy the token — you'll need it in step 3
5. On the **Bot** tab:
   - Disable **Public Bot** (only you should be able to add it)
   - Under **Privileged Gateway Intents**, no special intents are required
6. Note the **Application ID** from the **General Information** tab

### 2. Invite the Bot to Your Server

Build an invite URL with the `applications.commands` and `bot` scopes:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=2048
```

Replace `YOUR_APPLICATION_ID` with your application ID. The `2048` permission is "Send Messages" — the minimum needed for notifications.

### 3. Configure Environment Variables

Add these to your `.env` file or systemd service environment:

```bash
# Required
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_APPLICATION_ID=123456789012345678

# Recommended
DISCORD_GUILD_ID=987654321098765432
DISCORD_NOTIFICATION_CHANNEL_ID=222222222222222222
DISCORD_ADMIN_ROLE_IDS=111111111111111111
```

**Important:** The bot token is a secret — never put it in `config.json`. Always use environment variables.

### 4. Configure Non-Secret Settings

In `config.json`, add or update the `discord` section:

```json
{
  "discord": {
    "enabled": true,
    "ephemeralReplies": true,
    "allowDMs": false,
    "registerCommandsOnStartup": true
  }
}
```

All Discord IDs can also be set in `config.json` (except `botToken`), but environment variables take precedence. See `.env.example` for the full list.

### 5. Restart Minecraft Manager

After configuration, restart the app. You should see a log line like:

```
Discord bot connected (username: MCManager#1234, guild: 987654321098765432)
```

## Getting Discord IDs

Discord IDs are 17–20 digit numbers called "snowflake IDs". To copy them:

1. Open Discord settings → **Advanced** → enable **Developer Mode**
2. Right-click any server, channel, role, or user → **Copy ID**

| Value             | Where to find it                                            |
| ----------------- | ----------------------------------------------------------- |
| Application ID    | Discord Developer Portal → your app → General Information   |
| Guild (Server) ID | Right-click the server name → Copy Server ID                |
| Channel ID        | Right-click a text channel → Copy Channel ID                |
| Role ID           | Server Settings → Roles → right-click a role → Copy Role ID |

## Commands

### Read-Only (everyone)

| Command    | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `/status`  | Server status: online/offline, uptime, TPS, players, CPU, RAM |
| `/players` | List online players                                           |
| `/help`    | Show available commands based on your role                    |

### Admin (requires configured admin role)

| Command          | Description                 |
| ---------------- | --------------------------- |
| `/start`         | Start the Minecraft server  |
| `/stop`          | Gracefully stop the server  |
| `/restart`       | Restart the server          |
| `/say message`   | Broadcast a message in-game |
| `/backup [note]` | Create a server backup      |

## Permissions

- **Everyone** in the Discord server can use read-only commands (`/status`, `/players`, `/help`).
- **Admin commands** require the user to have one of the roles listed in `DISCORD_ADMIN_ROLE_IDS`.
- If `commandChannelIds` is set, commands only work in those channels.
- DMs are blocked by default (set `allowDMs: true` to allow read-only commands in DMs).
- All command usage is audit-logged (user, command, allowed/denied, timestamp).

## Notifications

When a notification channel is configured, the bot posts embeds for:

- Server started / stopped / crashed
- Auto-restart triggered
- Backup created / failed
- Lag spikes (TPS drops)

These work alongside (not replacing) the existing webhook notification system. Both can be active simultaneously.

## Configuration Reference

### Environment Variables (secrets + overrides)

| Variable                          | Required | Description                                                       |
| --------------------------------- | -------- | ----------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`               | Yes      | Bot token from Discord Developer Portal                           |
| `DISCORD_APPLICATION_ID`          | Yes      | Application ID                                                    |
| `DISCORD_GUILD_ID`                | No       | Restricts bot to one server; enables instant command registration |
| `DISCORD_NOTIFICATION_CHANNEL_ID` | No       | Channel for event notifications                                   |
| `DISCORD_ADMIN_ROLE_IDS`          | No       | Comma-separated role IDs for admin commands                       |
| `DISCORD_ALLOWED_ROLE_IDS`        | No       | Comma-separated role IDs (restricts all commands)                 |
| `DISCORD_COMMAND_CHANNEL_IDS`     | No       | Comma-separated channel IDs (restricts where commands work)       |

### config.json `discord` section (non-secrets)

| Key                         | Type     | Default | Description                                                        |
| --------------------------- | -------- | ------- | ------------------------------------------------------------------ |
| `enabled`                   | boolean  | `true`  | Master switch — set `false` to disable even with valid credentials |
| `applicationId`             | string   | `""`    | Can also be set via env var                                        |
| `guildId`                   | string   | `""`    | Can also be set via env var                                        |
| `adminRoleIds`              | string[] | `[]`    | Can also be set via env var                                        |
| `allowedRoleIds`            | string[] | `[]`    | Can also be set via env var                                        |
| `notificationChannelId`     | string   | `""`    | Can also be set via env var                                        |
| `commandChannelIds`         | string[] | `[]`    | Can also be set via env var                                        |
| `allowDMs`                  | boolean  | `false` | Allow read-only commands in DMs                                    |
| `ephemeralReplies`          | boolean  | `true`  | Bot replies only visible to the command user                       |
| `registerCommandsOnStartup` | boolean  | `true`  | Register slash commands with Discord on app start                  |

## Troubleshooting

**Bot is online but commands don't appear:**

- Slash commands may take up to 1 hour to propagate globally. Set `DISCORD_GUILD_ID` for instant registration.
- Check that the bot was invited with the `applications.commands` scope.

**"You do not have permission" error:**

- Make sure your Discord role ID is in `DISCORD_ADMIN_ROLE_IDS`.
- Role IDs are different from role names — use Developer Mode to copy the ID.

**Notifications not posting:**

- Verify `DISCORD_NOTIFICATION_CHANNEL_ID` is set and the bot has permission to send messages in that channel.
- Check the app logs for "Discord notification send failed" warnings.

**Bot fails to connect on startup:**

- Check that `DISCORD_BOT_TOKEN` is set correctly (no extra spaces or quotes).
- The app will log a warning and continue running without Discord — it won't crash.
