#!/usr/bin/env bash
# Tier-1/2 local loops: strip cloud/payment credentials from the environment
# so the agent cannot leak or misuse them. Usage: with-agent-safe-env.sh <cmd> [args...]
set -euo pipefail

# Cloudflare / Wrangler deploy credentials
unset CLOUDFLARE_API_TOKEN \
      CLOUDFLARE_API_KEY \
      CLOUDFLARE_ACCOUNT_ID \
      CLOUDFLARE_EMAIL \
      CF_API_TOKEN \
      CF_API_KEY \
      CF_ACCOUNT_ID \
      WRANGLER_SEND_METRICS \
      2>/dev/null || true

# Verifone
unset VERIFONE_CLIENT_ID \
      VERIFONE_CLIENT_SECRET \
      VERIFONE_SCOPE \
      VERIFONE_ENTITY_ID \
      VERIFONE_PAYMENT_CONTRACT_ID \
      VERIFONE_3DS_CONTRACT_ID \
      VERIFONE_JWKS_URL \
      2>/dev/null || true

# Landsbankinn
unset LANDSBANKINN_CLIENT_ID \
      LANDSBANKINN_CLIENT_SECRET \
      LANDSBANKINN_SCOPE \
      2>/dev/null || true

# Generic secret names often used in CI
unset API_TOKEN API_KEY CLIENT_SECRET 2>/dev/null || true

export IRJA_AGENT_SAFE_ENV=1

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

exec "$@"
