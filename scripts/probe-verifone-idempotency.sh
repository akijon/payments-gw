#!/usr/bin/env bash
# Probe whether Verifone's Checkout API honors x-vfi-api-idempotencykey on
# POST /v2/checkout. Answers questions 1-3 of the open vendor question in
# SANDBOX_E2E_GATE.md; question 4 (key retention window) needs a vendor answer
# or a --replay run days later.
#
# SANDBOX ONLY. This creates real checkout sessions on whatever tenant the
# credentials point at. It refuses to run against a non-test API base unless
# IRJA_ALLOW_NON_SANDBOX=1 is set deliberately.
#
# Usage:
#   set -a; source .dev.vars; set +a
#   VERIFONE_API_BASE=... VERIFONE_OAUTH_URL=... scripts/probe-verifone-idempotency.sh
#   scripts/probe-verifone-idempotency.sh --replay <uuid>   # question 4, later
set -euo pipefail

if [[ -n "${IRJA_AGENT_SAFE_ENV:-}" ]]; then
  echo "Refusing to run under with-agent-safe-env.sh: credentials are stripped there." >&2
  echo "Run this yourself, outside the agent loop." >&2
  exit 2
fi

for var in VERIFONE_API_BASE VERIFONE_OAUTH_URL VERIFONE_CLIENT_ID VERIFONE_CLIENT_SECRET \
           VERIFONE_SCOPE VERIFONE_ENTITY_ID VERIFONE_PAYMENT_CONTRACT_ID VERIFONE_3DS_CONTRACT_ID; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing $var. Load sandbox credentials first: set -a; source .dev.vars; set +a" >&2
    exit 2
  fi
done

if [[ "$VERIFONE_API_BASE" != *test* && "${IRJA_ALLOW_NON_SANDBOX:-}" != "1" ]]; then
  echo "VERIFONE_API_BASE does not look like a sandbox host: $VERIFONE_API_BASE" >&2
  echo "Set IRJA_ALLOW_NON_SANDBOX=1 only if you truly mean to probe this tenant." >&2
  exit 2
fi

command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

AMOUNT_A=${IRJA_PROBE_AMOUNT:-100}
AMOUNT_B=$((AMOUNT_A * 9))
RETURN_URL=${IRJA_PROBE_RETURN_URL:-https://example.invalid/api/return}

token() {
  curl -sS -X POST "$VERIFONE_OAUTH_URL" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=$VERIFONE_CLIENT_ID" \
    --data-urlencode "client_secret=$VERIFONE_CLIENT_SECRET" \
    --data-urlencode "scope=$VERIFONE_SCOPE" |
    jq -er .access_token
}

# body <amount> <merchant_reference>
body() {
  jq -nc \
    --arg entity "$VERIFONE_ENTITY_ID" \
    --arg ref "$2" \
    --arg ret "$RETURN_URL" \
    --arg contract "$VERIFONE_PAYMENT_CONTRACT_ID" \
    --arg threeds "$VERIFONE_3DS_CONTRACT_ID" \
    --argjson amount "$1" \
    '{entity_id:$entity, currency_code:"ISK", amount:$amount, merchant_reference:$ref,
      return_url:$ret, interaction_type:"HPP",
      configurations:{card:{mode:"3DS_PAYMENT", payment_contract_id:$contract,
        capture_now:true, threed_secure:{enabled:true, threeds_contract_id:$threeds}}}}'
}

# post <idempotency-key|""> <body> -> "<http_status> <checkout_id>"
post() {
  local key=$1 payload=$2 args=()
  args=(-sS -o /tmp/vfi-probe-resp.json -w '%{http_code}'
        -X POST "$VERIFONE_API_BASE/v2/checkout"
        -H "Authorization: Bearer $TOKEN"
        -H 'Content-Type: application/json'
        -H 'Accept: */*')
  [[ -n "$key" ]] && args+=(-H "x-vfi-api-idempotencykey: $key")
  local status
  status=$(curl "${args[@]}" -d "$payload")
  echo "$status $(jq -r '.id // "-"' /tmp/vfi-probe-resp.json 2>/dev/null || echo '-')"
}

TOKEN=$(token)

if [[ "${1:-}" == "--replay" ]]; then
  KEY=${2:?usage: $0 --replay <uuid>}
  echo "Q4 retention replay with key $KEY"
  read -r status id <<<"$(post "$KEY" "$(body "$AMOUNT_A" "IDEM-PROBE-Q4")")"
  echo "  status=$status checkout_id=$id"
  echo "  A new id here means the key was already forgotten; the same id means it is still retained."
  exit 0
fi

echo "== Baseline: two identical bodies, NO idempotency key =="
read -r s1 id1 <<<"$(post "" "$(body "$AMOUNT_A" "IDEM-PROBE-BASE")")"
read -r s2 id2 <<<"$(post "" "$(body "$AMOUNT_A" "IDEM-PROBE-BASE")")"
echo "  1: status=$s1 id=$id1"
echo "  2: status=$s2 id=$id2"
if [[ "$id1" == "$id2" && "$id1" != "-" ]]; then
  echo "  -> merchant_reference already deduplicates. Idempotency header question is moot."
else
  echo "  -> distinct checkouts, as expected: no implicit dedupe on merchant_reference."
fi

KEY=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
echo
echo "== Q1/Q2: same key, identical body (key=$KEY) =="
read -r s3 id3 <<<"$(post "$KEY" "$(body "$AMOUNT_A" "IDEM-PROBE-Q12")")"
read -r s4 id4 <<<"$(post "$KEY" "$(body "$AMOUNT_A" "IDEM-PROBE-Q12")")"
echo "  1: status=$s3 id=$id3"
echo "  2: status=$s4 id=$id4"
if [[ "$id3" == "$id4" && "$id3" != "-" ]]; then
  echo "  -> HONORED: replay returned the original checkout."
else
  echo "  -> IGNORED: replay created a second checkout. A 2xx here proves nothing;"
  echo "     unknown headers are silently dropped. Retrying checkout creation is UNSAFE."
fi

echo
echo "== Q3: same key, DIFFERENT body (amount $AMOUNT_A -> $AMOUNT_B) =="
read -r s5 id5 <<<"$(post "$KEY" "$(body "$AMOUNT_B" "IDEM-PROBE-Q12")")"
echo "  status=$s5 id=$id5"
if [[ "$s5" =~ ^4 ]]; then
  echo "  -> conflict rejected ($s5). Safe: the key is scoped to the request body."
elif [[ "$id5" == "$id3" ]]; then
  echo "  -> returned the ORIGINAL checkout; the changed amount was silently ignored."
else
  echo "  -> created a NEW checkout: the key is not scoped to the body. Dangerous."
fi

echo
echo "== Q4: retention =="
echo "  Re-run later to bound the window:  $0 --replay $KEY"
echo "  A bound is not a policy — get the retention window from Verifone in writing."
echo
echo "Record results (redacted IDs only) against the checklist in SANDBOX_E2E_GATE.md."
