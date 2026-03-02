#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"
# Preferred split env file for relay process
load_env_file "$ROOT_DIR/.env.relay"
load_env_file "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env.relay"
# Legacy fallback (single-file mode)
load_env_file "$ROOT_DIR/.env"
load_env_file "${CC_DISCORD_CONFIG_DIR:-$HOME/.config/cc-discord}/.env"

# Ensure bun is on PATH (launchd doesn't inherit user shell PATH)
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$ROOT_DIR"
exec bun server/index.ts
