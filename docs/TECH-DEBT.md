# Technical Debt — Irja Payments Gateway

## Debt Ledger

| Item                                      | Location                                            | Type             | Risk   | Effort | Priority | Status              |
| ----------------------------------------- | --------------------------------------------------- | ---------------- | ------ | ------ | -------- | ------------------- |
| Duplicated payment verification logic     | `src/routes/return.ts`, `src/routes/webhook.ts`     | Code Duplication | Medium | Low    | High     | Planned (Phase 3)   |
| Direct D1 calls in route handlers         | `src/routes/checkout.ts`, `return.ts`, `webhook.ts` | Architecture     | Medium | Medium | High     | Planned (Phase 4/5) |
| String literal error codes                | `src/lib/payment-integrity.ts`, routes              | Maintainability  | Low    | Low    | Medium   | Planned (Phase 2)   |
| Lack of circuit breaker for external APIs | `src/lib/verifone.ts`, `src/lib/landsbankinn.ts`    | Resilience       | High   | Medium | High     | Planned (Phase 7)   |
| Static `/health` endpoint                 | `src/index.ts`                                      | Operational      | Low    | Low    | Medium   | Planned (Phase 7)   |

---

## Smell Inventory

| Smell                                            | Location                                        | Refactoring                                        | Status |
| ------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------- | ------ |
| Multi-argument methods (`createCheckoutSession`) | `src/lib/verifone.ts`                           | Introduce Parameter Object                         | Open   |
| Long sequential route handlers                   | `src/routes/webhook.ts`                         | Extract Method / Guard Clauses                     | Open   |
| Duplicated S2S checkout verification             | `src/routes/return.ts`, `src/routes/webhook.ts` | Extract Service (`verifyAndProcessPaymentOutcome`) | Open   |
| Direct raw D1 `batch` construction in handlers   | `src/routes/return.ts`, `webhook.ts`            | Encapsulate in `OrderStateEngine`                  | Open   |

---

## Sprout / Wrap Register

- None currently registered.

---

## Debt Budget & Broken-Windows Policy

- **Debt Budget:** Up to 15% of development time allocated to technical debt remediation per release iteration.
- **Broken-Windows Policy:**
  1. Any newly discovered bug or hack must be either fixed immediately or logged in the Debt Ledger with priority and owner.
  2. Untracked `TODO` or `FIXME` comments are prohibited in `src/`.
  3. No PR or commit shall introduce new raw string error codes without updating standard domain error types.

---

## Adopted Conventions

- **Monetary Values:** Integer minor units only (aurar for ISK). No floating-point arithmetic.
- **Error Types:** Throw structured domain errors extending `DomainError` with explicit error codes.
- **State Transitions:** D1 order status updates must specify expected current state in `WHERE` clauses to prevent status regression.
- **Secrets:** Isolated in Cloudflare Secrets Store. Never logged or committed.
