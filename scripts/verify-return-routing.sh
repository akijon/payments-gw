#!/usr/bin/env bash
# Verify that <origin>/api/return actually reaches this Worker.
#
# Verifone returns the customer's browser to PUBLIC_API_URL/api/return. When the
# storefront fronts that origin, the request only arrives here if the storefront
# forwards /api/* over its PAYMENTS_GW service binding. If it does not, the
# customer is stranded on a 404 after paying — see DEPLOYMENT_GATE.md.
#
# No credentials required: the probe sends no order_id, so the Worker answers
# 400 validation before touching any order.
#
# Usage: scripts/verify-return-routing.sh [origin]     # default: PUBLIC_API_URL
set -euo pipefail

ORIGIN=${1:-${PUBLIC_API_URL:-}}
if [[ -z "$ORIGIN" ]]; then
  echo "usage: $0 <origin>   (or set PUBLIC_API_URL)" >&2
  exit 2
fi
ORIGIN=${ORIGIN%/}

echo "Probing $ORIGIN/api/return"
body=$(curl -sS --max-time 15 -o /tmp/irja-return-probe.txt -w '%{http_code} %{content_type}' \
  "$ORIGIN/api/return" || true)
status=${body%% *}
ctype=${body#* }
payload=$(head -c 300 /tmp/irja-return-probe.txt)

echo "  status:       $status"
echo "  content-type: $ctype"
echo "  body:         $payload"
echo

# The gateway's own answer to a missing order_id — src/routes/return.ts.
if [[ "$status" == "400" && "$payload" == *'"code":"validation"'* && "$payload" == *order_id* ]]; then
  echo "PASS: the gateway served this path (400 order_id validation)."
  exit 0
fi

if [[ "$status" == "404" ]]; then
  echo "FAIL: 404 — the origin is not forwarding /api/return to this Worker."
  echo "      Check the storefront's gateway path list and its PAYMENTS_GW service binding."
  exit 1
fi

if [[ "$status" == "503" && "$payload" == *gateway_unbound* ]]; then
  echo "FAIL: the storefront matched the path but has no PAYMENTS_GW binding."
  exit 1
fi

echo "FAIL: unexpected response. Something other than this Worker is answering."
exit 1
