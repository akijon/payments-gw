# Agent prompt — Verifone sandbox E2E + storefront integration

Repos: `akijon/irja-storefront-2026` (storefront, Cloudflare Pages/Workers) and
`akijon/payments-gw` (payments gateway, Cloudflare Worker + D1). Treat
`payments-gw/AGENTS.md` + `payments-gw/CLAUDE.md` and
`irja-storefront-2026/AGENTS.md` + `irja-storefront-2026/CLAUDE.md` as binding for
every session in their respective repo — obey their trust tiers exactly, do not
override them.

## Objective

Get the Verifone sandbox payment flow (checkout → HPP → return → webhook →
reconciliation) to a state where `payments-gw/SANDBOX_E2E_GATE.md` can be
honestly marked complete, and confirm the storefront's checkout client
(`app/lib/payments-gw/client.ts`) satisfies the contract in
`payments-gw/STOREFRONT_INTEGRATION.md`. Do not mark the gate complete by
assertion — every checklist item requires captured evidence (redacted
IDs/timestamps) or it stays unchecked.

## Trust boundary — read this before doing anything

Both repos define the same three tiers. Respect them without exception:

- **T1/T2 (autonomous):** tests, lint, typecheck, reads, local code/test
  changes, local commits, docs, running `scripts/probe-verifone-idempotency.sh`
  once a human has sourced sandbox credentials into your shell (the script
  itself refuses to run under the agent-safe-env wrapper — that's
  intentional, leave it).
- **T3 (hard stop — draft only, then halt for explicit human approval):**
  applying D1 migrations remotely, `wrangler deploy` / `wrangler.toml` or
  `wrangler.jsonc` changes, anything under `migrations/`, `src/lib/crypto.ts`,
  provisioning or rotating real Verifone/Landsbankinn/Cloudflare secrets,
  configuring the sandbox webhook URL in the Verifone dashboard, and any
  action that submits a real card transaction against a live vendor sandbox
  tenant.

You will not have real sandbox credentials in your environment by default —
`with-agent-safe-env.sh` strips them deliberately. Where a checklist item
needs them, do the preparation work (code, config plumbing, test scaffolding,
scripts, docs) up to the point that requires the secret, then stop and hand
back a precise list of what a human needs to run or supply, referencing exact
commands/files. Never ask for the secret values themselves, and never invent
or hardcode placeholder-that-looks-real credentials.

## Work items

### 1. `payments-gw` — sandbox readiness (`SANDBOX_E2E_GATE.md`)

Work the preconditions and evidence list in order:

1. Confirm all nine Worker secrets required for sandbox are enumerated in
   `src/types/env.ts` and documented in `.dev.vars.example`; flag any drift.
2. Verify migrations through `0016_customer_billing.sql` apply cleanly to a
   fresh local D1 via `npm run db:migrate:local`. **Already fixed:**
   `SANDBOX_E2E_GATE.md` and `DEPLOYMENT_GATE.md` previously pinned the
   precondition to "migrations through `0008_payment_method.sql`" / `0001`–`0008`,
   eight newer migrations behind (`0009`–`0016`). Both docs now say `0016`. This
   was not just stale prose: `0014_shipping_cost.sql` adds
   `orders.shipping_incl_vat`, `0015_terms_acceptance.sql` adds
   `orders.terms_accepted_at`/`terms_version`, and `0016_customer_billing.sql`
   adds the billing identity and Verifone Customer ID required by HPP 3DS.
   A sandbox D1 built by literally following the old precondition would break
   checkout and invoicing immediately.
   Re-verify this reference stays current as new migrations land.
3. Do not touch the seeded `products` fixtures as if they were the real
   merchant catalog — the gate doc is explicit that no real catalog was
   supplied. Flag this as an open blocker rather than inventing one.
4. Resolve the open vendor question in `SANDBOX_E2E_GATE.md` (Verifone
   `x-vfi-api-idempotencykey` behavior on `POST /v2/checkout`): once a human
   has sourced sandbox credentials, run
   `scripts/probe-verifone-idempotency.sh` and its `--replay` mode, capture
   redacted output, and update `docs/RELIABILITY.md` / the gate doc with the
   answer. If credentials aren't available to you, prepare the exact command
   and prerequisites and stop there.
5. For each of the 7 required-evidence scenarios in the gate doc (checkout
   creation, browser-return verification, webhook → `paid` exactly once,
   duplicate webhook idempotency, refund webhook, reconciliation
   accept/reject cases, `GET /api/orders/:id` auth), determine what's already
   covered by `test/*.test.ts` with mocks versus what still needs a real
   vendor-signed fixture or live sandbox call. Extend Vitest coverage
   (test-first, per `AGENTS.md`) for anything mock-coverable. For the parts
   that genuinely need Verifone Sandbox or a vendor-signed webhook fixture,
   produce a precise runbook (endpoints, expected payloads, what evidence to
   capture) rather than attempting to fabricate a signature.
6. Do not configure the live sandbox webhook URL in any external dashboard —
   draft the exact URL and steps and hand off.

### 2. `irja-storefront-2026` — contract compliance

1. Read `app/lib/payments-gw/client.ts` and `app/lib/payments-gw/types.ts`
   against `payments-gw/STOREFRONT_INTEGRATION.md` end to end. Confirm, with
   tests: idempotency key generation/reuse rules, `order_id` +
   `order_status_token` handling via `sessionStorage` (never URL/analytics),
   authoritative amount/currency display before redirect, and the full
   `code` → customer-message mapping table (including `429`/`Retry-After`
   handling).
2. Confirm `terms_accepted` / `terms_version` wiring
   (`app/lib/compliance.ts`) sends a value that matches `TERMS_VERSION` in
   `payments-gw/src/lib/terms.ts` right now, and that the drift test pinning
   this value actually fails if one side changes without the other bumping.
   This is the same terms-acceptance gate added in PR #14 — verify it, don't
   re-derive it from scratch.
3. Confirm the order-status polling UI implements the `terminal` /
   `next_poll_ms` / `can_retry` contract with backoff, pause on
   hidden/offline, and a manual re-check action — not just a fixed-interval
   poll.
4. Do not touch `wrangler.jsonc`, routing config, or anything that would
   change how `/api/*` reaches the Worker without halting for review first
   (per this repo's own CLAUDE.md).

### 3. Cross-repo

1. Confirm both repos agree on: the `/api/checkout` request/response shape,
   error `code` values, and the `TERMS_VERSION` value — flag any mismatch as
   a bug, not a judgment call.
2. Do not add any Teya-compatibility shim in either repo — both AGENTS.md
   files explicitly forbid this; the contract is Verifone-only.
3. Produce a single status summary at the end: which `SANDBOX_E2E_GATE.md`
   items are now evidenced, which are code-ready but blocked on
   human-supplied sandbox credentials/vendor fixtures, and any contract
   mismatches found between the two repos. This becomes the human
   handoff — do not mark the gate complete yourself.

## Out of scope / do not do

- No production deploy, no production migration, no production secrets.
- No live/real card transactions.
- No modifying `DEPLOYMENT_GATE.md`'s blocker list to mark anything done
  without the actual evidence attached.
- No pushing directly to `main` on either repo — open a PR per repo (or
  per logical change) for human review, per each repo's T2 tier ("human
  reviews final diff").
