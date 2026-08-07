# Sandbox payment acceptance test

Run this only against the dedicated sandbox Worker and sandbox Verifone/Landsbankinn tenants. Do not use production credentials or customer data.

## Preconditions

- [ ] Replace the `products` seed rows with the approved merchant catalog before any production migration. The repository currently contains development fixtures only; no real catalog was supplied, so it was deliberately not invented.
- [ ] Configure all ten Worker secrets in the sandbox Worker.
- [ ] Apply migrations through `0008_payment_method.sql` to the sandbox D1 database using `npm run db:migrate:sandbox`.
- [ ] Set the sandbox callback/webhook URL to `https://<sandbox-worker>/api/webhooks/verifone`.
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
