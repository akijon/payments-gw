# Edge security requirements

These controls are mandatory before `npm run deploy:production` is allowed to run.

## Worker rate limiting

1. Copy `wrangler.production.toml.example` to the ignored `wrangler.production.toml`.
2. Replace `REPLACE_ME_PRODUCTION_RATE_LIMIT_NAMESPACE_ID` with a dedicated Cloudflare Rate Limiting namespace.
3. Keep the checkout binding named `CHECKOUT_RATE_LIMITER`.
4. Start with the versioned Worker limit of **10 checkout attempts per IP per 60 seconds**. Adjust only from observed, documented traffic data.

The Worker fails closed in production if Cloudflare does not provide a client IP or the rate-limit binding is absent.

## Cloudflare dashboard rules

Create and verify these dashboard controls against the production hostname before go-live:

- **Rate-limit `/api/checkout`** by source IP at the edge. Match the Worker setting or set a stricter limit.
- **Rate-limit `/api/orders/*`** to reduce UUID probing and metadata harvesting.
- **Allow Verifone webhooks** only on `POST /api/webhooks/verifone`; do not challenge or cache them.
- **Block methods other than POST** for `/api/checkout` and `/api/webhooks/verifone` and other than GET/OPTIONS for `/api/orders/*`.
- Enable Cloudflare managed WAF rules and Bot Fight Mode / Super Bot Fight Mode where compatible with the storefront.
- Create alerts for checkout rate-limit spikes, WAF blocks, Worker exceptions, and webhook 401/503 responses.

Dashboard configuration is external to this repository. Record the rule IDs and a verification timestamp in the production release ticket; never claim this checklist is complete only because the Worker code compiles.
