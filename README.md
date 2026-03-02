# cc-discord

**Discord <-> Claude Code relay** — power per-channel AI bots using your existing Claude subscription (no API key needed).

- Discord messages are stored in SQLite and delivered to Claude Code
- One Claude instance per channel, each running autonomously
- Replies sent back to Discord via `send-discord` tool
- Typing indicators, memory context, and attachment support built in

## How it works

```
Discord → relay server (stores messages in SQLite) → Claude subagent per channel
Claude subagent reads messages → crafts reply → send-discord → Discord
```

The relay server handles all Discord connectivity. The orchestrator spawns one Claude Code subagent per channel; each subagent loops indefinitely, polling for new messages and replying.

---

## 1) Create a Discord application and bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name
3. Go to the **Bot** section in the left sidebar
4. Click **Add Bot**, then **Reset Token** and copy the bot token
5. Enable the following **Privileged Gateway Intents**:
   - **Message Content Intent** (required — without this the bot cannot read message text)
   - **Server Members Intent** (optional)
6. Go to **OAuth2 > URL Generator**:
   - Under **Scopes**, select: `bot`, `applications.commands`
   - Under **Bot Permissions**, select: `Send Messages`, `Read Messages/View Channels`, `Read Message History`
7. Copy the generated URL and open it in your browser to invite the bot to your server
8. In your Discord server, note the **channel ID(s)** you want the bot to respond in:
   - Enable Developer Mode in Discord settings (User Settings > Advanced > Developer Mode)
   - Right-click a channel and select **Copy Channel ID**

---

## 2) Configure environment

```bash
cp .env.relay.example .env.relay
cp .env.worker.example .env.worker
```

### Required in `.env.relay`

| Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from the Developer Portal |
| `DISCORD_CHANNEL_ID` | Default channel ID the bot operates in |
| `RELAY_API_TOKEN` | Shared secret between relay and worker (any random string) |

### Required in `.env.worker`

| Variable | Description |
|---|---|
| `RELAY_API_TOKEN` | Must match the token in `.env.relay` |

### Optional `.env.relay` settings

| Variable | Default | Description |
|---|---|---|
| `DISCORD_ALLOWED_CHANNEL_IDS` | _(all)_ | Comma-separated list of allowed channel IDs |
| `DISCORD_IGNORED_CHANNEL_IDS` | _(none)_ | Comma-separated list of channel IDs to ignore |
| `ALLOWED_DISCORD_USER_IDS` | _(all)_ | Comma-separated list of user IDs that can interact |
| `RELAY_HOST` | `127.0.0.1` | Host for the relay HTTP API |
| `RELAY_PORT` | `3199` | Port for the relay HTTP API |
| `RELAY_ALLOW_NO_AUTH` | `false` | Set `true` for local dev without a token |
| `TYPING_INTERVAL_MS` | `8000` | How often to send the typing indicator |
| `TYPING_MAX_MS` | `120000` | Max time to show typing before sending fallback |
| `THINKING_FALLBACK_ENABLED` | `true` | Send a fallback message if Claude takes too long |
| `THINKING_FALLBACK_TEXT` | _"Still working on that..."_ | Text of the fallback message |
| `BUSY_NOTIFY_ON_QUEUE` | `true` | Notify user if Claude is busy when their message arrives |
| `BUSY_NOTIFY_COOLDOWN_MS` | `30000` | Min time between busy notifications per activity |

### Optional `.env.worker` settings

| Variable | Default | Description |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | Relay server host |
| `RELAY_PORT` | `3199` | Relay server port |
| `RELAY_URL` | _(derived)_ | Full relay URL (overrides host/port) |
| `DISCORD_SESSION_ID` | `default` | Session identifier for message routing |
| `CLAUDE_AGENT_ID` | `claude` | Agent identifier for message routing |
| `AUTO_REPLY_PERMISSION_MODE` | `skip` | `skip` (fully autonomous) or `accept-edits` (safer) |
| `CLAUDE_RUNTIME_ID` | _(auto)_ | Runtime context identifier for memory |
| `WAIT_QUIET_TIMEOUT` | `true` | Exit quietly on timeout (no noise in Claude UI) |
| `BASH_POLICY_MODE` | `block` | `block` or `allow` for background bash ops |
| `ALLOW_BASH_RUN_IN_BACKGROUND` | `true` | Allow `run_in_background=true` in Bash tool |
| `ALLOW_BASH_BACKGROUND_OPS` | `false` | Allow `&` background operator in commands |
| `BASH_POLICY_NOTIFY_ON_BLOCK` | `true` | Send Discord notification when bash is blocked |
| `BASH_POLICY_NOTIFY_CHANNEL_ID` | _(none)_ | Channel to send bash policy notifications to |

Security note: the worker process intentionally does not receive `DISCORD_BOT_TOKEN`.

---

## 3) Install dependencies

```bash
bun install
```

---

## 4) Generate Claude settings

```bash
bun run generate-settings
```

This creates `.claude/settings.json` with absolute hook paths for your machine.

---

## 5) Start the relay server

```bash
bun start
```

Health check:

```bash
curl http://127.0.0.1:3199/health
```

---

## 6) Start the orchestrator

In a second terminal:

```bash
bun run start:orchestrator
```

The orchestrator discovers all allowed channels, spawns one Claude subagent per channel, and keeps them healthy.

**Startup sequence:**
1. `bun start` — relay server (Discord bot + HTTP API)
2. `bun run start:orchestrator` — Claude orchestrator (spawns channel subagents)

---

## Typing indicator behavior

- When a user sends a message, the relay immediately starts a typing indicator in that channel
- The typing heartbeat repeats every `TYPING_INTERVAL_MS` (default 8s)
- The indicator stops automatically when Claude sends a reply via `send-discord`
- After `TYPING_MAX_MS` (default 120s), the relay posts a fallback patience message
- If Claude is busy on another task when a message arrives, a queued notification is sent

---

## Message format delivered to Claude

```
NEW DISCORD MESSAGE(S): [MESSAGE from discord:123...] [channel:456...] [DISCORD_MESSAGE]: username: hello

MEMORY CONTEXT:
Relevant prior turns (outside current window):
...
```

Memory retrieval avoids re-injecting turns from the current Claude session, while surfacing relevant older context.

---

## /model slash command

Use `/model` in any channel to get or set the Claude model for that channel:

- `/model` — show the current model
- `/model name:claude-opus-4-6` — set the model (accepts full model IDs)
- `/model name:clear` — reset to default

---

## Memory module

A pluggable memory foundation exists under `memory/` with SQLite as the primary store.

Run a quick validation:

```bash
bun run memory:smoke
```

---

## Interactive mode (manual use)

If you want to run Claude interactively rather than in autonomous mode:

```bash
# Generate settings first
bun run generate-settings

# Add tools to PATH and start Claude manually
export PATH="/path/to/cc-discord/tools:$PATH"
claude --settings /path/to/cc-discord/.claude/settings.json
```

Claude will receive Discord messages via hooks and can reply with `send-discord`.

---

## Next steps

- Discord thread <-> Claude session mapping
- FIFO wake-up path for lower latency
- Headless daemon mode (no interactive terminal required)
- Rate limit / retry / chunking for long outputs
- Automated test suite
