#!/bin/bash
# Load KEY=VALUE pairs from .env into the current shell without overriding
# variables that are already set.

_parse_env_line() {
  local line="$1"
  # Normalize CRLF endings
  line="${line%$'\r'}"

  # Skip blanks/comments
  [[ -z "$line" ]] && return 1
  [[ "$line" =~ ^[[:space:]]*# ]] && return 1
  [[ "$line" == *=* ]] || return 1

  local key="${line%%=*}"
  local value="${line#*=}"

  # Trim surrounding whitespace from key/value
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  # Valid shell variable names only
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1

  # Remove matching surrounding quotes
  if [[ "$value" =~ ^\".*\"$ ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:${#value}-2}"
  fi

  ENV_KEY="$key"
  ENV_VALUE="$value"
  return 0
}

load_env_file() {
  local env_file="${1:-.env}"
  if [ ! -f "$env_file" ]; then
    return 0
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    _parse_env_line "$line" || continue
    # Keep explicit environment overrides
    if [ -z "${!ENV_KEY+x}" ]; then
      export "$ENV_KEY=$ENV_VALUE"
    fi
  done < "$env_file"
}

# Load only specified keys from an env file.
# Usage: load_env_keys /path/to/.env KEY1 KEY2 ...
load_env_keys() {
  local env_file="${1:-.env}"
  shift || true

  if [ ! -f "$env_file" ]; then
    return 0
  fi

  # Build lookup table of requested keys
  local wanted=" "
  local key
  for key in "$@"; do
    wanted+="$key "
  done

  while IFS= read -r line || [ -n "$line" ]; do
    _parse_env_line "$line" || continue
    [[ "$wanted" == *" $ENV_KEY "* ]] || continue

    if [ -z "${!ENV_KEY+x}" ]; then
      export "$ENV_KEY=$ENV_VALUE"
    fi
  done < "$env_file"
}
