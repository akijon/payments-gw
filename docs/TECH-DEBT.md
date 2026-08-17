# Technical Debt — Irja Payments Gateway

## Debt Ledger

| Item                                                   | Location                                            | Type             | Risk   | Effort | Priority | Status                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------- | ---------------- | ------ | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicated payment verification logic                  | `src/routes/return.ts`, `src/routes/webhook.ts`     | Code Duplication | Medium | Low    | High     | Resolved — shared `assertCheckoutIntegrity` (`src/lib/payment-integrity.ts`), called from `src/usecases/process-return.ts` and `src/usecases/process-webhook.ts`                                                                                      |
| Direct D1 calls in route handlers                      | `src/routes/checkout.ts`, `return.ts`, `webhook.ts` | Architecture     | Medium | Medium | High     | Resolved — routes are thin adapters over `src/usecases/*`; all D1 access lives in `src/lib/db.ts`                                                                                                                                                     |
| String literal error codes                             | `src/lib/payment-integrity.ts`, routes              | Maintainability  | Low    | Low    | Medium   | Resolved — `PaymentIntegrityCode` and `CatalogError.code` are typed string-literal unions, not ad hoc strings                                                                                                                                         |
| Lack of circuit breaker for external APIs              | `src/lib/verifone.ts`, `src/lib/landsbankinn.ts`    | Resilience       | High   | Medium | High     | Resolved — `src/lib/circuit-breaker.ts` wraps all outbound calls in both clients                                                                                                                                                                      |
| Static `/health` endpoint                              | `src/index.ts`                                      | Operational      | Low    | Low    | Medium   | Resolved — `/health?deep=1` pings D1 and KV, returns 503 on failure                                                                                                                                                                                   |
| Breaker trial is not single-flight                     | `src/lib/circuit-breaker.ts`                        | Resilience       | Low    | Low    | Low      | Open — `openedAt` stays set until the trial resolves, so every concurrent request in the isolate is admitted the moment the 30 s cooldown elapses, instead of one trial call. Per-isolate scope caps the blast radius; fix is an in-flight-trial flag |
| Duplicated OAuth2 client-credentials token fetch/cache | `src/lib/verifone.ts`, `src/lib/landsbankinn.ts`    | Code Duplication | Medium | Low    | Medium   | Resolved — shared `getOAuth2ClientCredentialsToken` (`src/lib/oauth.ts`), called from `getVerifoneToken` and `getLandsbankinnToken`; both now use Landsbankinn's stricter token/expiry/response-size bounds                                           |
| Verifone auth model mismatched provisioned credentials | `src/lib/verifone.ts`, Worker secrets               | Integration      | High   | Low    | Critical | Resolved — Verifone now uses the provisioned user UUID/API key via documented HTTP Basic authentication; the OAuth helper remains Landsbankinn-only                                                                                                   |

---

## Smell Inventory

| Smell                                            | Location                                                      | Refactoring                                        | Status                                                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-argument methods (`createCheckoutSession`) | `src/lib/verifone.ts`                                         | Introduce Parameter Object                         | Resolved — `createCheckout(env, params)` already takes a single options object                                                                                                                                       |
| Long sequential route handlers                   | `src/routes/webhook.ts`                                       | Extract Method / Guard Clauses                     | Resolved — logic moved to `src/usecases/process-webhook.ts`; route keeps only JWS/body handling                                                                                                                      |
| Duplicated S2S checkout verification             | `src/routes/return.ts`, `src/routes/webhook.ts`               | Extract Service (`verifyAndProcessPaymentOutcome`) | Resolved — `assertCheckoutIntegrity` in `src/lib/payment-integrity.ts` (equivalent extraction, different name)                                                                                                       |
| Direct raw D1 `batch` construction in handlers   | `src/routes/return.ts`, `webhook.ts`, `src/cron/reconcile.ts` | Encapsulate in `OrderStateEngine`                  | Resolved — atomic transitions live in `src/lib/db.ts` (`processReturnAtomically`, `processWebhookAtomically`, `settleOrderAtomically`, etc.); no separate class needed since D1 access was already centralized there |

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

- **Monetary Values:** Integer whole krónur (ISK major units) only. No floating-point arithmetic.
- **Error Types:** Throw structured domain errors extending `DomainError` with explicit error codes.
- **State Transitions:** D1 order status updates must specify expected current state in `WHERE` clauses to prevent status regression.
- **Secrets:** Isolated in Cloudflare Secrets Store. Never logged or committed.

---

## Status as of 2026-08-01

One low-priority item is open: the non-single-flight circuit-breaker trial. Every
other item above is closed. The rest of the backlog for this project is entirely
external — see `DEPLOYMENT_GATE.md` for the non-negotiable blockers (real
Verifone/Landsbankinn credentials, production Cloudflare resources, storefront
contract migration, `PUBLIC_API_URL` return-path routing, vendor-signed sandbox
proof). None of it can be closed from inside this repository.

## Status as of 2026-08-07

A production-readiness review ahead of the `irja-storefront-2026` integration
surfaced one internal item the prior passes missed: duplicated OAuth2
client-credentials logic between the Verifone and Landsbankinn clients. Closed
same-day (see ledger above). External blockers in `DEPLOYMENT_GATE.md` are
unchanged by this fix.
