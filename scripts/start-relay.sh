#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"
load_env_file "$ROOT_DIR/.env"

cd "$ROOT_DIR"
node server/index.js
