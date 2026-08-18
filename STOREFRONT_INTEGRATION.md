# Storefront integration and checkout UX

## Recommended deployment shape

Use one public origin and route `/api/*` to this Worker:

```text
Browser -> irja.is (storefront)
                 \-> /api/* (Cloudflare Worker)
Worker  -> D1/KV
Worker  -> Verifone APIs -> Verifone hosted payment page
Verifone -> /api/webhooks/verifone (authenticated JWS)
Browser <- /api/return <- Verifone HPP
```

Keeping the storefront and gateway on one origin avoids unnecessary CORS exposure. If the Worker uses a separate origin, set `STOREFRONT_URL` to the exact browser origin and `PUBLIC_API_URL` to the Worker's public HTTPS origin. Verifone returns to `PUBLIC_API_URL/api/return`; the Worker then redirects the browser to the storefront.

The currently deployed `irja.khalipa.net` bundle is **not compatible** with this contract: it posts a numeric `cart` to `/api/teya/checkout`, expects `checkoutUrl`, and labels the provider as Teya. This gateway uses Verifone and the contract below. Update the storefront and edge routing as one release; do not add an insecure price-mapping compatibility shim in the gateway.

The hosted payment page is intentional. The storefront and Worker must never collect, proxy, log, or persist cardholder data.

## Checkout contract

`POST /api/checkout`

Headers:

```http
Content-Type: application/json
Idempotency-Key: <crypto.randomUUID() generated once for this checkout attempt>
```

Body:

```json
{
  "items": [{ "product_id": "LOPAPEYSA-M", "quantity": 1 }],
  "customer_email": "buyer@example.is",
  "billing": {
    "first_name": "Buyer",
    "last_name": "Name",
    "address_1": "Laugavegur 1",
    "city": "Reykjavík",
    "country_code": "IS",
    "postal_code": "101"
  },
  "terms_accepted": true,
  "terms_version": "2026-08-17"
}
```

`terms_accepted` and `terms_version` are **required**. The Worker rejects the checkout with `400 terms_not_accepted` unless `terms_accepted` is exactly `true`, and with `400 terms_version_mismatch` unless `terms_version` equals the gateway's current `TERMS_VERSION` (defined in `src/lib/terms.ts`). The buyer must accept the terms of sale (including the 14-day withdrawal notice) before the storefront initiates checkout; the Worker persists `terms_accepted_at` + `terms_version` on the order as the consent record.

**Version bump procedure:** when the storefront terms page (`app/terms/page.tsx`) content changes, bump `TERMS_VERSION` in the storefront's `app/lib/compliance.ts` **and** the gateway's `src/lib/terms.ts` to the same new value (date-based, e.g. `2026-08-17`). The storefront ships a drift test pinning the value, so the two repos cannot silently diverge.

Never send prices, totals, currency, product names, or payment state from the browser. The Worker resolves the catalog price and rejects client-controlled money fields.

`customer_email` and `billing` are required for every new checkout because the
gateway creates a Verifone Customer and attaches its ID to the HPP 3DS session.
`billing.first_name`, `last_name`, `address_1`, `city`, `postal_code`, and a
two-letter ISO 3166-1 `country_code` are mandatory. `state` and an E.123-style
`phone` are optional. The gateway searches Verifone for an exact email/entity and
billing match before creating a customer, so retries recover accepted-but-timed-
out customer creation rather than blindly issuing another create request. Exact completed retries
created before this requirement remain replayable; new and reclaimed attempts
must satisfy the current contract.

A successful response contains:

```json
{
  "checkout_url": "https://...",
  "order_id": "...",
  "order_number": "...",
  "amount": 18000,
  "currency": "ISK",
  "order_status_token": "...",
  "idempotent_replay": false
}
```

The storefront should:

1. Disable the pay button while the request is in progress.
2. Reuse the same idempotency key when retrying the same cart after a timeout.
3. Generate a new key after the cart contents change or after a definitive failed attempt.
4. Keep `order_id` and `order_status_token` in `sessionStorage`, not in URLs or analytics events.
5. Redirect with `window.location.assign(checkout_url)` only after validating that the response is successful.
6. Show the authoritative amount and currency returned by the API before redirecting.

The API returns `409 idempotency_conflict` if a key is reused with different checkout data. A completed retry returns the original order and checkout URL rather than creating a second payment session.

## Cancelled checkout

Verifone's Checkout API has no `cancel_url`. The documented field for an abandoned HPP is `shop_url`, which the gateway sets from `STOREFRONT_URL` on every checkout. A shopper who cancels lands back on the storefront root, not on `/api/return`.

A cancel produces no provider event, so the order stays non-terminal (`checkout_created`) until it expires or the buyer retries. The storefront should treat a buyer arriving back at the store with a live `irja:order-session` as an abandoned attempt, not a failure: keep the cart, and mint a new idempotency key only once the cart contents actually change.

## Return and status recovery

The HPP browser return is navigation, not proof of payment. Query parameters such as `status`, `transaction_id`, and `checkout_id` are untrusted.

After the Worker redirects the browser to `/order/:order_id?status=...`, the storefront must fetch the authoritative order state:

```http
GET /api/orders/<order_id>
Authorization: Bearer <order_status_token>
```

Do not put the status token in a query string. Query strings leak through browser history, access logs, referrers, screenshots, and analytics.

Use `terminal`, `next_poll_ms`, `updated_at`, and `can_retry` from the order response. Poll with backoff while the order is non-terminal, pause while the page is hidden or the browser is offline, and offer a manual “Check payment status” action after automatic polling stops.

Suggested messages:

| State                         | Customer message                    | Action                             |
| ----------------------------- | ----------------------------------- | ---------------------------------- |
| `pending`, `checkout_created` | “Waiting for payment confirmation…” | Poll                               |
| `payment_pending`             | “Your payment is being confirmed.”  | Poll, do not ask them to pay again |
| `paid`                        | “Payment received.”                 | Fulfil/order confirmation          |
| `failed`                      | “Payment was not completed.”        | Offer a new checkout attempt       |
| `refunded`                    | “Payment refunded.”                 | Show support details               |
| `settled`                     | Same customer treatment as `paid`   | No extra customer action           |

Never fulfil from the return-page status parameter. Fulfil only from the authenticated order API or trusted backend event after the Worker has recorded a verified provider result.

## Error handling

Map stable API `code` values to customer-friendly text. Keep provider/internal errors out of the UI.

- `validation`, `unknown_product`, `inactive_product`: ask the customer to refresh the cart.
- `price_manipulation`: treat as a client/integration bug; do not retry unchanged.
- `idempotency_key_required`: integration bug; generate a valid key.
- `idempotency_conflict`: generate a new key only after confirming the cart is intentionally different.
- `idempotency_processing`: wait for `Retry-After` and retry once.
- `checkout_provider_unavailable`: preserve the cart and offer retry; do not claim payment failed.
- `customer_details_required`, `customer_details_invalid`: keep the buyer on the checkout form and correct the contact/billing fields.
- `customer_provider_unavailable`: preserve the cart and offer retry; no HPP session was created.
- HTTP `429`: obey `Retry-After` and keep the pay button disabled until then.

## Architecture decision

This gateway is a good fit for a small custom storefront when:

- the catalog is intentionally maintained in D1;
- stock, shipping, discounts, tax, and fulfilment are simple;
- Verifone HPP is the only payment flow;
- the storefront can route `/api/*` to this Worker.

It is **not** the best boundary for a full commerce system whose own backend already owns products, carts, stock, tax, discounts, customers, and orders. In that case, do not duplicate the commerce catalog in this gateway or let the browser ask the gateway to construct an order. The commerce backend should create and price the order, reserve stock, and send this Worker an authenticated immutable order snapshot. The gateway should then own only payment attempts, provider communication, verified payment state, webhooks, and reconciliation.

Do not replace the hosted payment page with custom card fields unless there is a hard business requirement and a deliberate PCI DSS scope decision. That would materially increase security, compliance, fraud, and operational burden.
