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

- [x] **Create isolated production D1, KV, and Rate Limiting resources and create ignored `wrangler.production.toml` from the example — done 2026-08-18.** D1 `irja-payments-prod` (WEUR), KV `irja-payments-cache-prod`, both created fresh via `wrangler d1 create` / `wrangler kv namespace create`, not reused from sandbox. Rate Limiting has no separate create step — Cloudflare provisions a `namespace_id` implicitly on first deploy referencing it; a fresh id is set in `wrangler.production.toml`. Config validated with `wrangler deploy --dry-run --config wrangler.production.toml`: all bindings resolve, no errors. IDs are not secret and are recorded in the (gitignored) file itself, not here. `wrangler.production.toml.example`'s `ratelimits` block had a schema bug (`binding` instead of the required `name` key) caught by that dry-run; fixed in both files. The template was also missing the `SELLER_*` vars block entirely — added with `REPLACE_ME_*` placeholders.
- [ ] Supply a least-privilege Cloudflare API token with Worker deploy, secret-list, D1, KV, and rate-limit permissions for only this account/project. Resource creation above used a full-account OAuth token (`akicloudflare`), not a scoped token — this item is about narrowing to least-privilege before the token is used for ongoing deploys, not about whether resources exist.
- [ ] Configure all required production secrets; do not store their values in Git, logs, or this document. The 6 `VERIFONE_*` secrets have a source (release-owner-supplied `verifone_information.vars`, gitignored) but are not yet pushed to the Worker via `wrangler secret put`. `LANDSBANKINN_*` are set to explicit non-functional placeholders by release-owner decision (2026-08-18) — see the reconciliation-cron note below.
- [ ] Apply and verify migrations `0001`–`0017` with `wrangler d1 migrations apply` after a tested backup/rollback plan. `0014_shipping_cost.sql` adds shipping totals, `0015_terms_acceptance.sql` records consent, `0016_customer_billing.sql` persists the billing identity and Verifone Customer ID required by new HPP 3DS checkouts, and `0017_merchant_catalog.sql` replaces the dev fixtures with the approved catalog. Re-verify this reference stays current as new migrations land.
- [ ] Verify the **live deployed** `irja.khalipa.net`/`irja.is` bundle matches `irja-storefront-2026` main, which already replaced `/api/teya/checkout` with the documented Verifone contract (`worker/payments-proxy.ts`, `POST /api/checkout` via the `PAYMENTS_GW` service binding). Confirm via `npx wrangler deployments list` (storefront repo) against a Cloudflare account with access, or a live request trace — this workspace has no Cloudflare auth to check directly. Verify product identifiers and prices come from the same canonical catalog either way.
- [ ] Verify the **production** `PUBLIC_API_URL` origin reaches this Worker: `scripts/verify-return-routing.sh <origin>`. Verifone returns land on that origin, so it must forward `/api/return` to this Worker or the customer is stranded after paying. The sandbox origin is verified — `GET https://irja.khalipa.net/api/return` returned `400 {"code":"validation"}` from `src/routes/return.ts` on 2026-08-02, via the storefront's `PAYMENTS_GW` service-binding proxy. The earlier `404` in this document predated that proxy. `PUBLIC_API_URL` is now set to `https://irja.is` in `wrangler.production.toml` (release-owner decision 2026-08-18, same architecture as sandbox), but unverified — this requires the Worker to actually be deployed first, which it is not yet.
- [ ] Configure and verify Cloudflare dashboard WAF/rate-limit rules from `docs/edge-security.md`.
- [x] **Replace development catalog fixture data with approved merchant catalog data — done in `0017_merchant_catalog.sql`.** The 7 dev SKUs (`HOODIE-BLK-M` etc.) are deactivated, not deleted, since historical orders/invoices reference them by id. The 6 real products (supplied by the release owner, matching `irja-storefront-2026`'s `AuthoredProduct[]` by `sku`) are active. Applying `0017` to sandbox/production D1 is still required — see the migrations item above.
- [ ] Complete every redacted scenario in `SANDBOX_E2E_GATE.md` using vendor sandbox systems and a vendor-signed webhook.
- [x] **Verifone ISK unit convention — settled 2026-08-17: ISK is sent in major units (whole krónur).** `amount: 18000` with `currency_code: "ISK"` is 18.000 kr, not 180 kr. The catalog, order, invoice, and Verifone request paths all carry whole krónur and are correct as written; the code and docs that described amounts as "aurar (minor units)" were mislabelled and have been corrected. Verifone's own docs cannot settle this — the Checkout OpenAPI schema types `amount` as an integer (so the `74.55` example in the "Accepting payments" guide is wrong), only `gift_card_amount` is annotated "major units", and the ISK exception documented under `AmountSimple` ("2 decimals, fixed minor units .00") is never tied to this endpoint.
- [ ] Confirm the **Landsbankinn** settlement monetary-unit convention for ISK before accepting live money. Settled separately from Verifone above; `src/lib/landsbankinn.ts` and the reconciliation cron compare gateway amounts against bank amounts, so a unit mismatch there would surface as a systematic settlement discrepancy. **Deferred by release-owner decision (2026-08-18):** the daily reconciliation cron is disabled (`crons = []` in `wrangler.production.toml`) and `LANDSBANKINN_*` secrets are non-functional placeholders for this launch. Checkout and payment are fully live without them — Landsbankinn is read-only for settlement matching, not payment creation (`AGENTS.md`) — but orders will accrue in `paid` and never reach `settled` until real Landsbankinn credentials are provisioned and this cron is re-enabled. This is a deliberate scope cut, not an oversight; re-check this item before assuming settlement reconciliation is running.
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
