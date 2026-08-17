#!/bin/bash
set -euo pipefail

# Cloudflare Secrets Setup for Irja Payments Gateway
# Sets up all required secrets for deployment

readonly SCRIPT_NAME="$(basename "$0")"
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

# Required secrets for the payments gateway
declare -a REQUIRED_SECRETS=(
    "VERIFONE_USER_ID"
    "VERIFONE_API_KEY"
    "VERIFONE_ENTITY_ID"
    "VERIFONE_PAYMENT_CONTRACT_ID"
    "VERIFONE_3DS_CONTRACT_ID"
    "VERIFONE_JWKS_URL"
    "LANDSBANKINN_CLIENT_ID"
    "LANDSBANKINN_CLIENT_SECRET"
    "LANDSBANKINN_SCOPE"
)

list_secret_names() {
    npx wrangler secret list 2>/dev/null | node -e \
        'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>JSON.parse(s).forEach(x=>console.log(x.name)))'
}

check_wrangler() {
    if ! command -v wrangler >/dev/null; then
        error "wrangler is not installed. Run: npm install -g wrangler"
    fi

    log "Testing Wrangler authentication..."
    if ! npx wrangler whoami >/dev/null 2>&1; then
        error "Wrangler authentication failed. Check your CLOUDFLARE_API_TOKEN"
    fi
    log "✅ Wrangler authentication working"
}

list_current_secrets() {
    log "Current secrets in Cloudflare:"
    if list_secret_names; then
        echo
    else
        log "Could not list secrets. Check API token permissions."
        echo
    fi
}

set_secret_interactive() {
    local secret_name="$1"
    local description="$2"
    
    echo "────────────────────────────────────────────────────────────"
    log "Setting up: $secret_name"
    log "Description: $description"
    echo
    
    # Check if secret already exists
    if list_secret_names | grep -qx "$secret_name"; then
        log "✅ Secret $secret_name already exists"
        read -p "Update it? [y/N]: " -r update_secret
        if [[ ! "$update_secret" =~ ^[Yy]$ ]]; then
            log "Skipping $secret_name"
            return 0
        fi
    fi
    
    # Get the value from user
    read -p "Enter value for $secret_name: " -s secret_value
    echo
    
    if [[ -z "$secret_value" ]]; then
        log "Empty value, skipping $secret_name"
        return 0
    fi
    
    # Set the secret
    log "Setting secret..."
    if printf '%s\n' "$secret_value" | npx wrangler secret put "$secret_name"; then
        log "✅ Successfully set $secret_name"
    else
        log "❌ Failed to set $secret_name"
    fi
    echo
}

setup_all_secrets() {
    log "Setting up Cloudflare secrets for $PROJECT_NAME"
    echo
    
    list_current_secrets
    
    log "You will be prompted to enter values for each secret."
    log "Leave empty to skip. Existing secrets can be updated."
    echo
    read -p "Continue? [y/N]: " -r confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        log "Cancelled by user"
        exit 0
    fi
    echo
    
    # Verifone secrets
    log "Setting up Verifone secrets..."
    set_secret_interactive "VERIFONE_USER_ID" "User UUID from Verifone Central"
    set_secret_interactive "VERIFONE_API_KEY" "API key associated with the Verifone user"
    set_secret_interactive "VERIFONE_ENTITY_ID" "Entity/Organization ID from Verifone Central"
    set_secret_interactive "VERIFONE_PAYMENT_CONTRACT_ID" "Card payment contract ID"
    set_secret_interactive "VERIFONE_3DS_CONTRACT_ID" "3DS contract ID for SCA compliance"
    set_secret_interactive "VERIFONE_JWKS_URL" "JWKS URL for webhook signature verification"
    
    # Landsbankinn secrets
    log "Setting up Landsbankinn secrets..."
    set_secret_interactive "LANDSBANKINN_CLIENT_ID" "Landsbankinn API OAuth2 client ID"
    set_secret_interactive "LANDSBANKINN_CLIENT_SECRET" "Landsbankinn API OAuth2 client secret"
    set_secret_interactive "LANDSBANKINN_SCOPE" "Landsbankinn API scope (usually 'acquiring')"
}

check_secrets() {
    log "Checking all required secrets are set..."
    
    local missing_secrets=()
    local current_secrets
    current_secrets=$(list_secret_names || echo "")
    
    for secret in "${REQUIRED_SECRETS[@]}"; do
        if echo "$current_secrets" | grep -q "^$secret$"; then
            log "✅ $secret"
        else
            log "❌ $secret (missing)"
            missing_secrets+=("$secret")
        fi
    done
    
    if [[ ${#missing_secrets[@]} -eq 0 ]]; then
        log "All required secrets are set!"
        return 0
    else
        log "Missing ${#missing_secrets[@]} secrets: ${missing_secrets[*]}"
        return 1
    fi
}

print_next_steps() {
    cat << EOF

🎯 NEXT STEPS:

1. Verify secrets are set correctly:
   npm run secrets:setup check

2. Apply D1 database schema:
   npm run db:migrate:prod

3. Deploy the Worker:
   npm run deploy

4. Test the deployment:
   curl https://irja-payments-gw.your-account.workers.dev/health

EOF
}

main() {
    case "${1:-setup}" in
        "check")
            check_wrangler
            check_secrets
            ;;
        "list")
            check_wrangler
            list_current_secrets
            ;;
        "setup"|"")
            check_wrangler
            setup_all_secrets
            echo
            check_secrets
            print_next_steps
            ;;
        *)
            echo "Usage: $0 [setup|check|list]"
            echo "  setup - Interactive setup of all secrets (default)"
            echo "  check - Check if all required secrets are set"
            echo "  list  - List current secrets"
            exit 1
            ;;
    esac
}

main "$@"