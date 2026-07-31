# Architecture — Irja Payments Gateway

## System Context

- **Storefront:** Irja e-commerce storefront (`irja.is` / `irja.khalipa.net`)
- **Gateway Runtime:** Cloudflare Workers (TypeScript, ESM, `nodejs_compat`)
- **Database:** Cloudflare D1 (SQLite, database name `irja-payments`)
- **Cache:** Cloudflare KV (namespace `irja-payments-cache`)
- **Acquirer:** Landsbankinn ehf (Iceland)
- **Payment Gateway:** Verifone Hosted Payments Page (HPP) — handles card capture and 3DS/SCA

```
Storefront (Pages) → Worker /api/checkout → Verifone HPP → Worker /api/return
                     ↓                                          ↓
                     D1 (orders)                    Worker /api/webhooks/verifone
                                                   ↓
                                                   D1 (orders + payment_events)

Cron (06:00 UTC) → Worker /scheduled → Landsbankinn Acquiring API → D1 (settlements)
```

---

## Layer Map & Dependency Rule

```
┌─────────────────────────────────────────────────────────────┐
│ Frameworks & Drivers (Hono, Cloudflare Worker, D1 SDK, KV)  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Interface Adapters (Route Handlers, API Clients)      │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │ Use Cases (CreateCheckout, ProcessWebhook, etc.)│  │  │
│  │  │  ┌───────────────────────────────────────────┐ │  │  │
│  │  │  │ Entities & Core Domain Rules             │ │  │  │
│  │  │  │ (Order, Catalog, PaymentOutcome, JWS)    │ │  │  │
│  │  │  └───────────────────────────────────────────┘ │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Violations Addressed

| Violation                                              | Location                                            | Fix                                                                                                     | Status   |
| ------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| Direct D1 raw SQL execution in route handlers          | `src/routes/checkout.ts`, `return.ts`, `webhook.ts` | Extracted to framework-free use cases in `src/usecases/*`; all D1 access centralized in `src/lib/db.ts` | Resolved |
| Verifone HTTP API calls directly inside route handlers | `src/routes/return.ts`, `webhook.ts`                | Moved into `src/usecases/process-return.ts` / `process-webhook.ts`                                      | Resolved |

Full ports/DI (`PaymentGatewayPort`, `OrderRepositoryPort`) was considered and deliberately
not used: it would fight the established test convention (`vi.mock()` module mocking +
`SELF.fetch()`, see `AGENTS.md`) for no material benefit at this codebase's size. The use
cases still take `env: Env` directly, matching how `verifone.ts`/`landsbankinn.ts`/`db.ts`
already work — the substantive fix is that Hono route handlers no longer contain business
logic, not that every dependency is injected through an interface.

`src/cron/reconcile.ts` was not moved into `src/usecases/` — it already takes no Hono import
and only `env: Env`, so it already satisfied the framework-free property this refactor was
after. Moving it would have been a pure file rename with no substantive change.

---

## Data & Storage Decisions

- **PCI Scope:** SAQ A — zero PAN, CVV, or cardholder data stored or processed.
- **IDs:** UUID v4 primary keys for all entities (`orders`, `payment_events`, `processed_webhooks`, `settlements`).
- **Amounts:** Non-negative integers in minor units (aurar for ISK).
- **Concurrency & Isolation:** D1 SQLite transactions (`db.batch()`). Status updates use strict optimistic lock guards (`WHERE id = ? AND status IN (...)`).
- **Schema Migrations:** Managed sequentially via SQL migration files (`migrations/0001_init.sql` through `0006_reconciliation_runs.sql`).

---

## Decision Log

| Date       | Decision                         | Rationale                                                                                                                                                                                                                                    |
| ---------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | Server-side pricing catalog      | Storefront cannot supply price or amount; prices resolved authoritatively from D1 `products` table to eliminate price manipulation vulnerabilities.                                                                                          |
| 2026-07-28 | JWS Webhook Verification         | Verifone webhooks verified using RFC 7797 detached JWS signatures with JWKS key caching in KV.                                                                                                                                               |
| 2026-07-28 | Webhook Idempotency              | Deduplication via `processed_webhooks` table using `verifone_event_id` primary key.                                                                                                                                                          |
| 2026-07-29 | Thin use-case layer, no ports/DI | Closed the remaining internal engineering backlog (circuit breaker, deep health check, use-case extraction, reconciliation DB encapsulation) with dummy/local material only; every remaining blocker is external — see `DEPLOYMENT_GATE.md`. |
