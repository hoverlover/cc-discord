#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"
# Preferred split env file for relay process
load_env_file "$ROOT_DIR/.env.relay"
# Legacy fallback (single-file mode)
load_env_file "$ROOT_DIR/.env"

cd "$ROOT_DIR"
node server/index.js
