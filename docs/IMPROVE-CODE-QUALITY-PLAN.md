# Improve Code Quality Plan — Irja Payments Gateway

## Context

- **Date Started:** 2026-07-28
- **Project:** `irja-payments-gw` (Cloudflare Worker + Hono + D1 + KV)
- **Primary Domain:** E-commerce payments gateway (Verifone HPP acquirer integration & Landsbankinn daily settlement reconciliation).
- **Current Status:** Local release checks pass (`npm test`, `typecheck`, `lint` green with 90 tests across 16 files). Production deployment blocked by 10 external environment & key configuration items (`DEPLOYMENT_GATE.md`).
- **Primary Risks:** Financial loss, state desynchronization between storefront and gateway, unhandled third-party API failures/timeouts, concurrent return/webhook race conditions.
- **Constraint:** Prefer small, test-gated structure commits. Defer heavy clean-architecture extraction until after sandbox E2E and storefront Verifone cutover risk is reduced. Phase 7 (timeouts/breakers) ranks above Phases 4–5 for launch readiness.

---

## Phase Status

| Phase | Skill | Status | Artifact | Target Scope |
| --- | --- | --- | --- | --- |
| 1 — Build the safety net | `working-with-legacy-code` | awaiting-evidence | `docs/TESTING.md` + `docs/TECH-DEBT.md` (GATE) | Docs map done. Remaining: characterization tests for Verifone OAuth cache miss/outage and reconcile cursor edges. |
| 2 — Make the code readable | `clean-code` | pending | `docs/TECH-DEBT.md` | Typed domain errors, eliminate ad-hoc error-code strings where it helps callers, decompose largest route handlers. |
| 3 — Apply named refactorings | `refactoring-patterns` | pending | `docs/TECH-DEBT.md` | Extract shared payment-outcome processing used by return + webhook; parameter objects where call sites hurt. |
| 4 — Reduce complexity | `software-design-philosophy` | deferred: after sandbox E2E | `docs/TECH-DEBT.md` | Deeper order-transition module only if return/webhook/reconcile keep diverging. Avoid premature classitis. |
| 5 — Draw the architecture boundary | `clean-architecture` | deferred: after sandbox E2E | `docs/ARCHITECTURE.md` | Use-case ports only if framework coupling blocks testing or vendor swap. Current size does not justify full CA rewrite. |
| 6 — Lock in the habits | `pragmatic-programmer` | pending | `docs/TECH-DEBT.md` | Broken-windows policy already drafted. Audit remaining knowledge duplication; extend existing `app.onError` rather than reinvent. |
| 7 — Make it survive production | `release-it` | pending | `docs/RELIABILITY.md` | **Priority for launch:** connect/read timeouts on every outbound `fetch`, breaker/backoff policy, deep health check. |
| 8 — Size for real load | `system-design` | deferred: low traffic until irja.is live | `docs/ARCHITECTURE.md` + `docs/RELIABILITY.md` | Record QPS/storage assumptions; verify D1 indexes; tune only with numbers. |
| 9 — Get the data layer right | `ddia-systems` | pending | `docs/ARCHITECTURE.md` | Confirm optimistic status guards cover return↔webhook races; document D1 batch semantics. |

_Statuses: pending · in-progress · awaiting-evidence · done · deferred: \<reason\> · skipped: \<reason\>_

---

## Detailed Phase Execution Plans

### Phase 1 — Build the Safety Net (`working-with-legacy-code`) — GATE

- **Goal:** Pin change-point behavior so later phases are verifiable.
- **Done in this PR:** Safety Net Map + Debt Ledger docs.
- **Still open (evidence):**
  1. Characterization tests for Verifone OAuth when KV holds expired/missing token during upstream failure.
  2. Characterization tests for reconcile multi-day/cursor and unmatched-transaction paths beyond current suite.
  3. Optional: concurrent duplicate webhook delivery under two workers (may stay gap if hard in Miniflare).

### Phase 2 — Make the Code Readable (`clean-code`)

- **Goal:** Reader-optimized errors and smaller handlers without behavior change.
- **Actions:**
  1. Introduce a small domain error base (e.g. `DomainError` with `code` + HTTP status) — **not present today**.
  2. Prefer shared constants/types for public API error codes (`price_manipulation`, `amount_mismatch`, …).
  3. Extract validation blocks from the longest route handlers once Phase 1 characterization gaps for those modules are closed.

### Phase 3 — Apply Named Refactorings (`refactoring-patterns`)

- **Goal:** One payment-outcome path for return + webhook.
- **Actions:**
  1. **Extract Method/Service:** shared verify-and-apply outcome helper (likely extend `src/lib/payment-integrity.ts` + thin DB transition helpers).
  2. **Introduce Parameter Object** only where multi-arg call sites already hurt.
  3. **Replace Nested Conditional with Guard Clauses** in webhook verification preamble.
- **Rule:** structure-only commits; tests green between steps.

### Phase 4 — Reduce Complexity (`software-design-philosophy`) — deferred

- Revisit if order transition + `payment_events` logging stays copy-pasted after Phase 3.
- Prefer one deep module over a swarm of shallow classes on a ~17-file Worker.

### Phase 5 — Architecture Boundary (`clean-architecture`) — deferred

- Full `src/usecases/` + ports is optional at current scale.
- Keep Dependency Rule intent in `ARCHITECTURE.md`; extract ports when a second adapter appears (e.g. second acquirer) or unit tests cannot run without Hono/`Env`.

### Phase 6 — Habits (`pragmatic-programmer`)

- `app.onError` already exists in `src/index.ts` — extend, do not replace blindly.
- Keep debt budget + no untracked `TODO` policy in `TECH-DEBT.md`.
- DRY = shared **knowledge** (status machines, amount checks), not forced text dedupe.

### Phase 7 — Survive Production (`release-it`) — launch priority

- **Today:** outbound `fetch` in `verifone.ts` / `landsbankinn.ts` / `jwks.ts` has **no** `AbortSignal` timeouts (verified). Retry/breaker rows in `RELIABILITY.md` are targets, not implemented facts.
- **Actions:**
  1. Connect + read timeout on every outbound call.
  2. Explicit retry policy (bounded, jitter) only on idempotent GETs / token fetch — never blind POST retry for checkout create without idempotency alignment.
  3. Circuit-breaker or fail-fast budget appropriate for Workers (KV-backed or in-isolate with clear limits).
  4. Deep `/health?deep=1` (D1 + KV) without leaking internals.
  5. Correlation fields already partially present — standardize `order_id` / `event_id` / `run_id`.

### Phase 8 — Size for Real Load (`system-design`) — deferred

- Record assumed checkout QPS and retention; audit indexes; no cache fan-out until measured.

### Phase 9 — Data Layer (`ddia-systems`)

- Inventory every status transition `UPDATE … WHERE status IN (…)`.
- Document return vs webhook race: both must be idempotent and non-regressing.
- No new datastore without a sync story.

---

## Key Decisions

| Date | Phase | Decision | Rationale |
| --- | --- | --- | --- |
| 2026-07-28 | Intake | Docs-only PR separate from feature PR #2 | Review plan without bundling catalog/integrity runtime delta. |
| 2026-07-28 | Phase 1 | Vitest Workers pool is the safety net substrate | Miniflare D1/KV isolation; matches existing suite. |
| 2026-07-28 | Priority | Phase 7 before Phases 4–5 | Timeouts/breakers are launch table stakes; full CA rewrite is not. |
| 2026-07-28 | Phase 4/5 | Defer deep restructuring until after sandbox E2E | Aligns with Irja scope: sandbox-before-prod, avoid thrash on payment paths. |
| 2026-07-28 | Phase 6 | Extend existing `app.onError` | Handler already present; avoid duplicate global error paths. |

---

## Next Actions

- [x] Create tracker + Phase 1 **doc** artifacts (`TESTING.md`, `TECH-DEBT.md`, `ARCHITECTURE.md`, `RELIABILITY.md`)
- [ ] Close Phase 1 GATE: characterization tests listed above (owner: next coding session)
- [ ] Phase 7: outbound `fetch` timeouts + reliability audit truth table vs code
- [ ] Phase 2/3: domain errors + shared payment-outcome path (after Phase 1 pins)
- [ ] Revisit Phase 4/5 only if duplication remains post–Phase 3 or testing is blocked by Hono/`Env`
