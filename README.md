# cc-discord

**Discord <-> Claude Code relay** — power per-channel AI Agents using your existing Claude subscription (no API key needed).

- One autonomous Claude Code agent per Discord channel
- Messages stored in SQLite, delivered to agents via hooks
- Replies sent back to Discord via `send-discord` tool
- Typing indicators, busy notifications, live trace threads, memory context, attachment support, and more

## Quick start

### Prerequisites

- [Bun](https://bun.sh) runtime installed
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude auth login`)
- A Discord bot (see [Create a Discord bot](#create-a-discord-bot) below)

### Option A: Run directly with bunx (recommended)

```bash
bunx @hoverlover/cc-discord
```

This installs and runs cc-discord in one step. Configure your `.env.relay` and `.env.worker` files in the current directory before running.

### Option B: Clone the repo (contributors)

```bash
git clone https://github.com/hoverlover/cc-discord.git
cd cc-discord
bun install
bun run generate-settings
bun start
```

`bun start` launches both the relay server and the orchestrator in a single process. No second terminal needed.

---

## Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name
3. Go to the **Bot** section in the left sidebar
4. Click **Add Bot**, then **Reset Token** and copy the bot token
5. Enable the following **Privileged Gateway Intents**:
   - **Message Content Intent** (required — without this the bot cannot read message text)
   - **Server Members Intent** (optional)
6. Go to **OAuth2 > URL Generator**:
   - Under **Scopes**, select: `bot`, `applications.commands`
   - Under **Bot Permissions**, select: `Send Messages`, `Read Messages/View Channels`, `Read Message History`, `Manage Threads`
7. Copy the generated URL and open it in your browser to invite the bot to your server
8. In your Discord server, note the **channel ID(s)** you want the bot to respond in:
   - Enable Developer Mode in Discord settings (User Settings > Advanced > Developer Mode)
   - Right-click a channel and select **Copy Channel ID**

---

## Configure environment

```bash
cp .env.relay.example .env.relay
cp .env.worker.example .env.worker
```

### `.env.relay` — required

| Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from the Developer Portal |
| `DISCORD_CHANNEL_ID` | Default channel ID the bot operates in |
| `RELAY_API_TOKEN` | Shared secret between relay and worker (any random string) |

### `.env.relay` — optional

| Variable | Default | Description |
|---|---|---|
| `DISCORD_ALLOWED_CHANNEL_IDS` | _(all)_ | Comma-separated allowlist of channel IDs |
| `DISCORD_IGNORED_CHANNEL_IDS` | _(none)_ | Comma-separated list of channel IDs to ignore |
| `ALLOWED_DISCORD_USER_IDS` | _(all)_ | Comma-separated list of user IDs that can interact |
| `MESSAGE_ROUTING_MODE` | `channel` | `channel` (orchestrator/subagent) or `agent` (single-agent) |
| `RELAY_HOST` | `127.0.0.1` | Host for the relay HTTP API |
| `RELAY_PORT` | `3199` | Port for the relay HTTP API |
| `RELAY_ALLOW_NO_AUTH` | `false` | Set `true` for local dev without a token |
| `TYPING_INTERVAL_MS` | `8000` | Typing indicator heartbeat interval (ms) |
| `TYPING_MAX_MS` | `120000` | Max typing duration before sending fallback |
| `THINKING_FALLBACK_ENABLED` | `true` | Send a fallback message if Claude takes too long |
| `THINKING_FALLBACK_TEXT` | _"Still working on that..."_ | Fallback message content |
| `BUSY_NOTIFY_ON_QUEUE` | `true` | Notify user if Claude is busy when their message arrives |
| `BUSY_NOTIFY_COOLDOWN_MS` | `30000` | Min time between busy notifications (ms) |
| `BUSY_NOTIFY_MIN_DURATION_MS` | `30000` | Only send busy notification if current activity has been running this long (ms) |
| `TRACE_THREAD_ENABLED` | `true` | Create live trace threads showing agent activity |
| `TRACE_THREAD_NAME` | `⚙️ Live Trace` | Name of the trace thread |
| `TRACE_FLUSH_INTERVAL_MS` | `3000` | How often trace events are flushed to Discord (ms) |
| `MAX_ATTACHMENT_INLINE_BYTES` | `100000` | Max bytes for inline attachment content |
| `MAX_ATTACHMENT_DOWNLOAD_BYTES` | `10000000` | Max bytes for downloaded attachments |
| `ATTACHMENT_TTL_MS` | `3600000` | TTL for downloaded attachment files (ms) |

### `.env.worker` — required

| Variable | Description |
|---|---|
| `RELAY_API_TOKEN` | Must match the token in `.env.relay` |

### `.env.worker` — optional

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
| `BASH_POLICY_MODE` | `block` | `block` or `allow` for background bash operations |
| `ALLOW_BASH_RUN_IN_BACKGROUND` | `true` | Allow `run_in_background=true` in Bash tool |
| `ALLOW_BASH_BACKGROUND_OPS` | `false` | Allow `&` background operator in commands |
| `BASH_POLICY_NOTIFY_ON_BLOCK` | `true` | Send Discord notification when bash is blocked |
| `BASH_POLICY_NOTIFY_CHANNEL_ID` | _(none)_ | Channel to send bash policy notifications to |
| `STUCK_AGENT_THRESHOLD` | `900` | Seconds without heartbeat + unread messages before agent is considered stuck |

### Orchestrator env vars

These are read by the orchestrator shell script:

| Variable | Default | Description |
|---|---|---|
| `HEALTH_CHECK_INTERVAL` | `30` | Seconds between health checks |
| `AGENT_RESTART_DELAY` | `5` | Seconds to wait before restarting a dead agent |
| `CC_DISCORD_LOG_DIR` | `/tmp/cc-discord/logs` | Directory for all log files |

Security note: the worker process intentionally does not receive `DISCORD_BOT_TOKEN`.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  bun start  (scripts/start.sh)                           │
│                                                          │
│  ┌──────────────────┐    ┌─────────────────────────────┐ │
│  │  Relay Server    │    │  Shell Orchestrator         │ │
│  │  (bun + express) │    │  (orchestrator.sh)          │ │
│  │                  │    │                             │ │
│  │  - Discord bot   │    │  Discovers channels via API │ │
│  │  - HTTP API      │    │  Spawns 1 Claude agent per  │ │
│  │  - SQLite store  │    │  channel, monitors health,  │ │
│  │  - Typing mgr    │    │  restarts dead/stuck agents │ │
│  │  - Trace threads │    │                             │ │
│  └────────┬─────────┘    │  ┌────────┐ ┌────────┐      │ │
│           │              │  │Agent #1│ │Agent #2│ ...  │ │
│           │              │  └────────┘ └────────┘      │ │
│           │              └─────────────────────────────┘ │
└───────────┼──────────────────────────────────────────────┘
            │
       Discord API
```

**Message flow:**

1. A Discord user sends a message
2. The relay server stores it in SQLite and starts a typing indicator
3. The channel's Claude agent picks up the message via the `check-discord-messages` hook
4. Claude processes the message and calls `send-discord` to reply
5. The `steer-send` hook intercepts the send if new messages arrived while Claude was composing, forcing a revised reply
6. The relay posts the reply to Discord and stops the typing indicator

---

## Features

### Typing indicators

When a user sends a message, the relay starts a typing indicator that repeats every `TYPING_INTERVAL_MS` (default 8s). It stops automatically when Claude replies. After `TYPING_MAX_MS` (default 120s), a configurable fallback patience message is sent.

### Busy notifications

If Claude is already processing a task when a new message arrives, a notification is sent to let the user know their message is queued. Controlled by `BUSY_NOTIFY_ON_QUEUE`, `BUSY_NOTIFY_COOLDOWN_MS`, and `BUSY_NOTIFY_MIN_DURATION_MS`.

### Send steering

The `steer-send` hook intercepts outgoing `send-discord` calls and checks for unread messages. If new messages arrived while Claude was composing a reply, the send is blocked and Claude is forced to revise its reply to address all messages. This prevents Claude from sending stale responses.

### Live trace threads

When enabled, the relay creates a thread in each channel (default name: "⚙️ Live Trace") and streams live agent activity — tool calls, status changes, and more. Users can watch the agent work in real time without cluttering the main channel. Controlled by `TRACE_THREAD_ENABLED`, `TRACE_THREAD_NAME`, and `TRACE_FLUSH_INTERVAL_MS`.

### Attachments

Discord attachments are downloaded to a temp directory and delivered to Claude as file paths. The `cleanup-attachment` hook automatically deletes them after Claude reads them. Size limits and TTL are configurable via `MAX_ATTACHMENT_INLINE_BYTES`, `MAX_ATTACHMENT_DOWNLOAD_BYTES`, and `ATTACHMENT_TTL_MS`.

### /model slash command

Use `/model` in any channel to get or set the Claude model for that channel:

- `/model` — show the current model
- `/model name:claude-opus-4-6` — set the model
- `/model name:clear` — reset to default

### Memory system

A pluggable memory system backed by SQLite provides cross-session context. When a message arrives, the `check-discord-messages` hook retrieves relevant prior turns (avoiding duplicates from the current session) and includes them as memory context.

### Stuck agent detection

The orchestrator periodically checks each agent's health. An agent is considered stuck when all three conditions are met:

1. Heartbeat is stale (older than `STUCK_AGENT_THRESHOLD`, default 15 min)
2. Unread messages are waiting
3. Log file is also stale (no recent output)

Stuck agents are killed and automatically restarted.

### Bash safety guard

The `safe-bash` hook inspects Bash tool calls for risky background execution patterns (`run_in_background=true`, standalone `&` operator). Depending on `BASH_POLICY_MODE`, these are either blocked or allowed with a Discord notification. Fine-grained control via `ALLOW_BASH_RUN_IN_BACKGROUND` and `ALLOW_BASH_BACKGROUND_OPS`.

---

## Interactive mode

To run Claude interactively (with a terminal UI) instead of in autonomous headless mode:

```bash
# Start the relay in one terminal
bun run start:relay

# Start the interactive orchestrator in another terminal
bun run start:orchestrator-interactive
```

In interactive mode, the orchestrator runs as a Claude Code session with a visible terminal. The relay must be started separately since there is no master process managing both.

---

## Development

### Scripts

| Script | Description |
|---|---|
| `bun start` | Start relay + orchestrator (production) |
| `bun run start:relay` | Start relay server only |
| `bun run start:orchestrator` | Start headless orchestrator only |
| `bun run start:orchestrator-interactive` | Start interactive orchestrator (terminal UI) |
| `bun run dev` | Alias for `start:relay` |
| `bun run generate-settings` | Generate `.claude/settings.json` with absolute hook paths |
| `bun run memory:smoke` | Run memory system smoke test |
| `bun run memory:inspect` | Inspect memory database contents |
| `bun run memory:migrate` | Migrate memory to channel-scoped keys |
| `bun run lint` | Run Biome linter |
| `bun run lint:fix` | Run Biome linter with auto-fix |
| `bun run format` | Format code with Biome |
| `bun run typecheck` | Run TypeScript type checking |

### Hook system

Claude Code hooks are configured in `.claude/settings.json` (generated from `.claude/settings.template.json` by `bun run generate-settings`). The template uses `__ORCHESTRATOR_DIR__` placeholders that are replaced with absolute paths at generation time.

| Hook | Event | Description |
|---|---|---|
| `check-discord-messages` | PostToolUse, SessionStart, UserPromptSubmit, Stop | Delivers unread Discord messages + memory context into Claude's context |
| `steer-send` | PreToolUse (Bash) | Blocks `send-discord` if new messages arrived, forcing a revised reply |
| `safe-bash` | PreToolUse (Bash) | Guards against risky background execution patterns |
| `track-activity` | PreToolUse, PostToolUse, Stop, SessionStart | Tracks agent busy/idle status and writes trace events |
| `cleanup-attachment` | PostToolUse (Read) | Deletes downloaded attachment files after Claude reads them |

---

## Logs

All logs are written to `CC_DISCORD_LOG_DIR` (default: `/tmp/cc-discord/logs`):

| File | Contents |
|---|---|
| `relay.log` | Relay server output |
| `orchestrator.log` | Orchestrator process management |
| `channel-<name>-<id>.log` | Per-channel Claude agent output |

Monitor all logs:

```bash
tail -f /tmp/cc-discord/logs/*.log
```
