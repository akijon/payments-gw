# PayPal Implementation Plan — Irja Payments Gateway

## Context & Status

**Goal**: Add PayPal to Verifone HPP with funds settling to Irja PayPal account.

**Current State**:

- Gateway implementation and test coverage complete: 132 tests passing
- PayPal configuration is correctly suppressed for ISK (fail-closed until currency resolution)
- Existing card/3DS HPP flow remains unchanged
- PayPal orders are identified after server-side verification and excluded from Landsbankinn reconciliation

## Critical Blockers

### 1. ISK Currency Gate (Task 0)

PayPal does not support ISK natively, while the Irja catalog and checkout are ISK-denominated.

**Decision — 2026-08-02:** Keep the storefront **ISK/card-only**. PayPal remains unavailable and its Verifone HPP configuration stays suppressed for ISK.

This is intentional, not a partial rollout. Revisit only with a separately scoped multi-currency checkout design, EUR product pricing, FX ownership, and real sandbox validation.

### 2. Settlement Divergence

- **Card payments**: Landsbankinn acquirer → reconciled via `reconcile.ts`
- **PayPal payments**: Direct to PayPal account → different settlement path

## Implementation Phases

### Phase 1: Data Model & Payment Method Tracking

#### 1.1 Schema Migration

```sql
-- 0008_payment_method.sql
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card'
  CHECK (payment_method IN ('card', 'paypal', 'apple_pay', 'google_pay', 'unknown'));
CREATE INDEX idx_orders_payment_method ON orders(payment_method);
```

`unknown` is fail-closed: it is retained for audit and excluded from Landsbankinn reconciliation.

**Status:** Implemented. Applying this migration to sandbox/production is Tier 3 and requires explicit approval.

#### 1.2 Extend Types

Add `payment_method: 'card' | 'paypal' | 'apple_pay' | 'google_pay' | 'unknown'` to Order type. Unknown or missing provider products must remain `unknown`; they must not be routed through card reconciliation.

#### 1.3 Payment Method Detection

Enhance `parseCheckoutResult()` to extract `payment_product` from Verifone response:

- Map `PAYPAL` → `paypal`, `VISA`/`MASTERCARD` → `card`, etc.

### Phase 2: Payment Lifecycle

#### 2.1 Return Processing

Update `processReturnUseCase` to:

1. Extract payment method from checkout detail
2. Store in orders.payment_method during `paid` transition

#### 2.2 Webhook Processing

Update `processWebhookUseCase` to:

1. Extract payment method from webhook `content.payment_product`
2. Store during status transitions

### Phase 3: Settlement Routing

#### 3.1 Reconciliation Logic

Update `reconcile.ts` to:

1. Skip PayPal orders in Landsbankinn matching
2. Log exclusions for audit

#### 3.2 PayPal Settlement Strategy

**Options** (user decision required):

- Auto-settle PayPal orders after verification hold period
- Manual settlement confirmation workflow
- PayPal payout API reconciliation (if available)

### Phase 4: Currency Resolution (Conditional)

**If multi-currency needed**:

1. Extend catalog with EUR pricing
2. Currency selection UI in storefront
3. FX rate management
4. Updated payment integrity checks

**If Verifone FX**:

1. Verify conversion handled by Verifone
2. Update integrity checks for currency differences

## Test Coverage

### Unit and integration tests

- [x] PayPal configuration builder and ISK fail-closed gate
- [x] Payment method normalization from provider checkout details
- [x] Verified return persists `payment_method = 'paypal'`
- [x] Verified webhook persists `payment_method = 'paypal'`
- [x] Landsbankinn reconciliation excludes and audits non-card orders
- [ ] Real PayPal HPP sandbox E2E (blocked on Task 0 and sandbox credentials)
- [ ] Mixed card/PayPal bank settlement batch (not applicable until Verifone confirms settlement routing)
- [ ] Currency conversion validation (if applicable)

## Risk Mitigation

### Fail-Safe Gates

1. **ISK suppression**: PayPal omitted until currency resolved
2. **Contract validation**: Empty contract ID = no PayPal option
3. **Settlement isolation**: PayPal orders can't corrupt Landsbankinn reconciliation

### Rollback Strategy

1. Remove `VERIFONE_PAYPAL_PAYMENT_CONTRACT_ID` = instant disable
2. Orders retain payment_method for historical tracking
3. Migration is additive (no data loss)

## Deferred Questions for a Future Multi-Currency Rollout

1. **Currency model:** Which EUR prices apply to each product, and who owns any FX exposure?
2. **Settlement evidence:** How should PayPal orders transition from `paid` to `settled`—payout API reconciliation or a documented manual control?
3. **Sandbox access:** Verifone PayPal sandbox contract credentials are required before real HPP E2E validation.

## Next Actions

1. ✅ Keep production checkout restricted to ISK/card payments; PayPal configuration remains fail-closed.
2. ✅ Implement gateway data model, verified lifecycle tracking, and Landsbankinn isolation for a future PayPal rollout.
3. ❓ If multi-currency becomes a business requirement, scope EUR product pricing, exchange-rate ownership, currency UI, and payment-integrity changes as a new feature.
4. ❓ Obtain a PayPal/Verifone sandbox contract and execute the real HPP E2E gate only after that scope is approved.
5. ❓ Request explicit Tier 3 approval before applying `0008_payment_method.sql`, changing secrets, or deploying any future PayPal enablement.
