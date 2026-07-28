# Testing — Irja Payments Gateway

## Test Strategy

- **Framework:** Vitest + `@cloudflare/vitest-pool-workers` v0.18.x
- **Environment:** Isolated Miniflare instances simulating Cloudflare Worker runtime, D1 SQLite database, and KV store.
- **Pattern:** `vi.mock()` for external HTTP client isolation (Verifone, Landsbankinn) + `SELF.fetch()` from `cloudflare:test` to exercise full router endpoints.
- **Quality Gates:** `npm run test:quality-gates` runs security regression, financial integrity, and proxy detection checks.

---

## Safety Net Map

| Module                         | Pinned Behaviors                                                                                                | Test Files                                                 | Gaps                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `src/routes/checkout.ts`       | Body size limits, price manipulation rejection, idempotency locking, order token generation                     | `test/checkout.test.ts`, `test/price-manipulation.test.ts` | Extreme high-concurrency idempotency lock contention |
| `src/routes/return.ts`         | Redirect return payment verification, S2S Verifone check, amount & currency match, idempotent status transition | `test/return.test.ts`                                      | Session expiration timing windows                    |
| `src/routes/webhook.ts`        | JWS signature validation, JWKS kid matching, deduplication via `processed_webhooks`, refund event handling      | `test/webhook.test.ts`                                     | Vendor JWKS key rotation handling                    |
| `src/routes/order.ts`          | Capability token hash check, non-enumerable order lookup, masked metadata return                                | `test/order.test.ts`                                       | Rate limiting per token                              |
| `src/cron/reconcile.ts`        | Landsbankinn settlement fetch, transaction matching, D1 status transition to `settled`, error logging           | `test/reconcile.test.ts`                                   | Multi-day catchup cursor recovery                    |
| `src/lib/catalog.ts`           | Authoritative product catalog lookup, unit price calculation in minor units (aurar)                             | `test/price-manipulation.test.ts`                          | Catalog cache invalidation                           |
| `src/lib/crypto.ts`            | Detached JWS RFC 7797 payload canonicalization and verification via Web Crypto API                              | `test/crypto.test.ts`                                      | Alternative JWS algorithm handling                   |
| `src/lib/jwks.ts`              | JWKS key fetching, KV caching, kid matching                                                                     | `test/jwks.test.ts`                                        | KV eviction on stale keys                            |
| `src/lib/verifone.ts`          | Verifone OAuth token fetch, checkout session creation, checkout status retrieval                                | `test/verifone.test.ts`                                    | OAuth token refresh under network error              |
| `src/lib/landsbankinn.ts`      | Landsbankinn OAuth token fetch, settlements and transactions retrieval                                          | `test/landsbankinn.test.ts`                                | API error response parsing edge cases                |
| `src/lib/rate-limit.ts`        | IP-based rate limiting via Cloudflare Rate Limiter binding                                                      | `test/rate-limit.test.ts`                                  | Rate limiter binding fallback in dev                 |
| `src/lib/payment-integrity.ts` | Server-side amount & currency verification logic                                                                | `test/quality-gates/financial-integrity.test.ts`           | Partial capture validation                           |

---

## Characterization Backlog

- [ ] `verifone.ts`: Characterize network retry behavior when KV cache holds an expired OAuth token during upstream outage.
- [ ] `reconcile.ts`: Characterize multi-day transaction batching when Landsbankinn API paginates >1000 settlement records.
- [ ] `webhook.ts`: Characterize behavior when Verifone sends duplicate webhooks simultaneously on two parallel connection workers.

---

## CI & Local Quality Gates

```bash
npm test                             # Run full 90-test Vitest suite
npm run typecheck                    # Strict TypeScript verification
npm run lint                         # ESLint check
npm run test:quality-gates           # Run security & financial integrity quality gate suites
npm run quality:check                # Full local quality dashboard validation
```
