/**
 * Unit tests for payment reconciliation amount handling.
 *
 * These pin the ISK unit convention: every amount in this service is an
 * integer number of whole krónur (ISK major units), never aurar. The module
 * previously assumed aurar, so "one króna of rounding drift" was written as a
 * discrepancy of 100 — which silently absorbed a real 100 kr mismatch.
 */

import { describe, expect, it } from 'vitest';
import { reconcilePaymentAmounts, validateMonetaryIntegrity } from '../src/lib/payment-reconciliation';

const VAT_LINES = [
  { total_amount: 18_000, vat_rate: 24, quantity: 1 },
  { total_amount: 4_990, vat_rate: 24, quantity: 1 },
];

describe('reconcilePaymentAmounts', () => {
  it('reports an exact match when the authorized amount equals the cart total', () => {
    const result = reconcilePaymentAmounts({
      cartGrossTotal: 22_990,
      gatewayAuthorizedAmount: 22_990,
      vatLineItems: VAT_LINES,
    });

    expect(result.status).toBe('exact_match');
  });

  it('absorbs a one-króna drift into the largest 24% VAT line', () => {
    const result = reconcilePaymentAmounts({
      cartGrossTotal: 22_990,
      gatewayAuthorizedAmount: 22_991,
      vatLineItems: VAT_LINES,
    });

    expect(result.status).toBe('rounding_adjusted');
    expect(result.adjustedAmount).toBe(22_991);
    // The 18.000 kr line is the largest 24% item.
    expect(result.largestVatLineIndex).toBe(0);
    expect(result.adjustmentReason).toContain('+1 ISK');
  });

  it('aborts on a 100 kr mismatch instead of treating it as rounding drift', () => {
    // The regression this guards: with the old `discrepancy === 100` test, a
    // buyer charged 100 kr less than their cart reconciled as "rounding".
    const result = reconcilePaymentAmounts({
      cartGrossTotal: 22_990,
      gatewayAuthorizedAmount: 22_890,
      vatLineItems: VAT_LINES,
    });

    expect(result.status).toBe('TRANSACTION_ABORTED_PRICE_MISMATCH');
    expect(result.adjustmentReason).toContain('drift: 100 ISK');
  });

  it('states mismatch amounts in krónur, not hundredths', () => {
    const result = reconcilePaymentAmounts({
      cartGrossTotal: 18_000,
      gatewayAuthorizedAmount: 180,
      vatLineItems: VAT_LINES,
    });

    expect(result.status).toBe('TRANSACTION_ABORTED_PRICE_MISMATCH');
    expect(result.adjustmentReason).toContain('expected 18000 ISK');
    expect(result.adjustmentReason).toContain('authorized 180 ISK');
  });
});

describe('validateMonetaryIntegrity', () => {
  it('accepts line items that sum to the order amount', () => {
    expect(
      validateMonetaryIntegrity({
        amount: 22_990,
        currency: 'ISK',
        lineItems: [
          { total_amount: 18_000, unit_price: 18_000, quantity: 1 },
          { total_amount: 4_990, unit_price: 4_990, quantity: 1 },
        ],
      }),
    ).toEqual({ valid: true });
  });

  it('rejects a 100 kr sum mismatch that the old ±100 tolerance allowed', () => {
    const result = validateMonetaryIntegrity({
      amount: 22_990,
      currency: 'ISK',
      lineItems: [
        { total_amount: 18_000, unit_price: 18_000, quantity: 1 },
        { total_amount: 4_890, unit_price: 4_890, quantity: 1 },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/do not sum/);
  });

  it('still tolerates a single króna of rounding', () => {
    expect(
      validateMonetaryIntegrity({
        amount: 22_990,
        currency: 'ISK',
        lineItems: [
          { total_amount: 18_000, unit_price: 18_000, quantity: 1 },
          { total_amount: 4_991, unit_price: 4_991, quantity: 1 },
        ],
      }).valid,
    ).toBe(true);
  });

  it('rejects a non-positive or non-integer order amount', () => {
    expect(validateMonetaryIntegrity({ amount: 0, currency: 'ISK' }).valid).toBe(false);
    expect(validateMonetaryIntegrity({ amount: 18_000.5, currency: 'ISK' }).valid).toBe(false);
  });

  it('rejects a malformed currency code', () => {
    expect(validateMonetaryIntegrity({ amount: 18_000, currency: 'isk' }).valid).toBe(false);
  });
});
