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
DISCORD_BOT_ADMIN_ROLE_IDS=111111111111111111
```

**Important:** The bot token is a secret — never put it in `config.json`. Always use environment variables.

### 4. Configure Non-Secret Settings

In `config.json`, add or update the `discord` section:

```json
{
  "discord": {
    "enabled": true,
    "allowDMs": false,
    "registerCommandsOnStartup": true,
    "linkChallengeTimeoutMinutes": 10
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

## Account Linking

Discord permissions for Minecraft server actions are tied to Minecraft server op levels through **account linking**. Each Discord user must link their own account by proving they control the Minecraft player name.

### How Linking Works

Linking uses a **code-based challenge flow** to verify account ownership:

1. **Start the link** — run `/link name:YourMinecraftName` in Discord
2. **Get a challenge code** — the bot replies (ephemerally) with a short code like `AX7K-42DP`
3. **Verify in Minecraft** — join the server as that player and type in chat: `!link AX7K-42DP`
4. **Link confirmed** — the bot creates the link and sends you a DM confirmation

This proves you control both the Discord account and the Minecraft account. The challenge code expires after 10 minutes (configurable via `linkChallengeTimeoutMinutes`).

**Important constraints:**
- You can only link **your own** account — no one can link on your behalf via Discord commands
- The code only works if typed by the **exact player name** you specified
- Each Minecraft account can only be linked to **one** Discord account at a time
- Each Discord account can only be linked to **one** Minecraft account at a time
- If you need to change your linked account, `/unlink` first, then `/link` again

### Managing Links

| Command                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `/link name:<mc_name>` | Start the challenge flow to link your account      |
| `/unlink`              | Remove your own link (reverts to read-only access) |
| `/whoami`              | Show your linked account and access level          |

Web admins can also view and manage links from the player profile modal in the web UI.

## Permission Model

Discord roles and Minecraft op levels are **separate concepts**:

- **Discord roles** control whether someone may use the bot at all (`allowedRoleIds`) and who has Discord-side bot admin privileges (`botAdminRoleIds`)
- **Minecraft op levels** control server operation permissions, resolved through account linking

Discord roles do **not** automatically grant Minecraft server authority.

### Permission Tiers

Commands are gated by **Minecraft op levels**. Read-only commands are always available to everyone — no linking required. Elevated commands require linking your Discord account to a Minecraft player who has the appropriate op level.

| Level | Tier Name    | MC Op Level | Commands                                             |
| ----- | ------------ | ----------- | ---------------------------------------------------- |
| 0     | Everyone     | —           | `/status`, `/players`, `/help`, `/link`, `/unlink`, `/whoami` |
| 1     | Moderator    | 1+          | `/say`                                               |
| 2     | Game Master  | 2+          | *(reserved for future commands)*                     |
| 3     | Admin        | 3+          | *(reserved for future commands)*                     |
| 4     | Owner        | 4           | `/start`, `/stop`, `/restart`, `/backup`             |

### Permission Resolution Order

1. Guild/channel/DM restrictions (same as before)
2. If the command is read-only → allow
3. If the user has an **owner override role** (see below) → allow
4. Look up linked Minecraft name → check op level in `ops.json` → allow if sufficient
5. Deny with a message explaining what's needed

### Owner Override Role (Optional, Dangerous)

If you need an emergency escape hatch for server operators who don't have Minecraft accounts, you can configure `ownerOverrideRoleIds`. Users with these Discord roles bypass all MC op-level checks and get full owner access.

**This is off by default and intentionally dangerous.** Only use it if you have a legitimate need for Discord-only server management without a Minecraft account link.

```bash
# In .env (NOT recommended for normal use)
DISCORD_OWNER_OVERRIDE_ROLE_IDS=111111111111111111
```

Or in `config.json`:
```json
{
  "discord": {
    "ownerOverrideRoleIds": ["111111111111111111"]
  }
}
```

## Commands

### Read-Only (everyone, no link needed)

| Command    | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `/status`  | Server status: online/offline, uptime, TPS, players, CPU, RAM |
| `/players` | List online players                                           |
| `/help`    | Show available commands based on your access level            |
| `/link`    | Start the challenge flow to link your Minecraft account       |
| `/unlink`  | Remove your account link                                      |
| `/whoami`  | Show your linked account and permission level                 |

### Moderator (Op 1+)

| Command          | Description                 |
| ---------------- | --------------------------- |
| `/say message`   | Broadcast a message in-game |

### Owner (Op 4)

| Command          | Description                 |
| ---------------- | --------------------------- |
| `/start`         | Start the Minecraft server  |
| `/stop`          | Gracefully stop the server  |
| `/restart`       | Restart the server          |
| `/backup [note]` | Create a server backup      |

## Visibility

- **Read-only commands** (`/status`, `/players`, `/help`) reply **publicly** so everyone can see.
- **Account management commands** (`/link`, `/unlink`, `/whoami`) reply **ephemerally** (only you can see).
- **Elevated commands** (`/say`, `/start`, `/stop`, `/restart`, `/backup`) reply **ephemerally**.

## Notifications

When a notification channel is configured, the bot posts embeds for:

- Server started / stopped / crashed
- Auto-restart triggered
- Backup created / failed
- Lag spikes (TPS drops)

These work alongside (not replacing) the existing webhook notification system. Both can be active simultaneously.

## Configuration Reference

### Environment Variables (secrets + overrides)

| Variable                            | Required | Description                                                          |
| ----------------------------------- | -------- | -------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`                 | Yes      | Bot token from Discord Developer Portal                              |
| `DISCORD_APPLICATION_ID`            | Yes      | Application ID                                                       |
| `DISCORD_GUILD_ID`                  | No       | Restricts bot to one server; enables instant command registration    |
| `DISCORD_NOTIFICATION_CHANNEL_ID`   | No       | Channel for event notifications                                      |
| `DISCORD_BOT_ADMIN_ROLE_IDS`        | No       | Comma-separated role IDs for Discord bot management                  |
| `DISCORD_ALLOWED_ROLE_IDS`          | No       | Comma-separated role IDs (restricts all commands)                    |
| `DISCORD_COMMAND_CHANNEL_IDS`       | No       | Comma-separated channel IDs (restricts where commands work)          |
| `DISCORD_OWNER_OVERRIDE_ROLE_IDS`   | No       | Comma-separated role IDs that bypass MC op checks (**dangerous**)    |

> **Migration note:** The old `DISCORD_ADMIN_ROLE_IDS` env var is still accepted as an alias for `DISCORD_BOT_ADMIN_ROLE_IDS`. It no longer grants Minecraft server authority — only bot admin privileges. Rename to `DISCORD_BOT_ADMIN_ROLE_IDS` when convenient.

### config.json `discord` section (non-secrets)

| Key                            | Type     | Default | Description                                                                    |
| ------------------------------ | -------- | ------- | ------------------------------------------------------------------------------ |
| `enabled`                      | boolean  | `true`  | Master switch — set `false` to disable even with valid credentials             |
| `applicationId`                | string   | `""`    | Can also be set via env var                                                    |
| `guildId`                      | string   | `""`    | Can also be set via env var                                                    |
| `botAdminRoleIds`              | string[] | `[]`    | Discord bot management roles (not MC authority)                                |
| `allowedRoleIds`               | string[] | `[]`    | Can also be set via env var                                                    |
| `ownerOverrideRoleIds`         | string[] | `[]`    | Dangerous: bypasses MC op checks (**off by default**)                          |
| `notificationChannelId`        | string   | `""`    | Can also be set via env var                                                    |
| `commandChannelIds`            | string[] | `[]`    | Can also be set via env var                                                    |
| `allowDMs`                     | boolean  | `false` | Allow read-only commands in DMs                                                |
| `registerCommandsOnStartup`    | boolean  | `true`  | Register slash commands with Discord on app start                              |
| `linkChallengeTimeoutMinutes`  | number   | `10`    | How long a `!link` challenge code remains valid                                |

## Troubleshooting

**Bot is online but commands don't appear:**

- Slash commands may take up to 1 hour to propagate globally. Set `DISCORD_GUILD_ID` for instant registration.
- Check that the bot was invited with the `applications.commands` scope.

**"You need to link your Minecraft account" error:**

- Use `/link name:YourMinecraftName` to start the linking process.
- Join the Minecraft server as that player and type `!link CODE` in chat.

**"The Minecraft server is currently offline" when linking:**

- The server must be online for the challenge flow. Start the server, then retry `/link`.

**"That Minecraft account is already linked to another Discord user":**

- Each MC name can only be linked to one Discord user. The current owner must `/unlink` first.

**Challenge code expired:**

- Codes expire after 10 minutes (configurable). Run `/link` again to get a new code.

**"Your linked account has op level 0" error:**

- Your Minecraft account needs to be an operator. Ask the server owner to `/op` you in-game or through the Manager web UI.
- Use `/whoami` to check your current access level.

**"You need to link your Minecraft account" for elevated commands:**

- Link your account first using `/link name:YourMinecraftName`.
- Discord roles alone do not grant Minecraft server authority (unless owner override roles are configured).

**Notifications not posting:**

- Verify `DISCORD_NOTIFICATION_CHANNEL_ID` is set and the bot has permission to send messages in that channel.
- Check the app logs for "Discord notification send failed" warnings.

**Bot fails to connect on startup:**

- Check that `DISCORD_BOT_TOKEN` is set correctly (no extra spaces or quotes).
- The app will log a warning and continue running without Discord — it won't crash.
