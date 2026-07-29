#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_PATH="${PRODUCTION_WRANGLER_CONFIG:-wrangler.production.toml}"
readonly DATABASE_NAME="${PRODUCTION_D1_DATABASE_NAME:-}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${CONFIRM_PRODUCTION_MIGRATION:-}" == "1" ]] \
  || fail 'Refusing production migration. Set CONFIRM_PRODUCTION_MIGRATION=1 after backup and release review.'
[[ -f "$CONFIG_PATH" ]] \
  || fail "Missing $CONFIG_PATH. Copy wrangler.production.toml.example and configure dedicated production resources."
! grep -q 'REPLACE_ME_' "$CONFIG_PATH" \
  || fail "$CONFIG_PATH still contains placeholder resource identifiers."
[[ -n "$DATABASE_NAME" ]] \
  || fail 'Set PRODUCTION_D1_DATABASE_NAME to the database_name configured in the production Wrangler config.'

npx wrangler d1 migrations apply "$DATABASE_NAME" --config "$CONFIG_PATH" --remote
