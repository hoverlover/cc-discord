#!/bin/bash
# Load KEY=VALUE pairs from .env into the current shell without overriding
# variables that are already set.

load_env_file() {
  local env_file="${1:-.env}"
  if [ ! -f "$env_file" ]; then
    return 0
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    # Normalize CRLF endings
    line="${line%$'\r'}"

    # Skip blanks and full-line comments
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    # Require key=value format
    [[ "$line" == *=* ]] || continue

    local key="${line%%=*}"
    local value="${line#*=}"

    # Trim surrounding whitespace from key/value
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    # Valid shell variable names only
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    # Remove matching surrounding quotes
    if [[ "$value" =~ ^\".*\"$ ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi

    # Keep explicit environment overrides
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < "$env_file"
}
