# Sandbox payment acceptance test

Run this only against the dedicated sandbox Worker and sandbox Verifone/Landsbankinn tenants. Do not use production credentials or customer data.

## Preconditions

- [ ] Replace the `products` seed rows with the approved merchant catalog before any production migration. The repository currently contains development fixtures only; no real catalog was supplied, so it was deliberately not invented.
- [ ] Configure all ten Worker secrets in the sandbox Worker.
- [ ] Apply migrations through `0015_terms_acceptance.sql` (all migrations in `migrations/`, currently `0001`–`0015`) to the sandbox D1 database using `npm run db:migrate:sandbox`. Stopping at `0008` leaves `orders` without `terms_accepted_at`/`terms_version` (`0015`) and `shipping_incl_vat` (`0014`), which the checkout insert (`src/lib/db.ts`) and pricing-integrity check (`src/lib/payment-integrity.ts`) require — checkout and invoicing fail immediately on an `0008`-only database.
- [ ] Set the sandbox webhook URL to `https://<sandbox-worker>/api/webhooks/verifone` — the Worker's own origin, deliberately not `PUBLIC_API_URL`. Webhooks are server-to-server, so there is no browser origin to match, and delivery should not depend on the storefront being up. The storefront proxy would in fact preserve the body byte-exactly (it forwards the `Request` unchanged over a service binding, so detached-JWS verification would still pass) — the reason to keep webhooks direct is one less hop and one less dependency on the payment-confirmation path, not signature safety. Browser returns are the opposite case: they must use `PUBLIC_API_URL` (see `DEPLOYMENT_GATE.md`).
- [ ] Obtain a vendor-signed Verifone fixture or perform the test from Verifone Sandbox.

## Required evidence

For a single test order using a sandbox card, capture only redacted IDs/timestamps and prove:

1. Checkout creates a `checkout_created` order from server catalog pricing.
2. Browser return performs server-to-server checkout verification.
3. A valid signed `TxnSaleApproved` webhook changes it to `paid` exactly once.
4. Replaying the identical webhook returns an idempotent result and creates no second payment event.
5. A sandbox refund webhook changes `paid` to `refunded` exactly once.
6. The next reconciliation job accepts only a successful matching settlement transaction and changes `paid` to `settled`; it must reject the wrong amount/currency/type/status.
7. `GET /api/orders/:id` returns `401` without the checkout-issued `order_status_token` and succeeds with it.

No sandbox payment, webhook, refund, or acquirer settlement credentials are available in this workspace, so this gate cannot be truthfully marked complete here.

---

## Open vendor question — checkout-creation idempotency

`src/lib/verifone.ts` calls `POST {VERIFONE_API_BASE}/v2/checkout` (Checkout API, hosted payment
page). Verifone's published `x-vfi-api-idempotencykey` header belongs to the **eCommerce**
API — `POST /oidc/api/v2/transactions/card`, `/transactions/reverse`, PayPal eCom, and the APM
payment operations. Its scope is documented only as "available on most write operations"; the
Checkout API reference for `POST /v2/checkout` lists authentication headers and no idempotency
header, and no page documents what a replayed key returns. `merchant_reference` is documented as an
identifier, not as a uniqueness or deduplication constraint.

This is why the gateway does not retry checkout creation (see `docs/RELIABILITY.md`). Answer these
against the sandbox tenant with `scripts/probe-verifone-idempotency.sh` — or in writing from
Verifone — before any retry logic is added. A `2xx` on a replay proves nothing on its own: unknown
headers are silently dropped, so only a matching checkout `id` demonstrates idempotency.

- [ ] Does `POST /v2/checkout` honor `x-vfi-api-idempotencykey` at all?
- [ ] Same key + identical body: does it return the original checkout, or create a second one?
- [ ] Same key + different body: error, or silent overwrite of the first checkout?
- [ ] How long is a key retained before it is forgotten and the same value creates a new checkout?

If the answers permit retries, the natural key already exists: `orderId` (`generateUUID()` in
`src/usecases/create-checkout.ts`) is a per-attempt UUID, and the stale-attempt reclaim path mints a
fresh one, so a genuinely new attempt cannot collide with a dead key.
