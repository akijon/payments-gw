# Reliability — Irja Payments Gateway

## Integration-Point Audit

| Dependency                     | Timeout   | Circuit Breaker                                                                | Bulkhead                 | Retry Policy         | Status |
| ------------------------------ | --------- | ------------------------------------------------------------------------------ | ------------------------ | -------------------- | ------ |
| **Verifone Checkout API**      | 15,000 ms | Active — `withCircuitBreaker('verifone')` (in-memory per isolate, best-effort) | Worker Concurrency Limit | 2 Retries w/ Backoff | Active |
| **Verifone OAuth Token**       | 15,000 ms | Active — same `verifone` breaker key                                           | KV Token Cache           | 1 Immediate Retry    | Active |
| **Verifone JWKS Fetch**        | 5,000 ms  | N/A (Cached in KV 24h)                                                         | KV Key Cache             | Fallback to cached   | Active |
| **Landsbankinn Acquiring API** | 10,000 ms | Active — `withCircuitBreaker('landsbankinn')` (in-memory per isolate)          | Cron Isolation           | 2 Retries w/ Backoff | Active |
| **Cloudflare D1 Database**     | 5,000 ms  | Native D1 Binding                                                              | Worker Connection Pool   | Managed by D1 Driver | Active |
| **Cloudflare KV Store**        | 3,000 ms  | Native KV Binding                                                              | Worker Connection Pool   | Managed by KV Driver | Active |

Circuit breaker implementation: `src/lib/circuit-breaker.ts` — threshold 5 consecutive failures, 30s cooldown, half-open trial. Not a distributed multi-isolate breaker.

---

## Health Checks & Metrics

### Deep Health Check (`/health`)

- **Shallow Check:** Returns `{ status: "ok" }` HTTP 200 immediately.
- **Deep Check (`/health?deep=1`):**
  1. Executes lightweight D1 ping (`SELECT 1`).
  2. Verifies KV binding accessibility.
  3. Returns `200 OK` with JSON status breakdown:
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
