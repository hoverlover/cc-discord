#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRATOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TEMPLATE="$ORCHESTRATOR_DIR/.claude/settings.template.json"
OUTPUT="$ORCHESTRATOR_DIR/.claude/settings.json"

if [ ! -f "$TEMPLATE" ]; then
  echo "Template not found: $TEMPLATE"
  exit 1
fi

sed -e "s|__ORCHESTRATOR_DIR__|$ORCHESTRATOR_DIR|g" "$TEMPLATE" > "$OUTPUT"

echo "Generated: $OUTPUT"
