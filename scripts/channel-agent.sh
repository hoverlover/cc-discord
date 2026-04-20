#!/bin/bash
# channel-agent.sh — Run a single Claude channel agent in headless (-p) mode.
#
# Usage: channel-agent.sh <channel_id> <channel_name>
#
# Designed to be spawned by orchestrator.sh. Each invocation runs one
# claude -p session that polls for messages and replies. When claude
# exits (e.g., max turns, cost limit, or normal stop), the orchestrator
# restarts this script to create a persistent loop.

set -euo pipefail

CHANNEL_ID="${1:?Usage: channel-agent.sh <channel_id> <channel_name>}"
CHANNEL_NAME="${2:-channel-$CHANNEL_ID}"

_SCRIPT="${BASH_SOURCE[0]}"
while [ -L "$_SCRIPT" ]; do
  _DIR="$(cd "$(dirname "$_SCRIPT")" && pwd)"
  _SCRIPT="$(readlink "$_SCRIPT")"
  [[ "$_SCRIPT" != /* ]] && _SCRIPT="$_DIR/$_SCRIPT"
done
ROOT_DIR="$(cd "$(dirname "$_SCRIPT")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"

# Load worker env vars (same set as start-orchestrator.sh)
WORKER_KEYS=(
  DISCORD_SESSION_ID
  CLAUDE_AGENT_ID
  RELAY_HOST
  RELAY_PORT
  RELAY_URL
  RELAY_API_TOKEN
  AUTO_REPLY_PERMISSION_MODE
  CLAUDE_RUNTIME_ID
  WAIT_QUIET_TIMEOUT
  BASH_POLICY_MODE
  ALLOW_BASH_RUN_IN_BACKGROUND
  ALLOW_BASH_BACKGROUND_OPS
  BASH_POLICY_NOTIFY_ON_BLOCK
)
load_env_keys "$ROOT_DIR/.env.worker" "${WORKER_KEYS[@]}"
load_env_keys "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env.worker" "${WORKER_KEYS[@]}"
load_env_keys "$ROOT_DIR/.env" "${WORKER_KEYS[@]}"
load_env_keys "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env" "${WORKER_KEYS[@]}"

# Ensure bun is on PATH for hooks/tools
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$ROOT_DIR/tools:$PATH"

SETTINGS_PATH="$ROOT_DIR/.claude/settings.local.json"
PROMPT_TEMPLATE="$ROOT_DIR/prompts/channel-system.md"

if ! command -v claude >/dev/null 2>&1; then
  echo "[channel-agent:$CHANNEL_NAME] Error: 'claude' CLI not found on PATH" >&2
  exit 1
fi

if [ ! -f "$SETTINGS_PATH" ] || [ "$ROOT_DIR/.claude/settings.template.json" -nt "$SETTINGS_PATH" ]; then
  echo "[channel-agent:$CHANNEL_NAME] Generating settings..."
  bash "$ROOT_DIR/scripts/generate-settings.sh"
fi

if [ ! -f "$PROMPT_TEMPLATE" ]; then
  echo "[channel-agent:$CHANNEL_NAME] Missing prompt template: $PROMPT_TEMPLATE" >&2
  exit 1
fi

# Defensive cleanup: never leak relay-only secrets to Claude
unset DISCORD_BOT_TOKEN DISCORD_CHANNEL_ID DISCORD_ALLOWED_CHANNEL_IDS

# Kill orphaned poller processes from previous runs of this channel agent.
# These linger when Claude exits but its child wait-for-discord-messages keeps polling.
POLLER_LOCK="/tmp/cc-discord/poller-${CHANNEL_ID}-${DISCORD_SESSION_ID:-default}.lock"
if [ -f "$POLLER_LOCK" ]; then
  OLD_PID=$(cat "$POLLER_LOCK" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[channel-agent:$CHANNEL_NAME] Killing orphaned poller (PID $OLD_PID)"
    kill -TERM "$OLD_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$POLLER_LOCK"
fi

export ORCHESTRATOR_DIR="$ROOT_DIR"
export DISCORD_SESSION_ID="${DISCORD_SESSION_ID:-default}"
export AGENT_ID="$CHANNEL_ID"
export CLAUDE_AGENT_ID="${CLAUDE_AGENT_ID:-claude-discord}"
export CLAUDE_RUNTIME_ID="${CLAUDE_RUNTIME_ID:-rt_$(date +%s)_${RANDOM}}"

# Project directory — inherited from start.sh, or derived here for standalone use.
CLAUDE_PROJECT_DIR="${CC_DISCORD_HOME:-$HOME/.cc-discord}"
cd "$CLAUDE_PROJECT_DIR"
echo "[channel-agent:$CHANNEL_NAME] Claude project dir: $CLAUDE_PROJECT_DIR"

# Build the channel-specific system prompt
SYSTEM_PROMPT="$(sed \
  -e "s|__CHANNEL_ID__|${CHANNEL_ID}|g" \
  -e "s|__CHANNEL_NAME__|${CHANNEL_NAME}|g" \
  "$PROMPT_TEMPLATE")"

# Returns 0 if the given JSON response indicates the channel no longer exists in Discord.
is_channel_gone_response() {
  echo "$1" | bun -e "
    const input = require('fs').readFileSync(0, 'utf8');
    try {
      const data = JSON.parse(input);
      process.exit(data && data.code === 'UNKNOWN_CHANNEL' ? 0 : 1);
    } catch { process.exit(1); }
  " 2>/dev/null
}

# Mark this channel as gone so the orchestrator prunes it instead of restarting.
mark_channel_gone() {
  mkdir -p /tmp/cc-discord
  : > "/tmp/cc-discord/agent-${CHANNEL_ID}.gone"
}

# Fetch any pinned system prompt override from the channel
RELAY_URL="${RELAY_URL:-http://${RELAY_HOST:-127.0.0.1}:${RELAY_PORT:-3199}}"
PINNED_PROMPT=""
if [ -n "$RELAY_API_TOKEN" ]; then
  PINNED_RESPONSE=$(curl -s --max-time 10 \
    -H "x-api-token: ${RELAY_API_TOKEN}" \
    "${RELAY_URL}/api/channels/${CHANNEL_ID}/pinned-prompt" 2>/dev/null) || true
  if is_channel_gone_response "$PINNED_RESPONSE"; then
    echo "[channel-agent:$CHANNEL_NAME] Channel ${CHANNEL_ID} no longer exists in Discord — exiting so orchestrator can prune it"
    mark_channel_gone
    exit 0
  fi
  PINNED_PROMPT=$(echo "$PINNED_RESPONSE" | bun -e "
    const input = require('fs').readFileSync(0, 'utf8');
    try {
      const data = JSON.parse(input);
      if (data.success && data.prompt) {
        process.stdout.write(data.prompt);
      }
    } catch {}
  " 2>/dev/null) || true
fi

if [ -n "$PINNED_PROMPT" ]; then
  echo "[channel-agent:$CHANNEL_NAME] Appending pinned system prompt (${#PINNED_PROMPT} chars)"
  SYSTEM_PROMPT="${SYSTEM_PROMPT}

## Channel-specific instructions (authoritative current prompt)

${PINNED_PROMPT}

If earlier conversation state conflicts with this prompt, follow this prompt."
else
  echo "[channel-agent:$CHANNEL_NAME] No channel-specific prompt found at startup"
fi

# Permission mode
if [ "${AUTO_REPLY_PERMISSION_MODE:-skip}" = "accept-edits" ]; then
  PERMISSION_ARGS=(--permission-mode acceptEdits)
else
  PERMISSION_ARGS=(--dangerously-skip-permissions)
fi

# Log directory
LOG_DIR="${CC_DISCORD_LOG_DIR:-/tmp/cc-discord/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/channel-${CHANNEL_NAME}-${CHANNEL_ID}.log"

PARSER="$ROOT_DIR/scripts/parse-claude-stream.ts"

echo "[channel-agent:$CHANNEL_NAME] Starting claude -p (channel=$CHANNEL_ID, session=$DISCORD_SESSION_ID, runtime=$CLAUDE_RUNTIME_ID)"
echo "[channel-agent:$CHANNEL_NAME] Logging to $LOG_FILE"

# Write PID so the relay can signal us for event-driven restarts
AGENT_PID_FILE="/tmp/cc-discord/agent-${CHANNEL_ID}.pid"
printf '%s' "$$" > "$AGENT_PID_FILE"

# Write the system prompt to a temp file to avoid quoting issues in pipes.
PROMPT_FILE=$(mktemp /tmp/cc-discord-prompt-XXXXXX)
printf '%s' "$SYSTEM_PROMPT" > "$PROMPT_FILE"

DATA_DIR="${CC_DISCORD_DATA_DIR:-${HOME}/.cc-discord/data}"
MESSAGES_DB_PATH="${DATA_DIR}/messages.db"

load_stored_session_id() {
  [ -f "$MESSAGES_DB_PATH" ] || return 0
  MESSAGES_DB_PATH="$MESSAGES_DB_PATH" CHANNEL_ID="$CHANNEL_ID" bun -e '
    import { Database } from "bun:sqlite";
    const dbPath = process.env.MESSAGES_DB_PATH;
    const channelId = process.env.CHANNEL_ID;
    if (!dbPath || !channelId) process.exit(0);
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_agent_sessions (
        channel_id TEXT PRIMARY KEY,
        claude_session_id TEXT NOT NULL,
        session_name TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const row = db.prepare("SELECT claude_session_id FROM channel_agent_sessions WHERE channel_id = ?").get(channelId) as any;
    if (row?.claude_session_id) process.stdout.write(String(row.claude_session_id));
    db.close();
  ' 2>/dev/null || true
}

clear_stored_session_id() {
  [ -f "$MESSAGES_DB_PATH" ] || return 0
  MESSAGES_DB_PATH="$MESSAGES_DB_PATH" CHANNEL_ID="$CHANNEL_ID" bun -e '
    import { Database } from "bun:sqlite";
    const dbPath = process.env.MESSAGES_DB_PATH;
    const channelId = process.env.CHANNEL_ID;
    if (!dbPath || !channelId) process.exit(0);
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_agent_sessions (
        channel_id TEXT PRIMARY KEY,
        claude_session_id TEXT NOT NULL,
        session_name TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.prepare("DELETE FROM channel_agent_sessions WHERE channel_id = ?").run(channelId);
    db.close();
  ' 2>/dev/null || true
}

STORED_CLAUDE_SESSION_ID="$(load_stored_session_id)"
if [ -n "$STORED_CLAUDE_SESSION_ID" ]; then
  echo "[channel-agent:$CHANNEL_NAME] Resuming Claude session $STORED_CLAUDE_SESSION_ID"
else
  echo "[channel-agent:$CHANNEL_NAME] Starting fresh Claude session"
fi

# Hash helper for comparing pinned prompts
hash_string() {
  if command -v md5sum >/dev/null 2>&1; then
    printf '%s' "$1" | md5sum | awk '{print $1}'
  elif command -v md5 >/dev/null 2>&1; then
    printf '%s' "$1" | md5 -q
  else
    printf '%s' "$1" | openssl dgst -md5 | awk '{print $NF}'
  fi
}

PROMPT_HASH_FILE="/tmp/cc-discord/pinned-prompt-hash-${CHANNEL_ID}"
INITIAL_HASH=$(hash_string "${PINNED_PROMPT}")
printf '%s' "$INITIAL_HASH" > "$PROMPT_HASH_FILE"

# On exit: clean up temp file, kill orphaned pollers, and kill child processes.
cleanup_agent() {
  rm -f "$PROMPT_FILE"
  rm -f "$AGENT_PID_FILE"
  # Kill any poller left behind by this session
  if [ -f "$POLLER_LOCK" ]; then
    local lpid
    lpid=$(cat "$POLLER_LOCK" 2>/dev/null)
    if [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null; then
      kill -TERM "$lpid" 2>/dev/null || true
    fi
    rm -f "$POLLER_LOCK"
  fi
  # Kill any remaining children (claude, parser, pollers)
  local pids
  pids=$(jobs -p 2>/dev/null) || true
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
  fi
}
trap cleanup_agent EXIT

# Background watcher: restart this agent when the pinned prompt changes
(
  trap '' TERM INT
  WATCH_INTERVAL=300
  while true; do
    sleep "$WATCH_INTERVAL"
    response=$(curl -s --max-time 10 \
      -H "x-api-token: ${RELAY_API_TOKEN}" \
      "${RELAY_URL}/api/channels/${CHANNEL_ID}/pinned-prompt" 2>/dev/null) || continue
    if is_channel_gone_response "$response"; then
      echo "[channel-agent:$CHANNEL_NAME] Channel ${CHANNEL_ID} no longer exists in Discord — signaling orchestrator to prune"
      mark_channel_gone
      kill -TERM "$$" 2>/dev/null || true
      sleep 2
      kill -KILL "$$" 2>/dev/null || true
      break
    fi
    pinned=$(echo "$response" | bun -e "
      const input = require('fs').readFileSync(0, 'utf8');
      try {
        const data = JSON.parse(input);
        if (data.success && data.prompt) {
          process.stdout.write(data.prompt);
        }
      } catch {}
    " 2>/dev/null) || continue
    current_hash=$(hash_string "${pinned}")
    last_hash=$(cat "$PROMPT_HASH_FILE" 2>/dev/null || echo "")
    if [ "$current_hash" != "$last_hash" ]; then
      echo "[channel-agent:$CHANNEL_NAME] Detected pinned prompt change. Restarting agent..."
      printf '%s' "$current_hash" > "$PROMPT_HASH_FILE"
      send-discord --channel "$CHANNEL_ID" "Restarting to apply updated channel system prompt..."
      # Kill the main script to trigger an orchestrator restart
      kill -TERM "$$" 2>/dev/null || true
      sleep 2
      kill -KILL "$$" 2>/dev/null || true
      break
    fi
  done
) &

WATCHER_PID=$!

run_claude_once() {
  local resume_id="$1"
  local -a args
  args=(
    -p
    --output-format stream-json
    --verbose
    --settings "$SETTINGS_PATH"
    "${PERMISSION_ARGS[@]}"
    --append-system-prompt-file "$PROMPT_FILE"
  )

  if [ -n "$resume_id" ]; then
    args+=(--resume "$resume_id")
  fi

  if [ -f "$PARSER" ]; then
    claude "${args[@]}" -- "Begin listening for messages in #${CHANNEL_NAME} now." 2>&1 \
      | bun "$PARSER" >> "$LOG_FILE" 2>&1
  else
    echo "[channel-agent:$CHANNEL_NAME] WARNING: Parser not found at $PARSER — using raw output"
    claude "${args[@]}" -- "Begin listening for messages in #${CHANNEL_NAME} now." \
      >> "$LOG_FILE" 2>&1
  fi
}

CLAUDE_EXIT=0
if [ -n "$STORED_CLAUDE_SESSION_ID" ]; then
  set +e
  run_claude_once "$STORED_CLAUDE_SESSION_ID"
  CLAUDE_EXIT=$?
  set -e
  if [ "$CLAUDE_EXIT" -ne 0 ]; then
    echo "[channel-agent:$CHANNEL_NAME] Resume failed for Claude session $STORED_CLAUDE_SESSION_ID; clearing stored session and starting fresh"
    clear_stored_session_id
    STORED_CLAUDE_SESSION_ID=""
    set +e
    run_claude_once ""
    CLAUDE_EXIT=$?
    set -e
  fi
else
  set +e
  run_claude_once ""
  CLAUDE_EXIT=$?
  set -e
fi

# Normal exit: stop the watcher
kill "$WATCHER_PID" 2>/dev/null || true
wait "$WATCHER_PID" 2>/dev/null || true
exit "$CLAUDE_EXIT"
