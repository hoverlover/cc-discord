#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"

WORKER_KEYS=(
  DISCORD_SESSION_ID
  CLAUDE_AGENT_ID
  RELAY_HOST
  RELAY_PORT
  RELAY_URL
  RELAY_API_TOKEN
  AUTO_REPLY_PERMISSION_MODE
)

# Preferred split env file for worker process
load_env_keys "$ROOT_DIR/.env.worker" "${WORKER_KEYS[@]}"
# Legacy fallback (single-file mode)
load_env_keys "$ROOT_DIR/.env" "${WORKER_KEYS[@]}"

SETTINGS_PATH="$ROOT_DIR/.claude/settings.json"
SYSTEM_PROMPT_PATH="$ROOT_DIR/prompts/autoreply-system.md"

if ! command -v claude >/dev/null 2>&1; then
  echo "Error: 'claude' CLI not found on PATH"
  exit 1
fi

if [ ! -f "$SETTINGS_PATH" ]; then
  echo "Generating settings..."
  bash "$ROOT_DIR/scripts/generate-settings.sh"
fi

if [ ! -f "$SYSTEM_PROMPT_PATH" ]; then
  echo "Missing prompt file: $SYSTEM_PROMPT_PATH"
  exit 1
fi

# Defensive cleanup in case parent shell exported relay-only secrets
unset DISCORD_BOT_TOKEN DISCORD_CHANNEL_ID DISCORD_ALLOWED_CHANNEL_IDS

export PATH="$ROOT_DIR/tools:$PATH"
export ORCHESTRATOR_DIR="$ROOT_DIR"
export DISCORD_SESSION_ID="${DISCORD_SESSION_ID:-default}"

# Routing identity for this Claude instance:
# - AGENT_ID is what hooks/tools use while running
# - CLAUDE_AGENT_ID is what relay writes to in SQLite
# Default behavior keeps them aligned.
if [ -z "${AGENT_ID:-}" ]; then
  export AGENT_ID="${CLAUDE_AGENT_ID:-claude}"
fi
export CLAUDE_AGENT_ID="${CLAUDE_AGENT_ID:-$AGENT_ID}"

SYSTEM_PROMPT="$(cat "$SYSTEM_PROMPT_PATH")"
INITIAL_PROMPT="Start now. First action: run wait-for-discord-messages --deliver --timeout 600. Then follow your autonomous Discord loop forever."

# Default to non-interactive permission behavior so auto-reply does not stall.
# Override with AUTO_REPLY_PERMISSION_MODE=accept-edits for safer interactive-ish behavior.
if [ "${AUTO_REPLY_PERMISSION_MODE:-skip}" = "accept-edits" ]; then
  PERMISSION_ARGS=(--permission-mode acceptEdits)
else
  PERMISSION_ARGS=(--dangerously-skip-permissions)
fi

echo "Starting Claude auto-reply mode (session=$DISCORD_SESSION_ID, agent=$AGENT_ID, permission_mode=${AUTO_REPLY_PERMISSION_MODE:-skip})..."
exec claude \
  --settings "$SETTINGS_PATH" \
  "${PERMISSION_ARGS[@]}" \
  --append-system-prompt "$SYSTEM_PROMPT" \
  -- "$INITIAL_PROMPT"
