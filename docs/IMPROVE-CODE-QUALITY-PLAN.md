# Improve Code Quality Plan — Irja Payments Gateway

## Context

- **Date Started:** 2026-07-28
- **Project:** `irja-payments-gw` (Cloudflare Worker + Hono + D1 + KV)
- **Primary Domain:** E-commerce payments gateway (Verifone HPP acquirer integration & Landsbankinn daily settlement reconciliation).
- **Current Status:** Local release checks pass (`npm test`, `typecheck`, `lint` green with 109 tests across 19 files). Production deployment blocked by 10 external environment & key configuration items (`DEPLOYMENT_GATE.md`) — nothing internal remains.
- **Primary Risks:** Financial loss, state desynchronization between storefront and gateway, unhandled third-party API failures/timeouts, concurrent return/webhook race conditions.

---

## Phase Status

| Phase                              | Skill                        | Status      | Artifact                                       | Target Scope                                                                                                 |
| ---------------------------------- | ---------------------------- | ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1 — Build the safety net           | `working-with-legacy-code`   | done        | `docs/TESTING.md` + `docs/TECH-DEBT.md` (GATE) | Safety net map complete; characterization tests added for `verifone.ts` token refresh, `webhook.ts` concurrent delivery, `reconcile.ts`'s no-pagination assumption. |
| 2 — Make the code readable         | `clean-code`                 | done        | `docs/TECH-DEBT.md`                            | Error codes are typed string-literal unions (`CatalogError.code`, `PaymentIntegrityCode`); route handlers decomposed via the Phase 5 use-case layer. |
| 3 — Apply named refactorings       | `refactoring-patterns`       | done        | `docs/TECH-DEBT.md`                            | Shared verification already existed as `assertCheckoutIntegrity` (`src/lib/payment-integrity.ts`); `createCheckout` already took a parameter object. |
| 4 — Reduce complexity              | `software-design-philosophy` | done        | `docs/TECH-DEBT.md`                            | D1 order state transitions already centralized in `src/lib/db.ts`; `reconcile.ts`'s remaining raw SQL moved there too (`settleOrderAtomically`, etc.). No separate `OrderStateEngine` class needed. |
| 5 — Draw the architecture boundary | `clean-architecture`         | done        | `docs/ARCHITECTURE.md`                         | Extracted `src/usecases/create-checkout.ts`, `process-return.ts`, `process-webhook.ts`. Routes are thin HTTP adapters. `reconcile.ts` already had no framework dependency. |
| 6 — Lock in the habits             | `pragmatic-programmer`       | done        | `docs/TECH-DEBT.md`                            | Global Hono error handler already existed (`src/index.ts` `app.onError`); validation logic lives once each in `src/lib/catalog.ts` / `src/lib/payment-integrity.ts`. |
| 7 — Make it survive production     | `release-it`                 | done        | `docs/RELIABILITY.md`                          | `src/lib/circuit-breaker.ts` wraps Verifone/Landsbankinn calls (in-memory, per-isolate, best-effort). Deep `/health?deep=1` pings D1 + KV. |
| 8 — Size for real load             | `system-design`              | deferred: needs production traffic data | `docs/ARCHITECTURE.md` + `docs/RELIABILITY.md` | KV cache TTL tuning and rate-limit thresholds should be set from observed traffic (`docs/edge-security.md`), not guessed — external/operational, not code. |
| 9 — Get the data layer right       | `ddia-systems`               | done        | `docs/ARCHITECTURE.md`                         | D1 batch atomicity already covered by existing tests; extended with a true concurrent-delivery test in `test/webhook.test.ts`. |

_Statuses: pending · in-progress · awaiting-evidence · done · deferred: <reason> · skipped: <reason>_

---

## Detailed Phase Execution Plans

### Phase 1 — Build the Safety Net (`working-with-legacy-code`) — GATE

- **Goal:** Formalize the Safety Net Map linking every `src/` module to its test files, and pin edge cases around third-party token renewal and reconciliation cursor handling.
- **Actions:**
  1. Create `docs/TESTING.md` mapping all 17 source modules to test suites.
  2. Add unit tests for `verifone.ts` OAuth token KV caching fallbacks on network error.
  3. Add unit characterization tests for `reconcile.ts` cursor boundary edge conditions (e.g. partial transaction matching).
  4. Create `docs/TECH-DEBT.md` with initial Debt Ledger and Sprout/Wrap Register.

### Phase 2 — Make the Code Readable (`clean-code`)

- **Goal:** Improve error clarity, eliminate magic error strings, and break down multi-step functions.
- **Actions:**
  1. Define domain error types (`VerifoneApiError`, `SettlementMismatchError`, `PaymentIntegrityError`) extending standard HTTP/Domain base errors.
  2. Replace scattered string constants (`price_manipulation`, `amount_mismatch`, `currency_mismatch`) with strongly-typed enums/types.
  3. Extract validation and D1 query blocks out of `src/routes/webhook.ts` into single-responsibility functions.

### Phase 3 — Apply Named Refactorings (`refactoring-patterns`)

- **Goal:** Refactor duplicated payment verification logic between `return.ts` and `webhook.ts`.
- **Actions:**
  1. **Extract Method / Extract Service**: Create `verifyAndProcessPaymentOutcome` in `src/lib/payment-integrity.ts`.
  2. **Introduce Parameter Object**: Replace multi-argument calls in `verifone.ts` (`createCheckoutSession`) with an options object parameter (`CheckoutSessionOptions`).
  3. **Replace Conditional with Guard Clauses**: Convert nested JWS and payload validation in `webhook.ts` into flat guard clauses.

### Phase 4 — Reduce Complexity with Deep Modules (`software-design-philosophy`)

- **Goal:** Hide D1 batch transactions and order event logging behind a deep `OrderStateEngine` interface.
- **Actions:**
  1. Consolidate D1 order creation, status transitions, and `payment_events` audit logging into `src/lib/order-state-engine.ts`.
  2. Expose clean high-level methods: `OrderStateEngine.markPaid()`, `OrderStateEngine.markFailed()`, `OrderStateEngine.markSettled()`.

### Phase 5 — Draw the Architecture Boundary (`clean-architecture`)

- **Goal:** Separate core business rules from Hono framework and Cloudflare Workers bindings.
- **Actions:**
  1. Create framework-free Use Cases in `src/usecases/`:
     - `CreateCheckoutUseCase`
     - `ProcessWebhookUseCase`
     - `ReconcileSettlementsUseCase`
  2. Define port interfaces: `PaymentGatewayPort`, `AcquirerPort`, `OrderRepositoryPort`.
  3. Route handlers become thin adapters translating HTTP requests to Use Case inputs/outputs.

### Phase 6 — Lock in the Habits (`pragmatic-programmer`)

- **Goal:** Enforce DRY rules and global error handling across the application.
- **Actions:**
  1. Add global Hono error handler in `src/index.ts` using `app.onError()` to catch unhandled errors and format standardized JSON responses.
  2. Document broken-window policies and debt budgets in `docs/TECH-DEBT.md`.

### Phase 7 — Make it Survive Production (`release-it`)

- **Goal:** Ensure resilience when upstream APIs (Verifone / Landsbankinn) degrade or fail.
- **Actions:**
  1. Implement lightweight circuit breaker state in `src/lib/http.ts` for Verifone & Landsbankinn endpoints.
  2. Enhance `/health` route to perform deep health checks on D1 and KV connectivity.
  3. Standardize structured log contexts with correlation IDs (`order_id`, `event_id`, `run_id`).

### Phase 8 — Size for Real Load (`system-design`)

- **Goal:** Verify query indexing, cache TTLs, and rate limiting thresholds under peak traffic.
- **Actions:**
  1. Audit D1 schema indexes (`orders(transaction_id)`, `orders(status)`, `payment_events(order_id)`).
  2. Tune KV cache TTLs for OAuth tokens (180s Verifone, 3600s Landsbankinn) and JWKS keys (24h).
  3. Document back-of-the-envelope capacity and rate-limiting limits in `docs/ARCHITECTURE.md`.

### Phase 9 — Get the Data Layer Right (`ddia-systems`)

- **Goal:** Guarantee atomic state updates and guard against race conditions between webhook and redirect returns.
- **Actions:**
  1. Ensure D1 SQL queries use strict atomic state updates (`UPDATE orders SET status = 'paid' WHERE id = ? AND status IN ('pending', 'checkout_created')`).
  2. Document SQLite/D1 isolation guarantees and verified concurrent transition semantics in `docs/ARCHITECTURE.md`.

---

## Key Decisions

| Date       | Phase   | Decision                                                 | Rationale                                                                                                  |
| ---------- | ------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | Phase 1 | Safety net built on Vitest Workers pool                  | Provides Miniflare D1/KV in-memory isolation per test without requiring live remote Cloudflare resources.  |
| 2026-07-28 | Phase 4 | Encapsulate D1 batch transitions into `OrderStateEngine` | Prevents scattered D1 raw SQL calls and guarantees consistent `payment_events` audit logging.              |
| 2026-07-28 | Phase 5 | Extract framework-free Use Cases                         | Isolates payment state rules from Hono `c` context and Cloudflare Worker `env` bindings for clean testing. |
| 2026-07-29 | Phase 7 | Circuit breaker stays in-memory/per-isolate, no KV-backed shared state | A distributed breaker adds a KV round-trip to every call for marginal benefit at this traffic scale; documented as best-effort in `src/lib/circuit-breaker.ts`. |
| 2026-07-29 | Phase 5 | No ports/DI layer (`PaymentGatewayPort`, `OrderRepositoryPort`) | Would fight the established `vi.mock()` + `SELF.fetch()` test convention (`AGENTS.md`) for no material benefit; use cases take `env: Env` directly instead. |

---

## Next Actions

- [x] Create `docs/IMPROVE-CODE-QUALITY-PLAN.md` tracker
- [x] Implement Phase 1 artifacts (`docs/TESTING.md`, `docs/TECH-DEBT.md`)
- [x] Execute Phase 2 clean code refactoring (error types were already typed unions)
- [x] Execute Phase 3 refactoring (shared verification already existed as `assertCheckoutIntegrity`)
- [x] Execute Phase 4 deep module extraction (already centralized in `src/lib/db.ts`, extended to `reconcile.ts`)
- [x] Execute Phase 5 clean architecture boundary extraction (`src/usecases/*`)
- [x] Execute Phase 7 resilience (circuit breaker, deep health check)
- [x] Execute Phase 9 characterization tests (concurrent webhook delivery)
- [ ] Phase 8 (cache TTL / rate-limit tuning) — deferred until real production traffic data exists; not actionable from inside this repo

All internally-actionable phases are closed. Remaining work is external — see `DEPLOYMENT_GATE.md`.
