# Deployment readiness — superseded

> **Production deployment is blocked.** `DEPLOYMENT_GATE.md` is the authoritative release gate.

This file previously claimed the gateway was ready based on local tests and tooling. That was too strong: local checks do not validate Cloudflare production resources, provider credentials, edge routing, webhook delivery, or real Verifone/Landsbankinn behavior.

## Verified locally

Run:

```bash
npm run quality:check
```

The command checks formatting, ESLint, TypeScript, the test suite with coverage thresholds, the dependency audit, and a Worker dry-run build. Passing it means the repository is internally consistent; it does **not** approve production processing.

## Required next step

Complete every unchecked item in `DEPLOYMENT_GATE.md`, especially:

- Replace the currently deployed Teya storefront contract with the documented Verifone gateway contract.
- Route the gateway endpoints, including `/api/return`, to this Worker.
- Apply and verify all D1 migrations in the target database.
- Configure production-only Cloudflare resources and provider credentials.
- Complete real sandbox end-to-end payment, webhook, return, decline, refund, and reconciliation tests.
- Configure edge security, monitoring, rollback, and operational ownership.

Do not use the unguarded sandbox deployment command as a production release procedure. Production migration and deployment use the confirmation-gated commands documented in `DEPLOYMENT_GATE.md`.
