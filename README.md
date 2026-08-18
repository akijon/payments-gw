# Irja Payments Gateway

Cloudflare Worker payment gateway for the Irja storefront.

- **Acquiring:** Landsbankinn ehf
- **HPP:** Verifone Hosted Payments Page (PCI SAQ A — no card data here)
- **Runtime:** Workers + D1 + KV

## Secure checkout contract

```http
POST /api/checkout
Content-Type: application/json
Idempotency-Key: <crypto.randomUUID()>

{
  "items": [
    { "product_id": "LOPAPEYSA-M", "quantity": 1 }
  ],
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

Client sends **product_id (or sku) + quantity only**. Prices come from the D1
`products` catalog. Sending `unit_price` or `total_amount` is rejected.

See [`STOREFRONT_INTEGRATION.md`](./STOREFRONT_INTEGRATION.md) for checkout UX,
retry/recovery behavior, return-page security, and the architecture decision for
linking a custom storefront.

## Develop

```bash
npm install
npm run db:migrate:local
npm test
npm run lint
npm run dev
```

## Deploy (after credentials)

```bash
npm run deploy:check
npm run secrets:setup
npm run db:migrate:prod
npm run deploy
```

See `AGENTS.md`, `DEPLOYMENT_STATUS.md`, and `DEPLOYMENT_CHECKLIST.md`.
