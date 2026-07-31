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
| `src/lib/verifone.ts`          | Verifone OAuth token fetch, checkout session creation, checkout status retrieval, circuit breaker               | `test/verifone.test.ts`                                    | —                                                    |
| `src/lib/landsbankinn.ts`      | Landsbankinn OAuth token fetch, settlements and transactions retrieval, circuit breaker                         | `test/landsbankinn.test.ts`                                | API error response parsing edge cases                |
| `src/lib/circuit-breaker.ts`   | Failure counting, open/cooldown/half-open trial, per-key isolation                                              | `test/circuit-breaker.test.ts`                             | —                                                    |
| `src/lib/rate-limit.ts`        | IP-based rate limiting via Cloudflare Rate Limiter binding                                                      | `test/rate-limit.test.ts`                                  | Rate limiter binding fallback in dev                 |
| `src/lib/payment-integrity.ts` | Server-side amount & currency verification logic                                                                | `test/quality-gates/financial-integrity.test.ts`           | Partial capture validation                           |
| `src/usecases/*`               | Business logic behind `checkout.ts`, `return.ts`, `webhook.ts` (framework-free, no Hono import)                 | Exercised indirectly via the route integration tests above | —                                                    |

---

## Characterization Backlog

- [x] `verifone.ts`: Network failure does not cache a broken token, and repeated failures open the circuit breaker — `test/verifone.test.ts` ("getVerifoneToken circuit breaker").
- [x] `webhook.ts`: Two simultaneous deliveries of the identical event apply the transition exactly once — `test/webhook.test.ts` ("processes an identical webhook delivered concurrently...").
- [ ] `reconcile.ts` / `landsbankinn.ts`: **Known, deliberately unresolved.** `landsbankinn.ts` has no pagination handling at all today, and the Acquiring API's real pagination contract (if any) is not documented anywhere in this repo. `test/reconcile.test.ts` ("processes a large settlement transaction batch...") pins the _current_ assumption — a single injected array is the complete result set — rather than guessing at unverified vendor pagination semantics (OData `top`/`skip`, a cursor, etc.). Revisit once real Landsbankinn API docs are available; see `SANDBOX_E2E_GATE.md`.

---

## CI & Local Quality Gates

```bash
npm test                             # Run full Vitest suite (109 tests across 19 files)
npm run typecheck                    # Strict TypeScript verification
npm run lint                         # ESLint check
npm run test:quality-gates           # Run security, financial integrity, and E2E rehearsal quality gate suites
npm run quality:check                # Full local quality dashboard validation
```

`test/quality-gates/e2e-rehearsal.test.ts` is a mocked walk through the full
`SANDBOX_E2E_GATE.md` checklist (checkout → return → webhook paid → replay →
refund → reconcile settled + reject a bad settlement → order status). It gives
confidence the wiring works end-to-end; it is not a substitute for that gate,
which requires a real vendor sandbox and a vendor-signed webhook.
