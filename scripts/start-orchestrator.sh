#!/bin/bash
set -euo pipefail

_SCRIPT="${BASH_SOURCE[0]}"
while [ -L "$_SCRIPT" ]; do
  _DIR="$(cd "$(dirname "$_SCRIPT")" && pwd)"
  _SCRIPT="$(readlink "$_SCRIPT")"
  [[ "$_SCRIPT" != /* ]] && _SCRIPT="$_DIR/$_SCRIPT"
done
ROOT_DIR="$(cd "$(dirname "$_SCRIPT")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"

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

# Preferred split env file for worker process
load_env_keys "$ROOT_DIR/.env.worker" "${WORKER_KEYS[@]}"
load_env_keys "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env.worker" "${WORKER_KEYS[@]}"
# Legacy fallback (single-file mode)
load_env_keys "$ROOT_DIR/.env" "${WORKER_KEYS[@]}"
load_env_keys "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env" "${WORKER_KEYS[@]}"

SETTINGS_PATH="$ROOT_DIR/.claude/settings.local.json"
SYSTEM_PROMPT_PATH="$ROOT_DIR/prompts/orchestrator-system.md"

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
export CLAUDE_RUNTIME_ID="${CLAUDE_RUNTIME_ID:-rt_$(date +%s)_$RANDOM}"

# Routing identity for this Claude instance:
# - AGENT_ID is what hooks/tools use while running
# - CLAUDE_AGENT_ID is what relay writes to in SQLite
# Default behavior keeps them aligned.
if [ -z "${AGENT_ID:-}" ]; then
  export AGENT_ID="${CLAUDE_AGENT_ID:-claude}"
fi
export CLAUDE_AGENT_ID="${CLAUDE_AGENT_ID:-$AGENT_ID}"

SYSTEM_PROMPT="$(cat "$SYSTEM_PROMPT_PATH")"
INITIAL_PROMPT="Start now. Discover channels and spawn subagents. Then begin your health check loop."

# Default to non-interactive permission behavior so orchestrator does not stall.
# Override with AUTO_REPLY_PERMISSION_MODE=accept-edits for safer interactive-ish behavior.
if [ "${AUTO_REPLY_PERMISSION_MODE:-skip}" = "accept-edits" ]; then
  PERMISSION_ARGS=(--permission-mode acceptEdits)
else
  PERMISSION_ARGS=(--dangerously-skip-permissions)
fi

echo "Starting Claude orchestrator (session=$DISCORD_SESSION_ID, agent=$AGENT_ID, runtime=$CLAUDE_RUNTIME_ID, permission_mode=${AUTO_REPLY_PERMISSION_MODE:-skip})..."
exec claude \
  --settings "$SETTINGS_PATH" \
  "${PERMISSION_ARGS[@]}" \
  --append-system-prompt "$SYSTEM_PROMPT" \
  -- "$INITIAL_PROMPT"
