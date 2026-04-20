#!/bin/bash
# orchestrator.sh — Discover Discord channels and manage channel-agents on demand.
#
# This is a pure shell script (no Claude instance). It:
# 1. Queries the relay API for active channels
# 2. Optionally spawns one channel-agent.sh per discovered channel (eager mode)
# 3. In lazy mode, only spawns channel-agent.sh when unread messages exist
# 4. Monitors children and restarts any that exit
# 5. On SIGTERM/SIGINT, kills all children and exits cleanly
#
# Usage: orchestrator.sh
#
# Environment:
#   RELAY_HOST, RELAY_PORT, RELAY_API_TOKEN — relay server coordinates
#   HEALTH_CHECK_INTERVAL — seconds between health checks (default: 30)
#   AGENT_RESTART_DELAY — seconds to wait before restarting a dead agent (default: 5)
#   STUCK_AGENT_THRESHOLD — seconds without heartbeat + unread msgs = stuck (default: 900)
#   EAGER_CHANNEL_STARTUP — true to start Claude in every discovered channel at boot (default: false)

set -euo pipefail

_SCRIPT="${BASH_SOURCE[0]}"
while [ -L "$_SCRIPT" ]; do
  _DIR="$(cd "$(dirname "$_SCRIPT")" && pwd)"
  _SCRIPT="$(readlink "$_SCRIPT")"
  [[ "$_SCRIPT" != /* ]] && _SCRIPT="$_DIR/$_SCRIPT"
done
ROOT_DIR="$(cd "$(dirname "$_SCRIPT")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"

# Load relay connection env vars
load_env_file "$ROOT_DIR/.env.worker"
load_env_file "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env.worker"
load_env_file "$ROOT_DIR/.env"
load_env_file "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env"

# Ensure bun/curl are findable
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

RELAY_HOST="${RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${RELAY_PORT:-3199}"
RELAY_API_TOKEN="${RELAY_API_TOKEN:-}"
HEALTH_CHECK_INTERVAL="${HEALTH_CHECK_INTERVAL:-30}"
AGENT_RESTART_DELAY="${AGENT_RESTART_DELAY:-5}"
EAGER_CHANNEL_STARTUP="${EAGER_CHANNEL_STARTUP:-false}"

RELAY_URL="http://${RELAY_HOST}:${RELAY_PORT}"

# Track child PIDs and names using parallel indexed arrays.
# (Associative arrays lose state inside piped subshells.)
KNOWN_CHANNEL_IDS=()
KNOWN_CHANNEL_NAMES=()
KNOWN_CHANNEL_PIDS=()

log() {
  echo "[orchestrator] $(date '+%H:%M:%S') $*"
}

relay_channels_ready() {
  local response
  response=$(curl -sf --max-time 5 \
    -H "x-api-token: ${RELAY_API_TOKEN}" \
    "${RELAY_URL}/api/channels" 2>/dev/null) || return 1

  printf '%s' "$response" | bun -e "
    const input = await Bun.stdin.text();
    try {
      const data = JSON.parse(input);
      process.exit(data.success && Array.isArray(data.channels) ? 0 : 1);
    } catch {
      process.exit(1);
    }
  " >/dev/null 2>&1
}

is_truthy() {
  local value
  value=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
  case "$value" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

is_channel_id() {
  [[ "$1" =~ ^[0-9]{15,22}$ ]]
}

# Return the array index for a channel_id, or -1 if not found
find_channel_index() {
  local target="$1"
  for i in "${!KNOWN_CHANNEL_IDS[@]}"; do
    if [ "${KNOWN_CHANNEL_IDS[$i]}" = "$target" ]; then
      echo "$i"
      return
    fi
  done
  echo "-1"
}

register_channel() {
  local channel_id="$1"
  local channel_name="$2"

  local idx
  idx=$(find_channel_index "$channel_id")
  if [ "$idx" -ge 0 ]; then
    KNOWN_CHANNEL_NAMES[$idx]="$channel_name"
    return
  fi

  KNOWN_CHANNEL_IDS+=("$channel_id")
  KNOWN_CHANNEL_NAMES+=("$channel_name")
  KNOWN_CHANNEL_PIDS+=(0)
}

# Clean shutdown: kill all channel agents
cleanup() {
  log "Shutting down -- killing all channel agents..."
  for i in "${!KNOWN_CHANNEL_PIDS[@]}"; do
    local pid="${KNOWN_CHANNEL_PIDS[$i]}"
    local name="${KNOWN_CHANNEL_NAMES[$i]:-unknown}"
    if [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null; then
      log "  Killing #${name} (PID $pid)"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  # Wait briefly for graceful shutdown, then force-kill stragglers
  sleep 2
  for i in "${!KNOWN_CHANNEL_PIDS[@]}"; do
    local pid="${KNOWN_CHANNEL_PIDS[$i]}"
    if [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done

  log "All channel agents stopped."
  exit 0
}

trap cleanup SIGTERM SIGINT

# Query relay API and output "id name" lines
discover_channels_lines() {
  local response
  response=$(curl -sf --max-time 10 \
    -H "x-api-token: ${RELAY_API_TOKEN}" \
    "${RELAY_URL}/api/channels?include_threads=true" 2>/dev/null) || {
    log "WARNING: Failed to reach relay at ${RELAY_URL}" >&2
    return 1
  }

  printf '%s' "$response" | bun -e "
    const input = await Bun.stdin.text();
    try {
      const data = JSON.parse(input);
      if (!data.success || !Array.isArray(data.channels)) {
        process.exit(1);
      }
      for (const ch of data.channels) {
        console.log(ch.id + ' ' + (ch.name || 'channel-' + ch.id));
      }
    } catch {
      process.exit(1);
    }
  " 2>/dev/null || {
    log "WARNING: Relay channel discovery returned an unsuccessful response"
    return 1
  }
}

# Start a channel agent as a child process
start_channel_agent() {
  local channel_id="$1"
  local channel_name="$2"

  if ! is_channel_id "$channel_id"; then
    log "WARNING: Refusing to start agent for invalid channel id '${channel_id}' (name='${channel_name}')"
    return
  fi

  log "Starting agent for #${channel_name} (${channel_id})"
  bash "$ROOT_DIR/scripts/channel-agent.sh" "$channel_id" "$channel_name" &
  local pid=$!

  local idx
  idx=$(find_channel_index "$channel_id")
  if [ "$idx" -ge 0 ]; then
    KNOWN_CHANNEL_PIDS[$idx]=$pid
  else
    KNOWN_CHANNEL_IDS+=("$channel_id")
    KNOWN_CHANNEL_NAMES+=("$channel_name")
    KNOWN_CHANNEL_PIDS+=("$pid")
  fi

  log "  Agent #${channel_name} started (PID $pid)"
}

# Check if a channel agent PID is still running
is_agent_alive() {
  local pid="$1"
  [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null
}

# Kill and restart a stuck agent
kill_stuck_agent() {
  local channel_id="$1"
  local idx
  idx=$(find_channel_index "$channel_id")
  if [ "$idx" -lt 0 ]; then
    log "WARNING: stuck agent $channel_id not in known list — skipping"
    return
  fi

  local pid="${KNOWN_CHANNEL_PIDS[$idx]}"
  local name="${KNOWN_CHANNEL_NAMES[$idx]}"

  if is_agent_alive "$pid"; then
    log "Killing stuck agent #${name} (${channel_id}, PID $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 2
    if is_agent_alive "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  fi

  log "Restarting stuck agent #${name} in ${AGENT_RESTART_DELAY}s..."
  sleep "$AGENT_RESTART_DELAY"
  start_channel_agent "$channel_id" "$name"
}

# Query /api/agent-health for stuck agents and restart them.
# An agent is truly stuck ONLY if ALL THREE conditions are met:
#   1. Heartbeat stale (>threshold) — agent isn't polling
#   2. Unread messages waiting — someone is expecting a response
#   3. Log file stale (>threshold) — agent isn't producing output either
# This avoids false kills during long-running tasks that are still producing output.
STUCK_THRESHOLD="${STUCK_AGENT_THRESHOLD:-900}"  # default 15 min

# Check how many seconds since a file was last modified.
# Returns 999999 if file doesn't exist.
file_age_seconds() {
  local filepath="$1"
  if [ ! -f "$filepath" ]; then
    echo 999999
    return
  fi
  # macOS stat: -f %m gives mtime as epoch seconds
  # Linux stat: -c %Y gives mtime as epoch seconds
  local mtime
  if stat -f %m "$filepath" >/dev/null 2>&1; then
    mtime=$(stat -f %m "$filepath")
  else
    mtime=$(stat -c %Y "$filepath" 2>/dev/null || echo 0)
  fi
  local now
  now=$(date +%s)
  echo $(( now - mtime ))
}

# Map channel_id to its log file path
channel_log_file() {
  local channel_id="$1"
  local idx
  idx=$(find_channel_index "$channel_id")
  if [ "$idx" -lt 0 ]; then
    echo ""
    return
  fi
  local name="${KNOWN_CHANNEL_NAMES[$idx]}"
  local cid="${KNOWN_CHANNEL_IDS[$idx]}"
  echo "${LOG_DIR}/channel-${name}-${cid}.log"
}

check_stuck_agents() {
  local response
  response=$(curl -s --max-time 10 \
    -H "x-api-token: ${RELAY_API_TOKEN}" \
    "${RELAY_URL}/api/agent-health?stale_threshold=${STUCK_THRESHOLD}" 2>/dev/null) || {
    log "WARNING: Failed to reach /api/agent-health"
    return
  }

  # Extract stuck agent IDs using bun (jq-like)
  local stuck_ids
  stuck_ids=$(echo "$response" | bun -e "
    const input = await Bun.stdin.text();
    try {
      const data = JSON.parse(input);
      if (data.success && Array.isArray(data.stuckAgents)) {
        for (const id of data.stuckAgents) {
          console.log(id);
        }
      }
    } catch {}
  " 2>/dev/null) || return

  if [ -z "$stuck_ids" ]; then
    return
  fi

  while IFS= read -r stuck_id; do
    [ -z "$stuck_id" ] && continue

    # Condition 3: check log file freshness
    local log_path
    log_path=$(channel_log_file "$stuck_id")
    if [ -n "$log_path" ]; then
      local log_age
      log_age=$(file_age_seconds "$log_path")
      if [ "$log_age" -lt "$STUCK_THRESHOLD" ]; then
        log "Agent ${stuck_id}: heartbeat stale + unread msgs, but log updated ${log_age}s ago — NOT stuck (working)"
        continue
      fi
      log "Stuck agent detected: ${stuck_id} (heartbeat stale, unread msgs, log stale ${log_age}s)"
    else
      log "Stuck agent detected: ${stuck_id} (heartbeat stale, unread msgs, no log file found)"
    fi

    kill_stuck_agent "$stuck_id"
  done <<< "$stuck_ids"
}

# ---- Main ----

# Set up logging
LOG_DIR="${CC_DISCORD_LOG_DIR:-/tmp/cc-discord/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/orchestrator.log"

# Redirect all orchestrator output to log file
exec >> "$LOG_FILE" 2>&1

log "Starting (relay=${RELAY_URL}, health_check=${HEALTH_CHECK_INTERVAL}s)"
log "Logging to $LOG_FILE"

ACTIVITY_RESET_OUTPUT=$(DISCORD_SESSION_ID="${DISCORD_SESSION_ID:-default}" bun "$ROOT_DIR/scripts/reset-agent-activity.ts" 2>&1) || true
if [ -n "$ACTIVITY_RESET_OUTPUT" ]; then
  log "$ACTIVITY_RESET_OUTPUT"
fi

# Wait for relay to be reachable
MAX_WAIT=60
WAITED=0
while ! relay_channels_ready; do
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    log "ERROR: Relay not reachable after ${MAX_WAIT}s. Exiting."
    exit 1
  fi
  log "Waiting for relay server at ${RELAY_URL}..."
  sleep 3
  WAITED=$((WAITED + 3))
done

log "Relay is up. Discovering channels..."

# Initial channel discovery — read lines into the current shell (no subshell)
while IFS=' ' read -r channel_id channel_name; do
  [ -z "$channel_id" ] && continue
  if ! is_channel_id "$channel_id"; then
    log "WARNING: Ignoring malformed channel discovery line (id='${channel_id}', name='${channel_name}')"
    continue
  fi
  if is_truthy "$EAGER_CHANNEL_STARTUP"; then
    start_channel_agent "$channel_id" "$channel_name"
  else
    register_channel "$channel_id" "$channel_name"
  fi
done < <(discover_channels_lines)

if is_truthy "$EAGER_CHANNEL_STARTUP"; then
  log "Initial spawn complete (${#KNOWN_CHANNEL_IDS[@]} channels)."
else
  log "Initial discovery complete (${#KNOWN_CHANNEL_IDS[@]} channels, lazy startup enabled)."
fi

# Check for unread messages with no active agent (e.g. new threads).
# Spawns agents immediately so users don't wait for the next health check.
UNSERVICED_CHECK_INTERVAL="${UNSERVICED_CHECK_INTERVAL:-5}"

check_unserviced() {
  local response
  response=$(curl -s --max-time 5 \
    -H "x-api-token: ${RELAY_API_TOKEN}" \
    "${RELAY_URL}/api/unserviced" 2>/dev/null) || return

  local targets
  targets=$(echo "$response" | bun -e "
    const input = await Bun.stdin.text();
    try {
      const data = JSON.parse(input);
      if (data.success && Array.isArray(data.targets)) {
        for (const t of data.targets) {
          // Only spawn for snowflake IDs (channels/threads), not agent names
          if (/^\d{15,22}$/.test(t.toAgent)) {
            console.log(t.toAgent);
          }
        }
      }
    } catch {}
  " 2>/dev/null) || return

  [ -z "$targets" ] && return

  while IFS= read -r target_id; do
    [ -z "$target_id" ] && continue
    _idx=$(find_channel_index "$target_id")
    if [ "$_idx" -ge 0 ]; then
      _pid="${KNOWN_CHANNEL_PIDS[$_idx]}"
      if is_agent_alive "$_pid"; then
        continue
      fi
      _name="${KNOWN_CHANNEL_NAMES[$_idx]}"
    else
      _name="thread-${target_id}"
    fi
    log "Unserviced messages for ${target_id} — spawning agent"
    start_channel_agent "$target_id" "$_name"
  done <<< "$targets"
}

# Spawn agents immediately for any unread messages already waiting.
check_unserviced

# Health check loop — runs unserviced check every UNSERVICED_CHECK_INTERVAL seconds,
# full health check every HEALTH_CHECK_INTERVAL seconds.
SECONDS_SINCE_HEALTH=0
while true; do
  sleep "$UNSERVICED_CHECK_INTERVAL"
  SECONDS_SINCE_HEALTH=$((SECONDS_SINCE_HEALTH + UNSERVICED_CHECK_INTERVAL))

  # Fast check: spawn agents for unserviced threads/channels
  check_unserviced

  # Full health check on the slower interval
  if [ "$SECONDS_SINCE_HEALTH" -ge "$HEALTH_CHECK_INTERVAL" ]; then
    SECONDS_SINCE_HEALTH=0

    # Check for dead agents. If the agent reported its channel is gone, prune
    # it from the rotation; otherwise restart.
    PRUNE_INDICES=()
    for i in "${!KNOWN_CHANNEL_IDS[@]}"; do
      _pid="${KNOWN_CHANNEL_PIDS[$i]}"
      if [ "${_pid}" -le 0 ]; then
        continue
      fi
      if ! is_agent_alive "$_pid"; then
        _name="${KNOWN_CHANNEL_NAMES[$i]}"
        _cid="${KNOWN_CHANNEL_IDS[$i]}"
        wait "$_pid" 2>/dev/null || true
        _gone_file="/tmp/cc-discord/agent-${_cid}.gone"
        if [ -f "$_gone_file" ]; then
          log "Agent #${_name} (${_cid}) reported channel no longer exists — removing from rotation"
          rm -f "$_gone_file"
          PRUNE_INDICES+=("$i")
          continue
        fi
        log "Agent #${_name} (${_cid}) exited. Restarting in ${AGENT_RESTART_DELAY}s..."
        sleep "$AGENT_RESTART_DELAY"
        start_channel_agent "$_cid" "$_name"
      fi
    done

    # Apply prunes in reverse index order so earlier indices stay valid.
    if [ "${#PRUNE_INDICES[@]}" -gt 0 ]; then
      for _idx in $(printf '%s\n' "${PRUNE_INDICES[@]}" | sort -rn); do
        unset 'KNOWN_CHANNEL_IDS[_idx]'
        unset 'KNOWN_CHANNEL_NAMES[_idx]'
        unset 'KNOWN_CHANNEL_PIDS[_idx]'
      done
      KNOWN_CHANNEL_IDS=("${KNOWN_CHANNEL_IDS[@]}")
      KNOWN_CHANNEL_NAMES=("${KNOWN_CHANNEL_NAMES[@]}")
      KNOWN_CHANNEL_PIDS=("${KNOWN_CHANNEL_PIDS[@]}")
    fi

    # Check for stuck agents (alive but not polling)
    check_stuck_agents

    # Check for new channels/threads
    while IFS=' ' read -r channel_id channel_name; do
      [ -z "$channel_id" ] && continue
      if ! is_channel_id "$channel_id"; then
        log "WARNING: Ignoring malformed channel discovery line (id='${channel_id}', name='${channel_name}')"
        continue
      fi
      _idx=$(find_channel_index "$channel_id")
      if [ "$_idx" -lt 0 ]; then
        log "New channel discovered: #${channel_name} (${channel_id})"
        if is_truthy "$EAGER_CHANNEL_STARTUP"; then
          start_channel_agent "$channel_id" "$channel_name"
        else
          register_channel "$channel_id" "$channel_name"
        fi
      fi
    done < <(discover_channels_lines)
  fi
done
