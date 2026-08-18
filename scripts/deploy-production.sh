#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_PATH="${PRODUCTION_WRANGLER_CONFIG:-wrangler.production.toml}"
readonly REQUIRED_SECRETS=(
  VERIFONE_USER_ID
  VERIFONE_API_KEY
  VERIFONE_ENTITY_ID
  VERIFONE_PAYMENT_CONTRACT_ID
  VERIFONE_3DS_CONTRACT_ID
  VERIFONE_JWKS_URL
  LANDSBANKINN_CLIENT_ID
  LANDSBANKINN_CLIENT_SECRET
  LANDSBANKINN_SCOPE
)

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${CONFIRM_PRODUCTION_DEPLOY:-}" == "1" ]] \
  || fail 'Refusing production deployment. Set CONFIRM_PRODUCTION_DEPLOY=1 after the release review.'
[[ -f "$CONFIG_PATH" ]] \
  || fail "Missing $CONFIG_PATH. Copy wrangler.production.toml.example and configure dedicated production resources."
! grep -q 'REPLACE_ME_' "$CONFIG_PATH" \
  || fail "$CONFIG_PATH still contains placeholder resource identifiers."
grep -q '^ENVIRONMENT = "production"$' "$CONFIG_PATH" \
  || fail "$CONFIG_PATH must explicitly set ENVIRONMENT = \"production\"."

secret_names="$(npx wrangler secret list --config "$CONFIG_PATH" 2>/dev/null | node -e \
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>JSON.parse(s).forEach(x=>console.log(x.name)))')" \
  || fail 'Unable to list production secrets. Check the Cloudflare API token and production Worker access.'

missing=()
for secret in "${REQUIRED_SECRETS[@]}"; do
  grep -qx "$secret" <<<"$secret_names" || missing+=("$secret")
done
(( ${#missing[@]} == 0 )) \
  || fail "Required production secrets are missing: ${missing[*]}"

exec npx wrangler deploy --config "$CONFIG_PATH"
