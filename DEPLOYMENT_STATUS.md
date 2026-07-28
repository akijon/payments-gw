# Deployment Status — Irja Payments Gateway

## Security: price integrity FIXED

Client-controlled pricing is blocked. Checkout uses the D1 `products` catalog.
Return and webhook paths verify Verifone amount against the order amount.

See `SECURITY_VULNERABILITY_CRITICAL.md` for the fix summary.

## Still required before production

| Item                                  | Status                                |
| ------------------------------------- | ------------------------------------- |
| Server-side product catalog           | ✅ Done                               |
| Reject client unit_price/total_amount | ✅ Done                               |
| S2S payment verify on return          | ✅ Done                               |
| S2S + amount check on webhook paid    | ✅ Done                               |
| JWS webhook verification              | ✅ Done                               |
| CORS locked to STOREFRONT_URL         | ✅ Done                               |
| Security headers                      | ✅ Done                               |
| Real Verifone credentials             | ❌ Blocking                           |
| CF API token (Workers/D1/KV edit)     | ❌ Check with `npm run deploy:check`  |
| Production product rows in D1         | ⚠️ Seed only — replace with real SKUs |
| Storefront uses product_id + qty API  | ⚠️ Coordinate with irja storefront    |
| WAF / rate limiting on CF             | ⚠️ Configure in dashboard             |
| Production secrets + env vars         | ⚠️ `npm run secrets:setup`            |

## Quick verify

```bash
npm test
npm run lint
npm run db:migrate:local   # includes catalog, order-token, and checkout-idempotency migrations
```

## Checkout API (storefront contract)

`POST /api/checkout`

Required header: `Idempotency-Key: <crypto.randomUUID()>`

```json
{
  "items": [{ "product_id": "LOPAPEYSA-M", "quantity": 1 }],
  "customer_email": "customer@example.is"
}
```

Response includes authoritative `amount` / `total_amount` (minor units) from the catalog.
