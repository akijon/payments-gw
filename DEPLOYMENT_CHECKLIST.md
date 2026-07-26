# 🚀 Deployment Checklist - Irja Payments Gateway

This document provides a step-by-step deployment guide for the Irja Payments Gateway.

## ✅ Prerequisites Completed

- [x] **Full implementation**: All routes, libraries, and core functionality
- [x] **Test coverage**: 25 tests passing across 6 test files  
- [x] **Wrangler v4**: Upgraded to 4.114.0 with compatibility verified
- [x] **Documentation**: Complete API token and secrets setup guides
- [x] **Security**: JWS webhook verification, PCI SAQ A compliance

## 🔧 Deployment Steps

### 1. API Token Setup

**Current Status:** ❌ Token lacks required permissions

**Action Required:**
```bash
npm run deploy:check
```

Follow the output instructions to create a new API token with:
- Account:Read, User:Read, User→Memberships:Read
- Workers Scripts:Edit/Read, Cloudflare Workers:Edit
- D1:Edit/Read, Workers KV Storage:Edit/Read

**Verification:**
```bash
npm run deploy:check  # Should show all green checkmarks
```

### 2. Secrets Configuration

**Current Status:** ❌ Secrets not set (placeholder values only)

**Action Required:**
```bash
npm run secrets:setup
```

Required secrets:
- `VERIFONE_CLIENT_ID`, `VERIFONE_CLIENT_SECRET`, `VERIFONE_SCOPE`
- `VERIFONE_ENTITY_ID`, `VERIFONE_PAYMENT_CONTRACT_ID`, `VERIFONE_3DS_CONTRACT_ID`
- `VERIFONE_JWKS_URL`
- `LANDSBANKINN_CLIENT_ID`, `LANDSBANKINN_CLIENT_SECRET`, `LANDSBANKINN_SCOPE`

**Verification:**
```bash
npm run secrets:setup check
```

### 3. Database Migration

**Current Status:** ❌ Production D1 schema not applied

**Action Required:**
```bash
npm run db:migrate:prod
```

**Verification:**
```bash
npx wrangler d1 execute irja-payments --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### 4. Worker Deployment

**Current Status:** ❌ Not deployed

**Action Required:**
```bash
npm run deploy
```

**Verification:**
```bash
curl https://irja-payments-gw.your-account.workers.dev/health
# Expected: {"status":"ok","timestamp":"..."}
```

### 5. Production Environment Switch

**Current Status:** ⚠️ Configured for sandbox

**Action Required (when ready for production):**

1. Update `wrangler.toml` production environment:
   ```toml
   [env.production]
   name = "irja-payments-gw-prod"
   [env.production.vars]
   ENVIRONMENT = "production"
   STOREFRONT_URL = "https://irja.is"
   VERIFONE_API_BASE = "https://emea.gsc.verifone.cloud/oidc/checkout-service"
   VERIFONE_OAUTH_URL = "https://emea.vam.verifone.cloud/oauth2/realms/root/realms/VerifoneServices/access_token"
   LANDSBANKINN_API_BASE = "https://api.landsbankinn.is/api/Acquiring/Acquiring/v1"
   LANDSBANKINN_OAUTH_URL = "https://api.landsbankinn.is/oauth2/access_token"
   ```

2. Deploy to production:
   ```bash
   npx wrangler deploy --env production
   ```

## 🚧 Known Blockers

### 1. Verifone Central Credentials
**Status:** ❌ Missing real credentials  
**Blocking:** Deployment and testing  
**Required:** 
- Entity ID from Verifone Central
- Payment and 3DS contract IDs
- Production OAuth2 credentials

### 2. Landsbankinn Acquiring Access
**Status:** ❓ Unknown if developer account is set up  
**Blocking:** Settlement reconciliation  
**Required:**
- Landsbankinn developer portal registration
- OAuth2 credentials for Acquiring API

### 3. Domain Configuration
**Status:** ❓ `irja.is` DNS setup unknown  
**Blocking:** Production go-live  
**Required:**
- Point `irja.is` to Cloudflare
- Configure Worker route: `irja.is/api/*`

## 🎯 Ready State Criteria

The deployment is ready when:
- [ ] `npm run deploy:check` shows all permissions ✅
- [ ] `npm run secrets:setup check` shows all secrets ✅  
- [ ] `npm run db:migrate:prod` completes successfully
- [ ] `npm run deploy` completes successfully
- [ ] Health check endpoint returns 200 OK
- [ ] All 25 tests continue to pass

## 🔍 Testing Strategy

### Sandbox Testing (Immediate)
Once API token is fixed:
1. Deploy with sandbox credentials
2. Test checkout flow with Verifone test cards
3. Verify webhook processing
4. Test return URL handling

### Production Testing (Before Go-Live)
1. Deploy to production environment
2. Small-value real transaction test
3. End-to-end payment flow verification
4. Webhook and reconciliation testing

## 📞 Support Contacts

- **Cloudflare Issues**: Cloudflare Dashboard → Support
- **Verifone Issues**: Verifone Central → Support
- **Landsbankinn Issues**: Developer portal support