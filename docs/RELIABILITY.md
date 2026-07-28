# Reliability — Irja Payments Gateway

## Integration-Point Audit

Values marked **unimplemented** are targets from the quality plan, not live code behavior. Verify in `src/lib/*.ts` before treating as ops truth.

| Dependency | Timeout today | Circuit breaker | Isolation | Retry today | Status |
| --- | --- | --- | --- | --- | --- |
| Verifone Checkout API | **None** (`fetch` bare) | None | Worker isolate | None explicit | **Gap — Phase 7** |
| Verifone OAuth | **None** | None | KV token cache | None explicit | **Gap — Phase 7** |
| Verifone JWKS | **None** | N/A | KV cache | Falls back only if coded path allows cached key | Partial (cache); timeout gap |
| Landsbankinn Acquiring API | **None** | None | Cron handler | None explicit | **Gap — Phase 7** |
| D1 | Platform | Platform | Binding | Platform | Rely on CF |
| KV | Platform | Platform | Binding | Platform | Rely on CF |

### Target policy (Phase 7 — not implemented)

| Dependency | Timeout target | Retry target | Notes |
| --- | --- | --- | --- |
| Verifone OAuth / GET checkout | ~3–5s abort | Bounded + jitter on safe GETs | Do not infinite-retry |
| Verifone POST checkout | ~5–10s abort | Prefer client Idempotency-Key; avoid duplicate session create | Align with checkout attempt rows |
| Landsbankinn GETs | ~10–15s abort | Bounded + jitter | Cron can lengthen deadline carefully |
| JWKS GET | ~3–5s abort | Use KV cache on failure when unexpired entry exists | Rotation must still be testable |

---

## Query & Resource Findings

- Checkout path is request-scoped; no unbounded list APIs on the public surface.
- Reconcile must not load unbounded settlement pages without a cursor/limit strategy (characterization backlog).
- Rate limit: checkout uses CF rate-limit binding when configured; missing binding must fail closed in non-dev (see `rate-limit` tests/docs).

---

## Health Checks & Metrics

### Current

- `GET /health` — shallow OK (see `src/index.ts`).

### Target deep check (`/health?deep=1`) — planned

1. D1 `SELECT 1`
2. KV put/get or get known probe key
3. JSON breakdown without secrets or binding names that aid attackers more than operators need

### Logging

- Prefer structured JSON with `order_id` / `event_id` / `run_id` / `environment`.
- Never log access tokens, raw Idempotency-Key secrets beyond hashed forms already stored, or card data (N/A by design).

### Metrics / alerts (when ops wiring exists)

- Symptom-based: checkout 5xx rate, webhook verify fail rate, reconcile failed runs, upstream timeout count — not vanity averages alone.

---

## Deploy vs Release

- Local board: `npm run quality:check` (lint, types, format, tests, audit, dry-run build).
- Production remains **BLOCKED** by externals in `DEPLOYMENT_GATE.md` even when local is green.
- Deploy/migrate scripts fail closed without `CONFIRM_PRODUCTION_*` and real resource IDs.
- Decouple “Worker version live” from “storefront points at Verifone contract” — storefront cutover is a separate external gate.
