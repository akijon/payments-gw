# Reliability — Irja Payments Gateway

## Integration-Point Audit

Verified against source (`src/lib/verifone.ts`, `landsbankinn.ts`, `jwks.ts`).

| Dependency                 | Timeout (code)                  | Circuit breaker | Isolation                                          | Retry (code)                        | Status                                   |
| -------------------------- | ------------------------------- | --------------- | -------------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| Verifone Checkout API      | **15s** (`AbortSignal.timeout`) | None            | Worker isolate                                     | None explicit                       | Timeout ✓; breaker/retry — Phase 7       |
| Verifone OAuth             | **15s** (`AbortSignal.timeout`) | None            | KV token cache (30s buffer)                        | None explicit                       | Timeout ✓; breaker/retry — Phase 7       |
| Verifone JWKS              | **5s** (`AbortSignal.timeout`)  | N/A             | KV + memory cache (1h TTL); refresh on missing kid | Falls back to KV on refresh failure | Timeout ✓; no retry needed (cache-first) |
| Landsbankinn Acquiring API | **10s** (`AbortSignal.timeout`) | None            | Cron handler (isolated)                            | None explicit                       | Timeout ✓; breaker/retry — Phase 7       |
| Verifone JWKS response     | Capped at **256KB**             | —               | —                                                  | —                                   | ✓                                        |
| Landsbankinn response      | Capped at **1MB**               | —               | —                                                  | —                                   | ✓                                        |
| D1                         | Platform                        | Platform        | Binding                                            | Platform                            | Rely on CF                               |
| KV                         | Platform                        | Platform        | Binding                                            | Platform                            | Rely on CF                               |

### What remains for Phase 7

| Item                        | Current                                                 | Target                                                                                     |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Circuit breaker             | None                                                    | Lightweight KV-backed or in-isolate breaker for Verifone/Landsbankinn failure cascades     |
| Retry with backoff + jitter | None                                                    | Bounded retry on idempotent GETs (checkout read, settlements) only; never blind POST retry |
| Deep health check           | Shallow only (`/health` → 200)                          | `/health?deep=1` → D1 `SELECT 1` + KV probe, JSON breakdown                                |
| Correlation IDs             | Partial (`order_id`, `event_id`, `run_id` in some logs) | Standardize across all structured logs                                                     |

---

## Query & Resource Findings

- Checkout path is request-scoped; no unbounded list APIs on the public surface.
- **Missing index:** `reconcile.ts` queries `WHERE order_number = ?` but `migrations/` has no index on `orders(order_number)`. Full table scan per settlement transaction. (Fix: add `CREATE INDEX idx_orders_order_number ON orders(order_number)` in a new migration.)
- Reconcile must not load unbounded settlement pages without a cursor/limit strategy (characterization backlog).
- Rate limit: checkout uses CF rate-limit binding when configured; missing binding fails closed in production (see `src/lib/rate-limit.ts`).

---

## Health Checks & Metrics

### Current

- `GET /health` — shallow OK (see `src/index.ts`).

### Target deep check (`/health?deep=1`) — planned

1. D1 `SELECT 1`
2. KV put/get or get known probe key
3. JSON breakdown without secrets or binding names that aid attackers more than operators need

### Logging

- Structured JSON with `order_id` / `event_id` / `run_id` / `environment` (partially implemented).
- Never log access tokens, raw Idempotency-Key secrets beyond hashed forms, or card data (N/A by design).

### Metrics / alerts (when ops wiring exists)

- Symptom-based: checkout 5xx rate, webhook verify fail rate, reconcile failed runs, upstream timeout count — not vanity averages alone.

---

## Deploy vs Release

- Local board: `npm run quality:check` (lint, types, format, tests, audit, dry-run build).
- Production remains **BLOCKED** by externals in `DEPLOYMENT_GATE.md` even when local is green.
- Deploy/migrate scripts fail closed without `CONFIRM_PRODUCTION_*` and real resource IDs.
- Decouple "Worker version live" from "storefront points at Verifone contract" — storefront cutover is a separate external gate.
