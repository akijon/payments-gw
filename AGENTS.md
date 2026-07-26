# AGENTS.md — Irja Payments Gateway

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
- **Server-side amount computation.** The checkout amount is calculated from client-supplied line items in the Worker. **WARNING: Current implementation trusts client-supplied prices - this creates a critical security vulnerability. Production deployment requires a server-side product catalog with authoritative pricing.**
- **Verify, don't trust.** Both the redirect return and webhook are verified server-to-server against the Verifone API before order status changes. The `transaction_id` from the redirect must match the checkout's `transaction_id`.
- **Idempotent webhooks.** A `processed_webhooks` table deduplicates by `verifone_event_id`. Duplicate deliveries return 200 without reprocessing.
- **JWS webhook verification.** Verifone signs webhooks with JWS (JSON Web Signature) using JWKS. The Worker canonicalizes the JSON body per RFC 8785, matches the `kid` from the `x-vfi-jws` header against cached JWKS, and verifies with the Web Crypto API.
- **Amounts in minor units.** All monetary amounts are integers in minor units (aurar for ISK). No floating-point.

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
│   ├── db.ts                # D1 query helpers, UUID/order number generation
│   ├── jwks.ts              # JWKS fetch + KV cache for webhook verification
│   └── crypto.ts            # JWS verification, JSON canonicalization (RFC 8785)
├── cron/
│   └── reconcile.ts         # Daily settlement reconciliation against Landsbankinn API
└── types/
    ├── env.ts               # Cloudflare Worker bindings + secret type definitions
    └── api.ts               # Shared domain types (Order, Verifone, Landsbankinn)

migrations/
└── 0001_init.sql            # D1 schema: orders, payment_events, processed_webhooks, settlements

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
npx wrangler secret put VERIFONE_CLIENT_ID
npx wrangler secret put VERIFONE_CLIENT_SECRET
# ... see src/types/env.ts for the full list
```

`.dev.vars` is used for local development only and contains placeholder values.

## D1 Schema

| Table | Purpose |
|-------|---------|
| `orders` | Order lifecycle: pending → checkout_created → paid → settled |
| `payment_events` | Audit log: every state transition with source, payload, verified flag |
| `processed_webhooks` | Idempotency: deduplicates by `verifone_event_id` |
| `settlements` | Landsbankinn settlement batches from daily reconciliation cron |

All IDs are UUID v4 (no auto-increment). Amounts are integers in minor units.

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

1. **Never store, process, or transmit card data.** No PAN, CVV, expiry, or cardholder name. If a feature requires touching card data, it belongs on Verifone's side, not here.
2. **Always verify payments server-side.** Never trust redirect query parameters or webhook payloads alone. Call `GET /v2/checkout/{id}` and confirm the transaction before updating order status.
3. **Keep webhooks idempotent.** Check `processed_webhooks` before processing. Return 200 for duplicates.
4. **Amounts are integers.** Minor units (aurar for ISK). Never use floating-point for money.
5. **Test-first.** Write failing tests before implementation. Use `vi.mock` + `SELF.fetch` pattern.
6. **No secrets in code.** Use `wrangler secret put`. `.dev.vars` is gitignored.
7. **Maintain the audit trail.** Every state transition goes into `payment_events` with source and timestamp.
8. **Respect the D1 schema.** UUIDs for IDs, not auto-increment. Don't add card-related columns.
9. **⚠️ CRITICAL: Price integrity vulnerability exists.** Current implementation trusts client-supplied prices. This allows price manipulation attacks (lowering unit prices, fabricating SKUs, inconsistent quantities). **DO NOT DEPLOY TO PRODUCTION** without implementing a server-side product catalog that provides authoritative pricing. The client should only send product IDs and quantities - never prices or totals.
