#!/bin/bash
# start.sh — Master startup script for cc-discord.
#
# Starts both:
# 1. The relay server (bun server/index.ts) — as a child process
# 2. The orchestrator (orchestrator.sh) — which spawns channel agents
#
# On SIGTERM/SIGINT, cleanly shuts down both.
#
# Usage: start.sh
#
# Prerequisites:
#   - bun installed
#   - claude CLI installed
#   - .env.relay and/or .env.worker configured
#
# Logs:
#   CC_DISCORD_LOG_DIR (default: /tmp/cc-discord/logs)
#   - relay.log          — relay server output
#   - orchestrator.log   — orchestrator process management
#   - channel-<name>.log — per-channel Claude agent output

set -euo pipefail

# Resolve symlinks so ROOT_DIR is correct when invoked via bunx (which symlinks the bin entry)
_SCRIPT="${BASH_SOURCE[0]}"
while [ -L "$_SCRIPT" ]; do
  _DIR="$(cd "$(dirname "$_SCRIPT")" && pwd)"
  _SCRIPT="$(readlink "$_SCRIPT")"
  [[ "$_SCRIPT" != /* ]] && _SCRIPT="$_DIR/$_SCRIPT"
done
ROOT_DIR="$(cd "$(dirname "$_SCRIPT")/.." && pwd)"

# User config directory (~/.config/cc-discord by default, override with CC_DISCORD_CONFIG_DIR)
export CC_DISCORD_CONFIG_DIR="${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}"
if [ ! -d "$CC_DISCORD_CONFIG_DIR" ]; then
  mkdir -p "$CC_DISCORD_CONFIG_DIR"
  log_setup=true
else
  log_setup=false
fi

# Seed example env files into config dir if they don't exist.
# If the user's config already exists but the example is newer, print a hint.
_is_newer() {
  # Return 0 if $1 is newer than $2. Works on both macOS and Linux.
  if stat -f %m "$1" >/dev/null 2>&1; then
    [ "$(stat -f %m "$1")" -gt "$(stat -f %m "$2")" ]
  else
    [ "$(stat -c %Y "$1")" -gt "$(stat -c %Y "$2")" ]
  fi
}
_seed_config() {
  local src="$1" dest="$2"
  [ -f "$src" ] || return 0
  if [ ! -f "$dest" ]; then
    cp "$src" "$dest"
    echo "[start] Seeded $dest — edit this file to configure cc-discord."
  elif _is_newer "$src" "$dest"; then
    echo "[start] NOTE: $(basename "$src") has new options. Compare with your config:"
    echo "[start]   diff $dest $src"
  fi
}
_seed_config "$ROOT_DIR/.env.relay.example" "$CC_DISCORD_CONFIG_DIR/.env.relay"
_seed_config "$ROOT_DIR/.env.worker.example" "$CC_DISCORD_CONFIG_DIR/.env.worker"

if $log_setup; then
  echo "[start] Created config directory: $CC_DISCORD_CONFIG_DIR"
  echo "[start] Edit .env.relay and .env.worker in that directory, then restart."
fi

# Project directory for Claude (skills, settings). Exported for channel-agent.sh.
export CC_DISCORD_HOME="${CC_DISCORD_HOME:-$HOME/.cc-discord}"
mkdir -p "$CC_DISCORD_HOME/.claude/skills"

# Seed built-in skills from the package into the project directory.
if [ -d "$ROOT_DIR/.claude/skills" ] && [ "$ROOT_DIR" != "$CC_DISCORD_HOME" ]; then
  for skill_dir in "$ROOT_DIR/.claude/skills"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    if [ ! -d "$CC_DISCORD_HOME/.claude/skills/$skill_name" ]; then
      cp -r "$skill_dir" "$CC_DISCORD_HOME/.claude/skills/$skill_name"
      echo "[start] Seeded skill: $skill_name"
    fi
  done
fi

# Generate settings.local.json (hooks + relay permissions) so Claude agents see project config.
if [ -f "$ROOT_DIR/.claude/settings.template.json" ]; then
  bash "$ROOT_DIR/scripts/generate-settings.sh"
  if [ "$ROOT_DIR" != "$CC_DISCORD_HOME" ] && [ -f "$ROOT_DIR/.claude/settings.local.json" ]; then
    cp "$ROOT_DIR/.claude/settings.local.json" "$CC_DISCORD_HOME/.claude/settings.local.json"
  fi
fi

# Log directory (shared with orchestrator and channel agents)
export CC_DISCORD_LOG_DIR="${CC_DISCORD_LOG_DIR:-/tmp/cc-discord/logs}"
mkdir -p "$CC_DISCORD_LOG_DIR"

RELAY_LOG="$CC_DISCORD_LOG_DIR/relay.log"
RELAY_PID=""
ORCHESTRATOR_PID=""

log() {
  echo "[start] $(date '+%H:%M:%S') $*"
}

cleanup() {
  log "Shutting down..."

  if [ -n "$ORCHESTRATOR_PID" ] && kill -0 "$ORCHESTRATOR_PID" 2>/dev/null; then
    log "Stopping orchestrator (PID $ORCHESTRATOR_PID)..."
    kill -TERM "$ORCHESTRATOR_PID" 2>/dev/null || true
    wait "$ORCHESTRATOR_PID" 2>/dev/null || true
  fi

  if [ -n "$RELAY_PID" ] && kill -0 "$RELAY_PID" 2>/dev/null; then
    log "Stopping relay server (PID $RELAY_PID)..."
    kill -TERM "$RELAY_PID" 2>/dev/null || true
    wait "$RELAY_PID" 2>/dev/null || true
  fi

  # Remove generated settings.local.json so hooks don't fire during normal development
  rm -f "$ROOT_DIR/.claude/settings.local.json"
  rm -f "$CC_DISCORD_HOME/.claude/settings.local.json"

  log "All processes stopped."
  exit 0
}

trap cleanup SIGTERM SIGINT

# ---- Start relay server ----
log "Starting relay server..."
bash "$ROOT_DIR/scripts/start-relay.sh" >> "$RELAY_LOG" 2>&1 &
RELAY_PID=$!
log "Relay server started (PID $RELAY_PID, log: $RELAY_LOG)"

# Wait for relay to be ready
MAX_WAIT=30
WAITED=0
source "$ROOT_DIR/scripts/load-env.sh"
load_env_file "$ROOT_DIR/.env.worker"
load_env_file "$CC_DISCORD_CONFIG_DIR/.env.worker"
load_env_file "$ROOT_DIR/.env"
load_env_file "$CC_DISCORD_CONFIG_DIR/.env"
RELAY_HOST="${RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${RELAY_PORT:-3199}"
RELAY_API_TOKEN="${RELAY_API_TOKEN:-}"

# Ensure bun/curl/claude are findable
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# ---- Pre-flight: Claude auth check ----
if ! claude auth status >/dev/null 2>&1; then
  log "ERROR: Claude CLI is not authenticated."
  log "Run 'claude auth login' to log in, then try again."
  kill -TERM "$RELAY_PID" 2>/dev/null || true
  wait "$RELAY_PID" 2>/dev/null || true
  exit 1
fi
log "Claude auth verified."

while ! curl -s --max-time 2 -H "x-api-token: ${RELAY_API_TOKEN}" "http://${RELAY_HOST}:${RELAY_PORT}/api/channels" >/dev/null 2>&1; do
  if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    log "ERROR: Relay server exited unexpectedly. Check $RELAY_LOG"
    exit 1
  fi
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    log "ERROR: Relay server did not become ready within ${MAX_WAIT}s. Check $RELAY_LOG"
    cleanup
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

log "Relay server is ready."

# ---- Start orchestrator ----
log "Starting orchestrator..."
bash "$ROOT_DIR/scripts/orchestrator.sh" &
ORCHESTRATOR_PID=$!
log "Orchestrator started (PID $ORCHESTRATOR_PID, log: $CC_DISCORD_LOG_DIR/orchestrator.log)"

# Print monitoring instructions
log ""
log "=== cc-discord is running ==="
log "  Relay:        PID $RELAY_PID"
log "  Orchestrator: PID $ORCHESTRATOR_PID"
log ""
log "  Log directory: $CC_DISCORD_LOG_DIR"
log "  Monitor all:   tail -f $CC_DISCORD_LOG_DIR/*.log"
log "  Monitor relay: tail -f $RELAY_LOG"
log "  Monitor agent: tail -f $CC_DISCORD_LOG_DIR/channel-<name>.log"
log ""
log "  Press Ctrl+C to stop all processes."
log "==============================="

# Monitor both processes — if either exits, shut down the other
while true; do
  if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    log "Relay server exited. Shutting down orchestrator..."
    cleanup
  fi
  if ! kill -0 "$ORCHESTRATOR_PID" 2>/dev/null; then
    log "Orchestrator exited. Shutting down relay..."
    cleanup
  fi
  sleep 5
done
