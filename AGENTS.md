# AGENTS.md — Irja Payments Gateway

## Hard rules (system alignment)

Non-negotiable for every agent session in this repo:

1. **Zero pedagogical filler.** Do not explain standard cloud-native concepts, TypeScript syntax, Wrangler workflows, HTTP basics, or Cloudflare Workers 101 unless explicitly asked. Deliver diffs, commands, and results.
2. **Test-first enforcement.** Every feature or fix ships with a corresponding Vitest unit/integration test. Write the failing test first; do not mark work complete until `npm test` (and relevant gates) pass. No production/path change without test coverage for the behavior.
3. **Edge-first constraints.** Default target is Cloudflare Workers: ES modules, strict TypeScript, no Node-only APIs unless already proven under `nodejs_compat`, no filesystem assumptions in runtime code, bindings via `Env`, secrets via Wrangler Secrets / `.dev.vars` only.

## Trust boundary (operational tiers)

| Tier | Scope | Authority |
|------|--------|-----------|
| **1 — Read & Verify** | Tests, typecheck/lint, static analysis, log tail, local memory/docs, file reads | **Fully autonomous.** Loop until green. Never ask permission to test or read local files. |
| **2 — Non-destructive write** | App/test code, scaffolding, local commits, markdown docs | **Autonomous (local).** Write/commit locally; human reviews final diff, not each step. |
| **3 — State & infrastructure** | D1 migrations/schema apply, IAM/RBAC, crypto changes, live webhooks, `wrangler deploy`, remote secrets, prod/sandbox mutations | **Hard stop.** Draft artifact only → halt → explicit human approval (hardware key / YubiKey when required) before execute. |

### Enforcement directives

1. **Auto-testing.** After any `.ts` change, run the associated suite via `npm test` (wrapped in `scripts/with-agent-safe-env.sh`). Do not ask permission. On failure: max **3** self-correction attempts, then halt with failing output.
2. **Isolate secrets.** Local T1/T2 loops must not use real Cloudflare / Landsbankinn / Verifone credentials from the process environment. `npm test` / `typecheck` / `lint` strip those via `with-agent-safe-env.sh`. Prefer placeholders in gitignored `.dev.vars` (mode `0600`). Never print or commit secrets. Remote deploy/migrate remain Tier 3 and intentionally keep host credentials only after human approval.
3. **Review gates (Tier 3 paths).** Halt and request explicit review before applying changes to: `src/lib/crypto.ts`, anything under `migrations/`, `wrangler.toml`, `wrangler.production.toml*`, deploy scripts, or any remote migrate/deploy command.

## What This Is

A payments gateway for the Irja e-commerce storefront (`irja.is`, currently staged at `irja.khalipa.net`). Handles checkout session creation, payment verification, webhook processing, and daily settlement reconciliation.

**Acquiring:** Landsbankinn ehf (Iceland) — card acquirer
**Payment gateway:** Verifone Hosted Payments Page (HPP) — handles all card capture and 3DS/SCA
**Platform:** Cloudflare Workers + D1 (SQLite) + KV (cache)
**PCI scope:** SAQ A — card data never touches this infrastructure

## Architecture

```
Storefront (Pages) → Worker /api/checkout → Verifone HPP → Worker /api/return
                     ↓                                          ↓
                     D1 (orders)                    Worker /api/webhooks/verifone
                                                   ↓
                                                   D1 (orders + payment_events)

Cron (06:00 UTC) → Worker /scheduled → Landsbankinn Acquiring API → D1 (settlements)
```

### Key design decisions

- **No card data ever enters this system.** Verifone HPP owns the card capture form. The Worker only sees transaction IDs and metadata. This keeps PCI scope at SAQ A.
- **Server-side amount computation.** Checkout accepts only `product_id` (or `sku`) + `quantity`. Unit prices come from the D1 `products` catalog; client `unit_price` / `total_amount` are rejected as price manipulation.
- **Verify, don't trust.** Both the redirect return and webhook are verified server-to-server against the Verifone API before order status changes. The `transaction_id` from the redirect must match the checkout's `transaction_id`.
- **Idempotent webhooks.** A `processed_webhooks` table deduplicates by `verifone_event_id`. Duplicate deliveries return 200 without reprocessing.
- **JWS webhook verification.** Verifone signs webhooks with JWS (JSON Web Signature) using JWKS. The Worker canonicalizes the JSON body per RFC 8785, matches the `kid` from the `x-vfi-jws` header against cached JWKS, and verifies with the Web Crypto API.
- **Amounts in whole krónur.** All monetary amounts are integers in ISK major units (whole krónur), never aurar. No floating-point.

## Project Structure

```
src/
├── index.ts                 # Hono router, Worker entry, cron handler
├── routes/
│   ├── checkout.ts          # POST /api/checkout — create order + Verifone session
│   ├── return.ts            # GET /api/return — verify payment, update order
│   ├── webhook.ts           # POST /api/webhooks/verifone — JWS-verified notifications
│   └── order.ts             # GET /api/orders/:id — order status (no sensitive fields)
├── lib/
│   ├── verifone.ts          # OAuth2 JWT, checkout create/read, payment parsing
│   ├── landsbankinn.ts      # OAuth2, settlements, transactions (read-only reconciliation)
│   ├── oauth.ts             # Shared OAuth2 client-credentials token fetch/cache (Verifone + Landsbankinn)
│   ├── catalog.ts           # Authoritative product catalog + secure cart resolution
│   ├── db.ts                # D1 query helpers, UUID/order number generation
│   ├── jwks.ts              # JWKS fetch + KV cache for webhook verification
│   └── crypto.ts            # JWS verification, JSON canonicalization (RFC 8785)
├── cron/
│   └── reconcile.ts         # Daily settlement reconciliation against Landsbankinn API
└── types/
    ├── env.ts               # Cloudflare Worker bindings + secret type definitions
    └── api.ts               # Shared domain types (Order, Verifone, Landsbankinn)

migrations/
├── 0001_init.sql                    # D1 schema: orders, payment_events, processed_webhooks, settlements
├── 0002_products.sql                # Product catalog + seed prices (authoritative)
├── 0003_order_access_tokens.sql     # Hashed order-status capability tokens
├── 0004_checkout_idempotency.sql    # checkout_attempts table for Idempotency-Key handling
├── 0005_order_invariants.sql        # Unique provider-identifier and monetary invariants
├── 0006_reconciliation_runs.sql     # Durable reconciliation cursor and run history
├── 0007_order_number_index.sql      # Index order_number for reconciliation cron lookups
├── 0008_payment_method.sql          # payment_method column for PayPal/wallet settlement isolation
├── 0009_invoice_tables.sql          # Icelandic invoice (sölureikningur) tables, VAT/kennitala
├── 0010_credit_notes.sql            # Credit note issuance and linkage to original invoices
├── 0011_audit_hash.sql              # 7-year audit-hash retention chain
├── 0012_failure_recovery_states.sql # Failure-recovery state machine columns
├── 0013_incident_tracking.sql       # Incident tracking tables
├── 0014_shipping_cost.sql           # orders.shipping_incl_vat, required by assertPricingIntegrity
├── 0015_terms_acceptance.sql        # orders.terms_accepted_at/terms_version, required by checkout insert
├── 0016_customer_billing.sql        # Billing identity + verifone_customer_id for HPP 3DS checkouts
└── 0017_merchant_catalog.sql        # Real merchant catalog; deactivates dev fixture SKUs

Stopping at `0008` breaks checkout and invoicing immediately — `0014` and `0015`
are required by `src/lib/db.ts` and `src/lib/payment-integrity.ts`. Re-verify
this list stays current as new migrations land.

test/
├── apply-migrations.ts      # Inlined D1 schema for Workers runtime (avoids node:fs issue)
├── verifone.test.ts          # parseCheckoutResult unit tests
├── checkout.test.ts         # POST /api/checkout integration (vi.mock + SELF + real D1)
├── return.test.ts            # GET /api/return integration
├── webhook.test.ts           # POST /api/webhooks/verifone integration
├── order.test.ts             # GET /api/orders/:id integration
└── landsbankinn.test.ts      # Module export verification
```

## Tech Stack

- **Runtime:** Cloudflare Workers (TypeScript, `nodejs_compat`)
- **Router:** Hono v4
- **Database:** Cloudflare D1 (SQLite) — database `irja-payments` (WEUR)
- **Cache:** Cloudflare KV — namespace `irja-payments-cache` (OAuth tokens, JWKS)
- **Test:** Vitest + `@cloudflare/vitest-pool-workers` v0.5.x
- **Deploy:** Wrangler

## Development

```bash
npm install                 # Install dependencies
npm run dev                 # Local dev server (wrangler dev)
npm test                    # Run all tests (vitest run)
npm run test:watch          # Watch mode
npm run lint                # Type-check (tsc --noEmit)
npm run db:migrate:local    # Apply D1 schema locally
npm run db:migrate:prod     # Apply D1 schema to remote (needs CF API token)
```

### Test pattern

Tests use `vi.mock()` to mock external API clients (Verifone, Landsbankinn) and `SELF.fetch()` from `cloudflare:test` to exercise the full HTTP pipeline through the Hono router against a real Miniflare D1 instance. `fetchMock` from `cloudflare:test` does **not** intercept outbound `fetch()` calls in `@cloudflare/vitest-pool-workers` v0.5.x — this is a known limitation. The `vi.mock` + `SELF` pattern is the working alternative.

A separate `wrangler.test.toml` provides test-only API URLs so mocks can be registered against predictable origins. `test/apply-migrations.ts` inlines the D1 schema SQL because `readD1Migrations()` from the pool-workers config pulls in `node:fs/promises` at module-load time, which is unavailable in the Workers runtime.

## Secrets

All secrets are stored in Cloudflare Secrets Store — never in code, `wrangler.toml`, or `.dev.vars` (which is gitignored). Set via:

```bash
npx wrangler secret put VERIFONE_USER_ID
npx wrangler secret put VERIFONE_API_KEY
# ... see src/types/env.ts for the full list
```

`.dev.vars` is used for local development only and contains placeholder values.

## D1 Schema

| Table | Purpose |
|-------|---------|
| `orders` | Order lifecycle: pending → checkout_created → paid → settled |
| `products` | Authoritative catalog: id/SKU, name, unit_price (whole krónur), active |
| `payment_events` | Audit log: every state transition with source, payload, verified flag |
| `processed_webhooks` | Idempotency: deduplicates by `verifone_event_id` |
| `settlements` | Landsbankinn settlement batches from daily reconciliation cron |

All IDs are UUID v4 (no auto-increment). Amounts are integers in whole krónur (ISK major units).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/checkout` | Create order + Verifone checkout session, return HPP redirect URL |
| GET | `/api/return` | Handle redirect from Verifone, verify payment server-side |
| POST | `/api/webhooks/verifone` | Handle Verifone webhook (JWS-verified, idempotent) |
| GET | `/api/orders/:id` | Order status (no sensitive fields exposed) |

## External APIs

### Verifone Checkout API v2
- **Auth:** OAuth2 client credentials → JWT bearer token (180s TTL, cached in KV)
- **Create checkout:** `POST /v2/checkout` with HPP interaction type + 3DS config
- **Read checkout:** `GET /v2/checkout/{id}` — verify payment via `events[]` array
- **Webhooks:** JWS-signed with JWKS, events include `Checkout - Transaction succeeded/failed`, `TxnRefundApproved`
- **Sandbox:** `https://cst.test-gsc.vfims.com/oidc/checkout-service`
- **EMEA Production:** `https://emea.gsc.verifone.cloud/oidc/checkout-service`

### Landsbankinn Acquiring API v1
- **Read-only** — settlements and transactions for reconciliation, does NOT create payments
- **Auth:** OAuth2 client credentials
- **Endpoints:** `GET /Settlements`, `GET /Settlements/{id}/Transactions`, `GET /Transactions`
- **Sandbox:** `https://apisandbox.landsbankinn.is/api/Acquiring/Acquiring/v1`

## Constraints for Agents Working on This Repo

Hard rules above always apply. Domain constraints:

1. **Never store, process, or transmit card data.** No PAN, CVV, expiry, or cardholder name. Card capture stays on Verifone HPP.
2. **Always verify payments server-side.** Never trust redirect query params or webhook payloads alone. Call `GET /v2/checkout/{id}` before status transitions.
3. **Keep webhooks idempotent.** Check `processed_webhooks` before processing. Return 200 for duplicates.
4. **Amounts are integers.** Whole krónur (ISK major units), never aurar. No floating-point money.
5. **Test-first (Vitest).** Failing test before implementation. Pattern: `vi.mock` + `SELF.fetch` + real Miniflare D1. Do not call work complete without green tests.
6. **No secrets in code.** `wrangler secret put`; `.dev.vars` gitignored.
7. **Maintain the audit trail.** Every state transition → `payment_events` with source + timestamp.
8. **Respect the D1 schema.** UUID IDs only. No card-related columns.
9. **Price integrity is mandatory.** Client sends only `product_id`/`sku` + `quantity`. Reject client `unit_price` / `total_amount`. Catalog in D1 `products`. Return + webhook must verify Verifone amount vs stored order amount.
10. **No Teya shims.** Storefront contract is Verifone paths only; do not add insecure compatibility layers.
