# Reliability — Irja Payments Gateway

## Integration-Point Audit

| Dependency                     | Client timeout                     | Circuit breaker                                                                | Bulkhead                       | Retry policy     | Status |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------ | ---------------- | ------ |
| **Verifone Checkout API**      | 15,000 ms (`UPSTREAM_TIMEOUT_MS`)  | Active — `withCircuitBreaker('verifone')` (in-memory per isolate, best-effort) | Worker concurrency limit       | None (fail fast) | Active |
| **Verifone OAuth Token**       | 15,000 ms (same constant)          | Active — same `verifone` breaker key                                           | KV token cache                 | None (fail fast) | Active |
| **Verifone JWKS Fetch**        | 5,000 ms (`JWKS_FETCH_TIMEOUT_MS`) | None                                                                           | In-isolate + KV cache, 1 h TTL | None (fail fast) | Active |
| **Landsbankinn Acquiring API** | 10,000 ms (`REQUEST_TIMEOUT_MS`)   | Active — `withCircuitBreaker('landsbankinn')` (in-memory per isolate)          | Cron isolation                 | None (fail fast) | Active |
| **Cloudflare D1 Database**     | Platform default (none set)        | Native D1 binding                                                              | Worker connection pool         | Managed by D1    | Active |
| **Cloudflare KV Store**        | Platform default (none set)        | Native KV binding                                                              | Worker connection pool         | Managed by KV    | Active |

Timeout constants: `src/lib/verifone.ts`, `src/lib/landsbankinn.ts`, `src/lib/jwks.ts`.

**No outbound call is retried.** A failed provider call fails the request immediately: checkout creation returns `502 checkout_provider_unavailable` (`src/usecases/create-checkout.ts`) and the storefront owns the retry, per the `checkout_provider_unavailable` contract in `STOREFRONT_INTEGRATION.md`.

Fail-fast on checkout creation is deliberate. Verifone's `x-vfi-api-idempotencykey` header is documented for the **eCommerce** API (`/oidc/api/v2/transactions/card`, `/transactions/reverse`, PayPal eCom, APM payment operations) with the scope "available on most write operations". This gateway calls a different API family — the **Checkout** API's `POST /v2/checkout` — whose reference documents authentication headers only, with no idempotency header and no stated behavior for duplicate or replayed requests; `merchant_reference` is an identifier, not a documented uniqueness constraint. Retrying a checkout-creation `POST` under those conditions risks a second live payment session, so it stays unretried until the vendor answers the four questions in `SANDBOX_E2E_GATE.md`.

JWKS has no stale-cache fallback: once the 1 h cache entry expires, a failed JWKS fetch fails webhook signature verification rather than trusting expired keys.

Circuit breaker implementation: `src/lib/circuit-breaker.ts` — threshold 5 consecutive failures, 30 s cooldown, then a trial call. The trial is not single-flight: every concurrent request in that isolate is admitted once the cooldown elapses. It is a best-effort per-isolate mitigation, not a distributed multi-isolate breaker.

---

## Health Checks & Metrics

### Deep Health Check (`/health`)

- **Shallow Check:** Returns `{ status: "ok" }` HTTP 200 immediately.
- **Deep Check (`/health?deep=1`):**
  1. Executes lightweight D1 ping (`SELECT 1`).
  2. Verifies KV binding accessibility.
  3. Returns `200 OK` with a JSON status breakdown, or `503` with `"status": "unhealthy"` if either check fails:
     ```json
     {
       "status": "healthy",
       "checks": {
         "d1": "ok",
         "kv": "ok"
       },
       "timestamp": "2026-07-28T19:45:00.000Z"
     }
     ```

### Observability & Logging

- Structured JSON logging on stdout for Worker log tailing.
- Log context includes `order_id`, `event_id`, `run_id`, and `environment`.
- Secrets and capability tokens are stripped/redacted before output.

---

## Deploy vs Release

### Safeguards

- **Dry-Run Deploy:** `npx wrangler deploy --dry-run` required prior to production release.
- **Deployment Gates:** Production deployments fail closed unless explicit environment confirmation flags are set (`CONFIRM_PRODUCTION_DEPLOY=1`).
- **Migration Safeguards:** Database schema changes applied via sequential versioned migrations (`migrations/0001` to `0008`). D1 remote migrations require explicit confirmation (`CONFIRM_PRODUCTION_MIGRATION=1`).

---

## Open Reliability Items

The integration-point audit above has no open rows on the payment path — every outbound call has a timeout, and both providers are behind a breaker. These three remain and are tracked elsewhere rather than duplicated here:

| Item                                                  | Blocking?                                                       | Owner / tracker                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PUBLIC_API_URL` `/api/return` must reach this Worker | Sandbox verified 2026-08-02; production origin still unverified | `scripts/verify-return-routing.sh`; gate item in `DEPLOYMENT_GATE.md`                    |
| Checkout-creation retry policy                        | No — fail-fast is safe                                          | `scripts/probe-verifone-idempotency.sh` + four vendor questions in `SANDBOX_E2E_GATE.md` |
| Breaker trial is not single-flight                    | No — per-isolate blast radius                                   | Debt Ledger row in `docs/TECH-DEBT.md`; behavior unpinned per `docs/TESTING.md`          |
