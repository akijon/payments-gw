/**
 * Pricing integrity gate.
 *
 * Rule: block checkout/finalization unless the gateway charge strictly equals
 *   subtotal_excl_vat + total_vat + shipping_incl_vat
 *
 * This is distinct from the internal consistency assertion inside
 * computeInvoice (total == sum of line items). That proves the invoice agrees
 * with itself; this proves the invoice agrees with the money actually taken
 * from the customer. Without it, an invoice can be finalized for an amount the
 * customer was never charged, which is exactly the mismatch Skatturinn audits.
 *
 * All amounts are whole krónur (ISK major units). Shipping is VAT-inclusive, matching the
 * VAT-inclusive catalog pricing the rest of the system uses.
 */
import { describe, it, expect } from 'vitest';
import { assertPricingIntegrity, PricingIntegrityError } from '../src/lib/payment-integrity';

/** subtotal 8065 excl + 1935 VAT + 0 shipping = 10000 charged */
const BALANCED = {
  chargedAmount: 10_000,
  subtotalExclVat: 8_065,
  totalVat: 1_935,
  shippingInclVat: 0,
};

describe('Pricing integrity gate', () => {
  describe('accepts a strictly balanced charge', () => {
    it('permits a charge equal to subtotal + VAT + shipping', () => {
      expect(() => assertPricingIntegrity(BALANCED)).not.toThrow();
    });

    it('permits a balanced charge that includes shipping', () => {
      expect(() =>
        assertPricingIntegrity({
          chargedAmount: 10_990,
          subtotalExclVat: 8_065,
          totalVat: 1_935,
          shippingInclVat: 990,
        }),
      ).not.toThrow();
    });

    it('permits a zero-VAT order', () => {
      expect(() =>
        assertPricingIntegrity({
          chargedAmount: 5_000,
          subtotalExclVat: 5_000,
          totalVat: 0,
          shippingInclVat: 0,
        }),
      ).not.toThrow();
    });
  });

  describe('blocks any mismatch, in either direction', () => {
    it('blocks an undercharge', () => {
      expect(() => assertPricingIntegrity({ ...BALANCED, chargedAmount: 9_999 })).toThrow(PricingIntegrityError);
    });

    it('blocks an overcharge', () => {
      expect(() => assertPricingIntegrity({ ...BALANCED, chargedAmount: 10_001 })).toThrow(PricingIntegrityError);
    });

    it('blocks when shipping was charged but omitted from the invoice', () => {
      // Customer paid 10,990 but the invoice accounts for only 10,000.
      expect(() => assertPricingIntegrity({ ...BALANCED, chargedAmount: 10_990 })).toThrow(PricingIntegrityError);
    });

    it('blocks when VAT is dropped from the total', () => {
      expect(() => assertPricingIntegrity({ ...BALANCED, totalVat: 0 })).toThrow(PricingIntegrityError);
    });

    it('reports both sides of the mismatch for audit', () => {
      try {
        assertPricingIntegrity({ ...BALANCED, chargedAmount: 12_000 });
        expect.unreachable('expected a PricingIntegrityError');
      } catch (error) {
        expect(error).toBeInstanceOf(PricingIntegrityError);
        expect((error as PricingIntegrityError).code).toBe('pricing_mismatch');
        expect((error as PricingIntegrityError).details).toMatchObject({
          charged_amount: 12_000,
          computed_total: 10_000,
        });
      }
    });
  });

  describe('rejects non-integer and negative components', () => {
    it('blocks a fractional charge (krónur must be whole)', () => {
      expect(() => assertPricingIntegrity({ ...BALANCED, chargedAmount: 10_000.5 })).toThrow(PricingIntegrityError);
    });

    it('blocks a fractional VAT amount', () => {
      expect(() => assertPricingIntegrity({ ...BALANCED, totalVat: 1_934.5, chargedAmount: 9_999.5 })).toThrow(
        PricingIntegrityError,
      );
    });

    it('blocks a negative shipping cost', () => {
      expect(() => assertPricingIntegrity({ ...BALANCED, shippingInclVat: -990, chargedAmount: 9_010 })).toThrow(
        PricingIntegrityError,
      );
    });

    it('blocks a non-positive charge', () => {
      expect(() =>
        assertPricingIntegrity({ chargedAmount: 0, subtotalExclVat: 0, totalVat: 0, shippingInclVat: 0 }),
      ).toThrow(PricingIntegrityError);
    });

    it('flags a malformed component distinctly from a clean mismatch', () => {
      try {
        assertPricingIntegrity({ ...BALANCED, chargedAmount: 10_000.5 });
        expect.unreachable('expected a PricingIntegrityError');
      } catch (error) {
        expect((error as PricingIntegrityError).code).toBe('pricing_malformed');
      }
    });
  });
});
