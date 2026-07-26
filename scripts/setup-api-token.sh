#!/bin/bash
set -euo pipefail

# Cloudflare API Token Setup for Irja Payments Gateway
# This script helps create the correct API token with required permissions

readonly SCRIPT_NAME="$(basename "$0")"
readonly ACCOUNT_ID="65b3492fbec7ee7861762efce4bc9aeb"
readonly PROJECT_NAME="irja-payments-gw"

# Security: Create secure temp directory
readonly TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

log() {
    echo "[$SCRIPT_NAME] $*" >&2
}

error() {
    log "ERROR: $*"
    exit 1
}

check_dependencies() {
    command -v jq >/dev/null || error "jq is required but not installed"
    command -v curl >/dev/null || error "curl is required but not installed"
}

print_token_requirements() {
    cat << 'EOF'

Required API Token Permissions for Cloudflare Workers Deployment:

┌─────────────────────────────────────────────────────────────┐
│                    REQUIRED PERMISSIONS                     │
├─────────────────────────────────────────────────────────────┤
│ Account Permissions:                                        │
│ • Account:Read                                              │
│ • User:Read                                                 │
│ • User → Memberships:Read                                   │
│                                                             │
│ Workers Permissions:                                        │
│ • Cloudflare Workers:Edit                                   │
│ • Worker Scripts:Edit                                       │
│ • Worker Scripts:Read                                       │
│                                                             │
│ D1 Database Permissions:                                    │
│ • D1:Edit                                                   │
│ • D1:Read                                                   │
│                                                             │
│ KV Storage Permissions:                                     │
│ • Workers KV Storage:Edit                                   │
│ • Workers KV Storage:Read                                   │
└─────────────────────────────────────────────────────────────┘

EOF
}

create_token_guide() {
    cat << EOF

STEP-BY-STEP TOKEN CREATION:

1. Open: https://dash.cloudflare.com/profile/api-tokens
2. Click: "Create Token"
3. Select: "Custom token" template
4. Configure permissions as shown above
5. Set Account Resources: Include "akicloudflare" account
6. Set Zone Resources: All zones (or specific zones if needed)
7. Set Client IP Address Filtering: Optional (leave blank for any IP)
8. Set TTL: Optional (leave blank for no expiration)
9. Click: "Continue to summary"
10. Click: "Create Token"
11. Copy the token securely

EOF
}

test_current_token() {
    if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
        log "No CLOUDFLARE_API_TOKEN environment variable found"
        return 1
    fi

    log "Testing current API token permissions..."
    
    local temp_result="$TEMP_DIR/api_test.json"
    touch "$temp_result"
    chmod 600 "$temp_result"
    
    local has_all_permissions=true
    
    # Test basic account access
    if curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            "https://api.cloudflare.com/client/v4/accounts" > "$temp_result"; then
        if jq -e '.success' "$temp_result" >/dev/null 2>&1; then
            log "✅ Account access: WORKING"
        else
            log "❌ Account access: FAILED"
            jq -r '.errors[]?.message // "Unknown error"' "$temp_result"
            return 1
        fi
    else
        log "❌ Account access: FAILED (network error)"
        return 1
    fi
    
    # Test D1 access
    if curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database" > "$temp_result"; then
        if jq -e '.success' "$temp_result" >/dev/null 2>&1; then
            log "✅ D1 database access: WORKING"
        else
            log "❌ D1 database access: FAILED"
            jq -r '.errors[]?.message // "Permission denied"' "$temp_result"
            has_all_permissions=false
        fi
    else
        log "❌ D1 database access: FAILED (network error)"
        has_all_permissions=false
    fi
    
    # Test Workers access via Wrangler
    log "Testing Wrangler access..."
    if npx wrangler whoami >/dev/null 2>&1; then
        log "✅ Wrangler basic auth: WORKING"
        
        if npx wrangler deployments list >/dev/null 2>&1; then
            log "✅ Workers deployment access: WORKING"
        else
            log "❌ Workers deployment access: FAILED"
            has_all_permissions=false
        fi
    else
        log "❌ Wrangler basic auth: FAILED"
        has_all_permissions=false
    fi
    
    if [[ "$has_all_permissions" == "true" ]]; then
        return 0
    else
        return 1
    fi
}

main() {
    log "Cloudflare API Token Setup for $PROJECT_NAME"
    log "Account: $ACCOUNT_ID (akicloudflare)"
    echo
    
    check_dependencies
    
    print_token_requirements
    create_token_guide
    
    echo "════════════════════════════════════════════════════════════"
    echo
    
    if test_current_token; then
        log "Current token has all required permissions!"
        log "You can proceed with deployment: npm run deploy"
    else
        log "Current token needs additional permissions."
        log "Please create a new token with the requirements above."
        echo
        log "After creating the new token, update it with:"
        echo "  export CLOUDFLARE_API_TOKEN='your-new-token'"
        echo "  source ~/.bashrc  # or restart your shell"
        echo "  $0  # run this script again to verify"
    fi
    
    echo
    log "Next steps after token is ready:"
    echo "  npx wrangler deploy                    # Deploy the Worker"
    echo "  npx wrangler secret put VERIFONE_CLIENT_ID    # Set secrets"
    echo "  npm run db:migrate:prod               # Apply D1 schema"
}

main "$@"