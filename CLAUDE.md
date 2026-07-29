# CLAUDE.md — Irja Payments Gateway

Obey `AGENTS.md`.

## Hard rules

1. Zero pedagogical filler unless asked
2. Test-first; complete only when tests green
3. Edge-first (CF Workers / ESM / strict TS)

## Trust tiers

- **T1 Read/Verify** — autonomous (tests, tsc, lint, reads). Never ask to run tests.
- **T2 Local write** — autonomous (code, tests, local commits, docs). Human reviews final diff.
- **T3 State/infra** — HARD STOP (migrations apply, crypto, deploy, live secrets/webhooks). Draft → halt → human approval.

## Directives

- After any `.ts` edit: `npm test` (safe-env wrapper); no permission ask; ≤3 self-fix attempts then halt.
- Do not use real CF/Landsbankinn/Verifone tokens in T1/T2 loops — `scripts/with-agent-safe-env.sh` strips them from test/typecheck/lint.
- Halt for review on: `src/lib/crypto.ts`, `migrations/**`, `wrangler.toml`, deploy/migrate remote.
