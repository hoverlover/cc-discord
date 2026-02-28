# cc-discord (prototype)

Quick-and-dirty **Discord ↔ Claude Code** relay using the same hook concept as `cc-dev-team`:

- Discord messages are queued in SQLite
- Claude hook (`check-discord-messages.js`) injects unread messages as context
- Claude replies with `send-discord` tool (no terminal text injection)

## What this prototype does

- Listens to one Discord channel (or allowlist of channels)
- Stores inbound messages in `data/messages.db`
- Delivers them to Claude through hooks on:
  - `SessionStart`
  - `PostToolUse`
  - `UserPromptSubmit`
  - `Stop` (blocks stop if unread messages exist)
- Provides tools:
  - `send-discord "message"`
  - `wait-for-discord-messages --deliver`
- Adds Bash safety guardrails (blocks `run_in_background` and standalone `&` by default)
- Shows a Discord typing indicator while Claude is working on a reply

## 1) Create Discord app + bot

1. Go to Discord Developer Portal
2. Create app and Bot
3. Enable intents:
   - **Message Content Intent**
   - **Server Members Intent** (optional)
4. Copy bot token
5. Invite bot to your server with permissions to read/send in your target channel

## 2) Configure env (split relay/worker files)

```bash
cp .env.relay.example .env.relay
cp .env.worker.example .env.worker
```

### Required in `.env.relay`

- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`
- `RELAY_API_TOKEN` (**required by default**, recommended)

### Required in `.env.worker`

- `DISCORD_SESSION_ID`
- `CLAUDE_AGENT_ID`
- `RELAY_API_TOKEN` (must match relay token when auth is enabled)

### Important: routing values must match across files

Set the same values in both files:

```env
DISCORD_SESSION_ID=team1
CLAUDE_AGENT_ID=claude-team1
```

### Optional settings

Relay-side (`.env.relay`):
- `DISCORD_ALLOWED_CHANNEL_IDS` (comma list)
- `ALLOWED_DISCORD_USER_IDS` (comma list of user IDs)
- `RELAY_ALLOW_NO_AUTH` (`false` default; set `true` only for local dev)
- `TYPING_INTERVAL_MS` (default: `8000`)
- `TYPING_MAX_MS` (default: `120000`)
- `THINKING_FALLBACK_ENABLED` (default: `true`)
- `THINKING_FALLBACK_TEXT` (default: `Still working on that—thanks for your patience.`)
- `BUSY_NOTIFY_ON_QUEUE` (default: `true`)
- `BUSY_NOTIFY_COOLDOWN_MS` (default: `30000`)

Worker-side (`.env.worker`):
- `RELAY_HOST` / `RELAY_PORT` (or `RELAY_URL`)
- `AUTO_REPLY_PERMISSION_MODE` (`skip` default, or `accept-edits`)
- `CLAUDE_RUNTIME_ID` (optional runtime hint; auto-generated at start if omitted)
- `WAIT_QUIET_TIMEOUT` (`true` default; timeout exits quietly)
- `BASH_POLICY_MODE` (`block` default, or `allow` with notifications)
- `ALLOW_BASH_RUN_IN_BACKGROUND` (`false` default)
- `ALLOW_BASH_BACKGROUND_OPS` (`false` default)
- `BASH_POLICY_NOTIFY_ON_BLOCK` (`true` default)
- `BASH_POLICY_NOTIFY_CHANNEL_ID` (optional)

`npm start` loads `.env.relay` and `npm run start:autoreply` loads `.env.worker`.
Legacy single-file `.env` is still supported as fallback.
Existing exported shell vars still take precedence for one-off overrides.

Security note: `start:autoreply` intentionally loads only worker-safe env vars and does **not** pass `DISCORD_BOT_TOKEN` to Claude.

### Hardening defaults

- Relay API auth is **required** unless `RELAY_ALLOW_NO_AUTH=true`.
- Keep `RELAY_HOST=127.0.0.1` unless you intentionally expose relay externally.
- Restrict channels with `DISCORD_ALLOWED_CHANNEL_IDS`.
- Optionally restrict users with `ALLOWED_DISCORD_USER_IDS`.
- Bash safety guard blocks risky background patterns by default and sends Discord notifications when triggered.

## 3) Install + start relay

```bash
npm install
npm start
```

Health check:

```bash
curl http://127.0.0.1:3199/health
```

## 4) Generate Claude settings

```bash
npm run generate-settings
```

This creates:

- `.claude/settings.json` with absolute hook path

## 5) Run Claude Code with this settings file

Example:

```bash
claude --settings /Users/cboyd/code/cc-discord/.claude/settings.json
```

Make sure tools are on PATH for Claude session:

```bash
export PATH="/Users/cboyd/code/cc-discord/tools:$PATH"
```

Then Claude can call:

```bash
send-discord "Got it — working on this now."
```

## 6) Automatic reply mode (no manual prompting)

Start Claude in auto-reply mode:

```bash
cd /Users/cboyd/code/cc-discord
npm run start:autoreply
```

By default this runs Claude with:

```bash
--dangerously-skip-permissions
```

so it does not stall on approval prompts.

If you want safer behavior, set this in `.env`:

```env
AUTO_REPLY_PERMISSION_MODE=accept-edits
```

(or run once with `AUTO_REPLY_PERMISSION_MODE=accept-edits npm run start:autoreply`).

What this does:

- loads `.claude/settings.json` (hooks enabled)
- adds an auto-reply system prompt (`prompts/autoreply-system.md`)
- starts an infinite loop:
  1. `wait-for-discord-messages --deliver --timeout 600`
  2. if output contains new messages, read and respond
  3. `send-discord "...reply..."`
  4. repeat

The wait command now enforces a singleton PID lock per agent/session to prevent stacked pollers.
Timeouts are quiet by default and return exit code 0 (to reduce noisy background failure spam).

Run relay (`npm start`) and auto-reply Claude in separate terminals.

## Typing indicator behavior

- When a non-bot Discord message arrives in an allowed channel, relay starts a typing heartbeat for that channel.
- Heartbeat repeats every `TYPING_INTERVAL_MS` (default 8s).
- Heartbeat stops when Claude sends a reply through `send-discord`.
- Safety timeout auto-stops typing after `TYPING_MAX_MS` (default 120s).
- When typing times out, relay can post a fallback status message (`THINKING_FALLBACK_TEXT`) if `THINKING_FALLBACK_ENABLED=true`.
- If Claude is currently busy on a different tool, relay can send a queued notice:
  - "Currently busy with X, queued your message..." (configurable via `BUSY_NOTIFY_*`).

If you change typing/busy-notify env vars, restart the relay process.

## Message format in Claude context

Hook injects inbox messages and (when available) selected memory context:

```text
NEW DISCORD MESSAGE(S): [MESSAGE from discord:123...] [DISCORD_MESSAGE]: username: hello

MEMORY CONTEXT:
Session summary:
...
Relevant long-term memory (outside current window):
...
```

Memory retrieval is runtime-aware: it avoids re-injecting turns from the current Claude runtime context, while prioritizing relevant older memory (and compacted summaries) outside that context. `SessionStart` events (including `/new`) rotate runtime context for recall filtering.

## Notes / limitations (prototype)

- Single-session default (`DISCORD_SESSION_ID=default`)
- Polling-based wait tool (no FIFO wake optimization yet)
- Relay API token auth is enabled by default (`RELAY_ALLOW_NO_AUTH=false`)
- No thread mapping yet

## Memory module (v1 foundation)

A pluggable memory foundation now exists under `memory/` with SQLite as primary store.

Run a quick validation:

```bash
npm run memory:smoke
```

This verifies schema init, idempotent batch writes, snapshots, turns, and cards.

## Next polish steps

- Discord thread ↔ Claude session mapping
- FIFO wake-up path (like `cc-dev-team`)
- better rate limit/retry/chunking for long outputs
- automated tests for hook/tool behavior
