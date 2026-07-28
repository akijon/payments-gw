# Technical Debt — Irja Payments Gateway

## Debt Ledger

| Item | Location | Type | Risk | Effort | Priority | Status |
| --- | --- | --- | --- | --- | --- | --- |
| No connect/read timeout on outbound `fetch` | `src/lib/verifone.ts`, `landsbankinn.ts`, `jwks.ts` | Resilience | High | Low–Med | **P0** | Open (Phase 7) |
| Duplicated payment outcome apply path | `src/routes/return.ts`, `src/routes/webhook.ts` | Duplication | Med | Low | P1 | Open (Phase 3) |
| Thin direct coverage of `db.ts` helpers | `src/lib/db.ts` | Test gap | Med | Med | P2 | Open (Phase 1 backlog) |
| Stringly error codes at API boundary | routes + integrity helpers | Maintainability | Low | Low | P2 | Open (Phase 2) |
| Shallow `/health` only | `src/index.ts` | Operational | Low | Low | P2 | Open (Phase 7) |
| Full use-case / port extraction | routes ↔ libs | Architecture | Low today | High | P3 | Deferred (post–sandbox E2E) |

---

## Smell Inventory

| Smell | Location | Refactoring | Status |
| --- | --- | --- | --- |
| Parallel S2S verify + status apply | `return.ts`, `webhook.ts` | Extract shared outcome service | Open |
| Long webhook preamble | `webhook.ts` | Guard clauses + extract verify steps | Open |
| Multi-arg client helpers (if call sites hurt) | `verifone.ts` | Parameter object | Open / optional |
| Route handlers own too much orchestration | routes | Extract after pins; avoid CA rewrite for its own sake | Deferred |

---

## Sprout / Wrap Register

- None. Prefer extend-in-place with tests over permanent sprouts on this small codebase.

---

## Debt Budget & Broken-Windows Policy

- **Budget:** ~15% of an iteration on debt when not in a payment-path incident.
- **Policy:**
  1. New hacks: fix now or ledger with priority — no silent `// TODO`.
  2. No untracked `TODO`/`FIXME` in `src/`.
  3. Public API error `code` values are part of the storefront contract — change via explicit constants/types, not drive-by renames.
  4. Structure refactors and behavior changes never share a commit.

---

## Adopted Conventions

- **Money:** integer minor units only (aurar for ISK). No floats.
- **Pricing authority:** catalog/DB only; reject client amounts.
- **Verify don't trust:** return + webhook must S2S-verify before paid/failed transitions.
- **Status transitions:** prefer `UPDATE … WHERE id = ? AND status IN (…)` (or equivalent batch) so states do not regress.
- **Secrets:** Wrangler secrets / gitignored `.dev.vars` only; never log tokens or capability secrets.
- **Errors (target, not fully implemented):** structured errors with stable `code` + safe client message; `DomainError`-style base is planned in Phase 2, not present yet.
