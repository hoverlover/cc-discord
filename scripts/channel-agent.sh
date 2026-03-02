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

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
  BASH_POLICY_NOTIFY_CHANNEL_ID
)
load_env_keys "$ROOT_DIR/.env.worker" "${WORKER_KEYS[@]}"
load_env_keys "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env.worker" "${WORKER_KEYS[@]}"
load_env_keys "$ROOT_DIR/.env" "${WORKER_KEYS[@]}"
load_env_keys "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env" "${WORKER_KEYS[@]}"

# Ensure bun is on PATH for hooks/tools
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$ROOT_DIR/tools:$PATH"

SETTINGS_PATH="$ROOT_DIR/.claude/settings.json"
PROMPT_TEMPLATE="$ROOT_DIR/prompts/channel-system.md"

if ! command -v claude >/dev/null 2>&1; then
  echo "[channel-agent:$CHANNEL_NAME] Error: 'claude' CLI not found on PATH" >&2
  exit 1
fi

if [ ! -f "$SETTINGS_PATH" ]; then
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

# Build the channel-specific system prompt
SYSTEM_PROMPT="$(sed \
  -e "s|__CHANNEL_ID__|${CHANNEL_ID}|g" \
  -e "s|__CHANNEL_NAME__|${CHANNEL_NAME}|g" \
  "$PROMPT_TEMPLATE")"

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

# Write the system prompt to a temp file to avoid quoting issues in pipes.
PROMPT_FILE=$(mktemp /tmp/cc-discord-prompt-XXXXXX)
printf '%s' "$SYSTEM_PROMPT" > "$PROMPT_FILE"

# On exit: clean up temp file, kill orphaned pollers, and kill child processes.
cleanup_agent() {
  rm -f "$PROMPT_FILE"
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

# Run claude in headless/print mode with stream-json output.
# The stream is piped through the parser which extracts reasoning, tool
# calls, and errors into human-readable log lines.
# If the parser is missing, fall back to raw output.
if [ -f "$PARSER" ]; then
  claude \
    -p \
    --output-format stream-json \
    --verbose \
    --settings "$SETTINGS_PATH" \
    "${PERMISSION_ARGS[@]}" \
    --system-prompt-file "$PROMPT_FILE" \
    --no-session-persistence \
    -- "Begin listening for messages in #${CHANNEL_NAME} now." 2>&1 \
  | bun "$PARSER" >> "$LOG_FILE" 2>&1
else
  echo "[channel-agent:$CHANNEL_NAME] WARNING: Parser not found at $PARSER — using raw output"
  claude \
    -p \
    --output-format stream-json \
    --settings "$SETTINGS_PATH" \
    "${PERMISSION_ARGS[@]}" \
    --system-prompt-file "$PROMPT_FILE" \
    --no-session-persistence \
    -- "Begin listening for messages in #${CHANNEL_NAME} now." \
    >> "$LOG_FILE" 2>&1
fi
