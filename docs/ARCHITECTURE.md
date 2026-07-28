# Architecture — Irja Payments Gateway

## System Context

- **Storefront:** Irja (`irja.is` staged at `irja.khalipa.net`)
- **Runtime:** Cloudflare Workers (TypeScript ESM, `nodejs_compat`)
- **Data:** D1 `irja-payments`; KV `irja-payments-cache`
- **Card capture:** Verifone HPP only (SAQ A — no PAN/CVV on this host)
- **Acquirer reconcile:** Landsbankinn Acquiring API (read-only settlements/transactions)

```
Storefront → Worker /api/checkout → Verifone HPP → Worker /api/return
                ↓                                      ↓
              D1 orders                    Worker /api/webhooks/verifone
                                                      ↓
                                         D1 orders + payment_events

Cron → Worker scheduled → Landsbankinn → D1 settlements + order settled
```

**Load reality (intake):** pre-production / sandbox-first. Do not invent scale-out topology until irja.is traffic exists. See Phase 8 deferred in the quality plan.

---

## Layer Map & Dependency Rule

**Intent** (target shape, not fully enforced today):

```
Frameworks (Hono, Workers, D1, KV)
  └─ Adapters (routes, verifone/landsbankinn clients)
       └─ Application services (checkout/return/webhook/reconcile orchestration)
            └─ Domain rules (catalog pricing, payment integrity, status legality, JWS verify)
```

### Current coupling notes

| Observation | Location | Direction | Status |
| --- | --- | --- | --- |
| Routes orchestrate DB helpers + vendor clients | `src/routes/*` | Outer knows inner details | Acceptable at current size; extract if tests/vendors force it |
| Domain-ish rules already partially extracted | `catalog.ts`, `payment-integrity.ts`, `crypto.ts` | Good inward dependency | Keep |
| Full ports/use-cases tree | n/a | Would add surface area | **Deferred** until second adapter or test pain |

Avoid a distributed-monolith mindset: one Worker service is fine; apply boundaries **inside** it only where they pay for themselves.

---

## Data & Storage Decisions

- **PCI:** SAQ A — no card data columns or logs.
- **IDs:** UUID v4 strings.
- **Money:** non-negative integers, single currency per checkout (ISK).
- **Concurrency:** D1 `batch` + status predicates; return and webhook must both be idempotent.
- **Migrations:** `migrations/0001`–`0006` sequential; remote apply is Tier 3 (human approval).
- **Isolation:** treat D1 as SQLite semantics; do not assume serializable without checking actual batch behavior for each transition path (Phase 9 work).

---

## Decision Log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-07-28 | Server-side catalog pricing | Kill client price manipulation |
| 2026-07-28 | Detached JWS webhooks + JWKS in KV | Vendor-signed events only |
| 2026-07-28 | `processed_webhooks` idempotency | Duplicate delivery → 200 no-op |
| 2026-07-28 | Defer full clean-architecture extract | Small codebase; sandbox E2E and Phase 7 resilience first |
| 2026-07-28 | Docs quality journey separate from feature PR | Reviewable plan without mixing runtime delta |
