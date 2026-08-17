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
- [ ] Apply and verify migrations `0001`–`0016` with `wrangler d1 migrations apply` after a tested backup/rollback plan. `0014_shipping_cost.sql` adds shipping totals, `0015_terms_acceptance.sql` records consent, and `0016_customer_billing.sql` persists the billing identity and Verifone Customer ID required by new HPP 3DS checkouts.
- [ ] Replace the live storefront's `/api/teya/checkout` contract and Teya branding with the documented Verifone contract; verify product identifiers and prices come from the same canonical catalog.
- [ ] Verify the **production** `PUBLIC_API_URL` origin reaches this Worker: `scripts/verify-return-routing.sh <origin>`. Verifone returns land on that origin, so it must forward `/api/return` to this Worker or the customer is stranded after paying. The sandbox origin is verified — `GET https://irja.khalipa.net/api/return` returned `400 {"code":"validation"}` from `src/routes/return.ts` on 2026-08-02, via the storefront's `PAYMENTS_GW` service-binding proxy. The earlier `404` in this document predated that proxy. The production origin is still unset (`REPLACE_ME_PUBLIC_RETURN_ORIGIN`) and unverified.
- [ ] Configure and verify Cloudflare dashboard WAF/rate-limit rules from `docs/edge-security.md`.
- [ ] Replace development catalog fixture data with approved merchant catalog data.
- [ ] Complete every redacted scenario in `SANDBOX_E2E_GATE.md` using vendor sandbox systems and a vendor-signed webhook.
- [x] **Verifone ISK unit convention — settled 2026-08-17: ISK is sent in major units (whole krónur).** `amount: 18000` with `currency_code: "ISK"` is 18.000 kr, not 180 kr. The catalog, order, invoice, and Verifone request paths all carry whole krónur and are correct as written; the code and docs that described amounts as "aurar (minor units)" were mislabelled and have been corrected. Verifone's own docs cannot settle this — the Checkout OpenAPI schema types `amount` as an integer (so the `74.55` example in the "Accepting payments" guide is wrong), only `gift_card_amount` is annotated "major units", and the ISK exception documented under `AmountSimple` ("2 decimals, fixed minor units .00") is never tied to this endpoint.
- [ ] Confirm the **Landsbankinn** settlement monetary-unit convention for ISK before accepting live money. Settled separately from Verifone above; `src/lib/landsbankinn.ts` and the reconciliation cron compare gateway amounts against bank amounts, so a unit mismatch there would surface as a systematic settlement discrepancy.
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
