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
#   VERIFONE_API_BASE=... scripts/probe-verifone-idempotency.sh
#   scripts/probe-verifone-idempotency.sh --replay   # Q4, reads state from prior run
set -euo pipefail

if [[ -n "${IRJA_AGENT_SAFE_ENV:-}" ]]; then
  echo "Refusing to run under with-agent-safe-env.sh: credentials are stripped there." >&2
  echo "Run this yourself, outside the agent loop." >&2
  exit 2
fi

for var in VERIFONE_API_BASE VERIFONE_USER_ID VERIFONE_API_KEY VERIFONE_ENTITY_ID \
           VERIFONE_PAYMENT_CONTRACT_ID VERIFONE_3DS_CONTRACT_ID; do
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
command -v base64 >/dev/null || { echo "base64 is required" >&2; exit 2; }

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
AUTH_CONFIG="$TEMP_DIR/curl-auth.conf"
basic_auth=$(printf '%s:%s' "$VERIFONE_USER_ID" "$VERIFONE_API_KEY" | base64 | tr -d '\n')
printf 'header = "Authorization: Basic %s"\n' "$basic_auth" > "$AUTH_CONFIG"
chmod 600 "$AUTH_CONFIG"
unset basic_auth

AMOUNT_A=${IRJA_PROBE_AMOUNT:-100}
AMOUNT_B=$((AMOUNT_A * 9))
RETURN_URL=${IRJA_PROBE_RETURN_URL:-https://example.invalid/api/return}
STATE_FILE=${IRJA_PROBE_STATE:-/tmp/vfi-probe-state.json}


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
  args=(-sS --config "$AUTH_CONFIG" -o "$TEMP_DIR/response.json" -w '%{http_code}'
        -X POST "$VERIFONE_API_BASE/v2/checkout"
        -H 'Content-Type: application/json'
        -H 'Accept: */*')
  [[ -n "$key" ]] && args+=(-H "x-vfi-api-idempotencykey: $key")
  local status
  status=$(curl "${args[@]}" -d "$payload")
  echo "$status $(jq -r '.id // "-"' "$TEMP_DIR/response.json" 2>/dev/null || echo '-')"
}

# --replay: read state from a prior run, replay the EXACT original body, and
# compare against the original checkout ID.  This isolates key retention from
# payload mismatch: if Verifone scopes the key to the request body, a different
# body would produce a false "forgotten" result regardless of actual retention.
if [[ "${1:-}" == "--replay" ]]; then
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file at $STATE_FILE. Run the probe first without --replay." >&2
    exit 2
  fi
  KEY=$(jq -r .key "$STATE_FILE")
  ORIG_BODY=$(jq -r .body "$STATE_FILE")
  ORIG_ID=$(jq -r .checkout_id "$STATE_FILE")
  echo "Q4 retention replay with key $KEY (replaying exact original payload)"
  read -r status id <<<"$(post "$KEY" "$ORIG_BODY")"
  echo "  status=$status checkout_id=$id"
  if [[ "$id" == "$ORIG_ID" && "$id" != "-" ]]; then
    echo "  -> RETAINED: key still active, returned the original checkout."
  elif [[ "$id" == "-" ]]; then
    echo "  -> INCONCLUSIVE: no checkout ID in response."
  else
    echo "  -> FORGOTTEN: key expired, created a new checkout."
  fi
  exit 0
fi

echo "== Baseline: two identical bodies, NO idempotency key =="
read -r s1 id1 <<<"$(post "" "$(body "$AMOUNT_A" "IDEM-PROBE-BASE")")"
read -r s2 id2 <<<"$(post "" "$(body "$AMOUNT_A" "IDEM-PROBE-BASE")")"
echo "  1: status=$s1 id=$id1"
echo "  2: status=$s2 id=$id2"
if [[ "$id1" == "$id2" && "$id1" != "-" ]]; then
  echo "  -> merchant_reference already deduplicates."
  echo "  -> ABORTING as INCONCLUSIVE: cannot isolate the header's effect when"
  echo "     merchant_reference alone produces identical checkout IDs."
  echo "     The idempotency-key question is moot for this tenant."
  exit 0
else
  echo "  -> distinct checkouts, as expected: no implicit dedupe on merchant_reference."
fi

KEY=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
BODY_Q12=$(body "$AMOUNT_A" "IDEM-PROBE-Q12")
echo
echo "== Q1/Q2: same key, identical body (key=$KEY) =="
read -r s3 id3 <<<"$(post "$KEY" "$BODY_Q12")"
read -r s4 id4 <<<"$(post "$KEY" "$BODY_Q12")"
echo "  1: status=$s3 id=$id3"
echo "  2: status=$s4 id=$id4"
if [[ "$id3" == "$id4" && "$id3" != "-" ]]; then
  echo "  -> HONORED: replay returned the original checkout."
else
  echo "  -> IGNORED: replay created a second checkout. A 2xx here proves nothing;"
  echo "     unknown headers are silently dropped. Retrying checkout creation is UNSAFE."
fi

# Persist state for --replay so the exact body and original checkout ID are
# retained.  Without this, a later replay cannot distinguish key expiry from
# payload mismatch.
jq -nc --arg key "$KEY" --arg body "$BODY_Q12" --arg id "$id3" \
  '{key:$key, body:$body, checkout_id:$id, merchant_reference:"IDEM-PROBE-Q12"}' > "$STATE_FILE"
echo "  State saved to $STATE_FILE"

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
echo "  Re-run later to bound the window:  $0 --replay"
echo "  (reads state from $STATE_FILE — exact original payload + checkout ID)"
echo "  A bound is not a policy — get the retention window from Verifone in writing."
echo
echo "Record results (redacted IDs only) against the checklist in SANDBOX_E2E_GATE.md."
