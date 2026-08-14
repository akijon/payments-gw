# Production deployment gate — single source of truth

**Status: BLOCKED. Do not deploy payment processing to production.**

This document supersedes readiness claims in older checklist/status documents. A green local build or Worker dry-run is not a production approval.

## Completed repository controls

- Server-side catalog pricing; client totals are not accepted.
- Integer monetary values, one currency per checkout, and strict settlement amount/currency/state checks.
- RFC 7797 detached-JWS handling for Verifone webhooks, with a generated compatible cryptographic positive fixture test. Official vendor-signed fixture validation remains an external gate.
- Webhook idempotency, legal state transitions, audit events, and a D1 batch for the normal verified transition.
- Opaque, hashed order-status access capability issued at checkout; order metadata is not publicly enumerable.
- Checkout body limit, Worker rate-limit binding requirement, and documented Cloudflare WAF rules.
- Explicit production configuration template and deploy/migration commands that require confirmation and real isolated resource IDs.

## Non-negotiable external blockers

- [ ] Create isolated production D1, KV, and Rate Limiting resources and create ignored `wrangler.production.toml` from the example.
- [ ] Supply a least-privilege Cloudflare API token with Worker deploy, secret-list, D1, KV, and rate-limit permissions for only this account/project.
- [ ] Configure all required production secrets; do not store their values in Git, logs, or this document.
- [ ] Apply and verify migrations `0001`–`0008` with `wrangler d1 migrations apply` after a tested backup/rollback plan. `0007_order_number_index.sql` backs the reconciliation cron's `order_number` lookup; skipping it degrades reconciliation, it does not fail loudly. `0008_payment_method.sql` adds wallet payment-method tracking used by the Apple Pay/Google Pay reconciliation split.
- [ ] Replace the live storefront's `/api/teya/checkout` contract and Teya branding with the documented Verifone contract; verify product identifiers and prices come from the same canonical catalog.
- [ ] Verify the **production** `PUBLIC_API_URL` origin reaches this Worker: `scripts/verify-return-routing.sh <origin>`. Verifone returns land on that origin, so it must forward `/api/return` to this Worker or the customer is stranded after paying. The sandbox origin is verified — `GET https://irja.khalipa.net/api/return` returned `400 {"code":"validation"}` from `src/routes/return.ts` on 2026-08-02, via the storefront's `PAYMENTS_GW` service-binding proxy. The earlier `404` in this document predated that proxy. The production origin is still unset (`REPLACE_ME_PUBLIC_RETURN_ORIGIN`) and unverified.
- [ ] Configure and verify Cloudflare dashboard WAF/rate-limit rules from `docs/edge-security.md`.
- [ ] Replace development catalog fixture data with approved merchant catalog data.
- [ ] Complete every redacted scenario in `SANDBOX_E2E_GATE.md` using vendor sandbox systems and a vendor-signed webhook.
- [ ] Confirm Verifone and Landsbankinn monetary-unit conventions for ISK in the contracted APIs before accepting live money.
- [ ] Provision the real 3DS contract through Verifone — only a Verifone representative can create one (Verifone Central → Administration → 3DS Contracts), not Landsbankinn directly. Landsbankinn is why one is required at all: it acquires in the EEA, where PSD2 SCA applies. Set `VERIFONE_3DS_CONTRACT_ID` for sandbox **and** production once issued; both are placeholders today. `buildVerifoneCheckoutRequest`/`createCheckout` do not themselves validate the contract ID is real, so an unconfigured or placeholder value fails at Verifone, not locally — confirm the value is set before blaming Verifone for a dead checkout.

## Approved commands

```bash
npm test
npm run lint
npm audit --omit=dev --audit-level=low
npx wrangler deploy --dry-run

# Deliberate production actions only; both fail closed by default:
CONFIRM_PRODUCTION_MIGRATION=1 PRODUCTION_D1_DATABASE_NAME=<redacted-name> npm run db:migrate:production
CONFIRM_PRODUCTION_DEPLOY=1 npm run deploy:production
```

Never use an unrestricted Cloudflare Global API Key. The release owner must attach test evidence and external configuration evidence to the deployment approval.
