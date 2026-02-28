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
- Shows a Discord typing indicator while Claude is working on a reply

## 1) Create Discord app + bot

1. Go to Discord Developer Portal
2. Create app and Bot
3. Enable intents:
   - **Message Content Intent**
   - **Server Members Intent** (optional)
4. Copy bot token
5. Invite bot to your server with permissions to read/send in your target channel

## 2) Configure env

```bash
cp .env.example .env
```

Set at least:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`

Optional:

- `DISCORD_ALLOWED_CHANNEL_IDS` (comma list)
- `RELAY_API_TOKEN` (recommended)
- `DISCORD_SESSION_ID` (default: `default`)
- `CLAUDE_AGENT_ID` (default: `claude`)
- `AUTO_REPLY_PERMISSION_MODE` (`skip` default, or `accept-edits`)
- `TYPING_INTERVAL_MS` (default: `8000`)
- `TYPING_MAX_MS` (default: `120000`)
- `THINKING_FALLBACK_ENABLED` (default: `true`)
- `THINKING_FALLBACK_TEXT` (default: `Still working on that—thanks for your patience.`)

`npm start` and `npm run start:autoreply` both load values from `.env` automatically.
Existing exported shell vars still take precedence for one-off overrides.

For explicit routing to a specific Claude instance, set both:

```env
DISCORD_SESSION_ID=team1
CLAUDE_AGENT_ID=claude-team1
```

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
  2. read inbound message text
  3. `send-discord "...reply..."`
  4. repeat

Run relay (`npm start`) and auto-reply Claude in separate terminals.

## Typing indicator behavior

- When a non-bot Discord message arrives in an allowed channel, relay starts a typing heartbeat for that channel.
- Heartbeat repeats every `TYPING_INTERVAL_MS` (default 8s).
- Heartbeat stops when Claude sends a reply through `send-discord`.
- Safety timeout auto-stops typing after `TYPING_MAX_MS` (default 120s).
- When typing times out, relay can post a fallback status message (`THINKING_FALLBACK_TEXT`) if `THINKING_FALLBACK_ENABLED=true`.

If you change typing env vars, restart the relay process.

## Message format in Claude context

Hook injects:

```text
NEW DISCORD MESSAGE(S): [MESSAGE from discord:123...] [DISCORD_MESSAGE]: username: hello
```

## Notes / limitations (prototype)

- Single-session default (`DISCORD_SESSION_ID=default`)
- Polling-based wait tool (no FIFO wake optimization yet)
- Minimal auth (token optional but recommended)
- No thread mapping yet

## Next polish steps

- Discord thread ↔ Claude session mapping
- FIFO wake-up path (like `cc-dev-team`)
- better rate limit/retry/chunking for long outputs
- automated tests for hook/tool behavior
