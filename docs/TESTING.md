# Testing — Irja Payments Gateway

## Test Strategy

- **Framework:** Vitest + `@cloudflare/vitest-pool-workers` (see `package.json` lock for exact version).
- **Environment:** Miniflare-backed Worker runtime with real D1 + KV bindings; secrets via test config / `.dev.vars` placeholders stripped in agent-safe runs.
- **Pattern:** `vi.mock()` for Verifone/Landsbankinn clients + `SELF.fetch()` for full HTTP path. Do not rely on `fetchMock` for outbound interception on this pool version.
- **Quality Gates:** `npm run test:quality-gates` — security regression, financial integrity, proxy-detection discipline.
- **Green means:** `npm test` + `npm run typecheck` + `npm run lint` (+ `npm run quality:check` for local release board). Production still gated by `DEPLOYMENT_GATE.md` externals.

---

## Safety Net Map

| Module | Pinned behaviors | Test files | Gaps |
| --- | --- | --- | --- |
| `src/routes/checkout.ts` | Body limit, reject client money fields, catalog resolve, idempotency key claim, order + access token issue | `test/checkout.test.ts`, `test/price-manipulation.test.ts` | High-concurrency claim races |
| `src/routes/return.ts` | S2S checkout verify, amount/currency match, non-regressing status | `test/return.test.ts` | Provider session-expiry windows |
| `src/routes/webhook.ts` | JWS verify, entity match, idempotent event id, paid/fail/refund paths | `test/webhook.test.ts` | JWKS rotation; true multi-isolate duplicate delivery |
| `src/routes/order.ts` | Bearer capability token, no sensitive fields | `test/order.test.ts` | Per-token rate limit (if productized) |
| `src/cron/reconcile.ts` | Match approved acquirer txns; refuse amount/status mismatch; failed run cursor | `test/reconcile.test.ts` | Large pagination / multi-day catch-up |
| `src/lib/catalog.ts` | Server-side unit prices, active products only | `test/price-manipulation.test.ts`, financial gates | Catalog admin/update path N/A today |
| `src/lib/crypto.ts` | Detached JWS verify path used by webhooks | `test/crypto.test.ts` | Non-ES algorithms if vendor ever changes |
| `src/lib/jwks.ts` | Fetch + KV cache by kid | `test/jwks.test.ts` | Stale kid after rotation without cache bust |
| `src/lib/verifone.ts` | Token + create/read checkout parsing | `test/verifone.test.ts` | OAuth refresh under network error; **no fetch timeout pin yet** |
| `src/lib/landsbankinn.ts` | Token + settlements/transactions read | `test/landsbankinn.test.ts` | Error body edge cases; **no fetch timeout pin yet** |
| `src/lib/rate-limit.ts` | Checkout limiter binding gate | `test/rate-limit.test.ts` | Missing binding behavior in every env |
| `src/lib/payment-integrity.ts` | Amount/currency integrity codes | `test/quality-gates/financial-integrity.test.ts` | Partial capture / multi-currency if ever added |
| `src/lib/db.ts` | Order/token/idempotency helpers, event log | Exercised via route/reconcile tests | Few direct unit tests |
| `src/lib/http.ts` | Body size reader helpers | Via checkout tests | Standalone unit coverage thin |
| `src/index.ts` | Router mount, shallow `/health`, `onError` | Indirect via `SELF` | Deep health not implemented |

Gaps column entries are **not** pinned — Phase 1 GATE remains open until prioritized characterization items land.

---

## Characterization Backlog

- [ ] `verifone.ts`: expired/missing KV token + upstream OAuth/checkout failure modes
- [ ] `reconcile.ts`: pagination / multi-day cursor beyond current four cases
- [ ] `webhook.ts`: duplicate `verifone_event_id` under parallel delivery (best-effort in Workers test pool)
- [ ] Outbound `fetch` timeout/abort behavior once Phase 7 implements timeouts (pin then)

---

## CI Gates

```bash
npm test
npm run typecheck
npm run lint
npm run test:quality-gates
npm run quality:check   # local release board; still not prod approval
```
