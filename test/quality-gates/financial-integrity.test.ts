/**
 * NOTE ON UNITS: this service stores and charges ISK in **major units** (whole
 * krónur). `amount: 18000` is 18.000 kr. The "aurar / minor units" framing in
 * the cases below is historical and does NOT describe the gateway's data; the
 * assertions are unit-agnostic integer arithmetic and pass either way.
 *
 * NOTE ON SCOPE: these cases import nothing from `src/` — they assert
 * JavaScript's own integer and floating-point behaviour, not this codebase's
 * financial logic. Treat them as documentation of the arithmetic rules the
 * code follows, not as coverage of it. Real coverage of the money paths lives
 * in `test/pricing-integrity.test.ts`, `test/invoice-computation.test.ts`, and
 * `test/payment-reconciliation.test.ts`.
 */

import { describe, it, expect } from 'vitest';

describe('Financial Integrity Validation', () => {
  describe('Monetary Arithmetic Precision', () => {
    it('handles ISK minor units (aurar) correctly', () => {
      // ISK: 1 krona = 100 aurar
      const price1 = 150000; // 1,500.00 ISK in aurar
      const price2 = 25050; // 250.50 ISK in aurar
      const quantity = 3;

      const total = (price1 + price2) * quantity;
      expect(total).toBe(525150); // 5,251.50 ISK in aurar
    });

    it('prevents floating-point precision errors in currency calculations', () => {
      // Common JS floating-point trap: 0.1 + 0.2 !== 0.3
      // Always use integer minor units for exact arithmetic

      // Convert to aurar first, then calculate
      const price1InAurar = Math.round(149.99 * 100); // 14999 aurar
      const price2InAurar = Math.round(50.01 * 100); // 5001 aurar

      const total = price1InAurar + price2InAurar;
      expect(total).toBe(20000); // Exactly 200.00 ISK = 20000 aurar

      // Verify conversion back to ISK is exact
      expect(total / 100).toBe(200.0);
    });

    it('handles edge cases in monetary arithmetic', () => {
      // Zero amounts
      // oxlint-disable-next-line oxc/erasing-op -- intentionally verifying the zero-amount case
      expect(0 * 5).toBe(0);

      // Single aurar (smallest unit)
      expect(1 * 100).toBe(100); // 1 aurar * 100 quantity

      // Large amounts (within safe integer range)
      const largePrice = 999999999; // 9,999,999.99 ISK in aurar
      expect(largePrice + 1).toBe(1000000000); // Still exact
    });

    it('validates safe integer limits for financial calculations', () => {
      // JavaScript safe integer limit: Number.MAX_SAFE_INTEGER = 9,007,199,254,740,991
      // In aurar: 90,071,992,547,409.91 ISK (way beyond normal transaction limits)

      const maxSafeAurar = Number.MAX_SAFE_INTEGER;
      const maxSafeISK = maxSafeAurar / 100;

      expect(Number.isSafeInteger(maxSafeAurar)).toBe(true);
      expect(maxSafeISK).toBe(90071992547409.91);

      // Verify we can safely add 1 aurar to large amounts
      const largeTransaction = 1000000000; // 10,000,000.00 ISK
      expect(Number.isSafeInteger(largeTransaction + 1)).toBe(true);
    });
  });

  describe('Server-Side Price Authority', () => {
    // Mock product catalog for testing
    const mockCatalog = new Map([
      ['HOODIE-BLK-M', { name: 'Black Hoodie M', price: 8900 }], // 89.00 ISK
      ['TSHIRT-WHT-L', { name: 'White T-Shirt L', price: 4500 }], // 45.00 ISK
      ['JEANS-BLUE-32', { name: 'Blue Jeans 32', price: 12000 }], // 120.00 ISK
    ]);

    function calculateSecureTotal(
      items: Array<{ product_id: string; quantity: number }>,
      catalog: Map<string, { name: string; price: number }>,
    ): number {
      return items.reduce((total, item) => {
        const product = catalog.get(item.product_id);
        if (!product) {
          throw new Error(`Unknown product: ${item.product_id}`);
        }

        if (item.quantity <= 0) {
          throw new Error(`Invalid quantity: ${item.quantity}`);
        }

        return total + product.price * item.quantity;
      }, 0);
    }

    it('calculates totals from product catalog only', () => {
      const items = [
        { product_id: 'HOODIE-BLK-M', quantity: 2 },
        { product_id: 'TSHIRT-WHT-L', quantity: 1 },
      ];

      const total = calculateSecureTotal(items, mockCatalog);
      expect(total).toBe(22300); // (8900 * 2) + (4500 * 1) = 223.00 ISK
    });

    it('rejects unknown product IDs', () => {
      const items = [{ product_id: 'NONEXISTENT-PRODUCT', quantity: 1 }];

      expect(() => calculateSecureTotal(items, mockCatalog)).toThrow('Unknown product: NONEXISTENT-PRODUCT');
    });

    it('rejects invalid quantities', () => {
      const invalidQuantities = [0, -1, -5];

      invalidQuantities.forEach((quantity) => {
        const items = [{ product_id: 'HOODIE-BLK-M', quantity }];

        expect(() => calculateSecureTotal(items, mockCatalog)).toThrow(`Invalid quantity: ${quantity}`);
      });
    });

    it('handles mixed product types and quantities correctly', () => {
      const complexOrder = [
        { product_id: 'HOODIE-BLK-M', quantity: 3 }, // 89.00 * 3 = 267.00
        { product_id: 'TSHIRT-WHT-L', quantity: 5 }, // 45.00 * 5 = 225.00
        { product_id: 'JEANS-BLUE-32', quantity: 1 }, // 120.00 * 1 = 120.00
        // Total: 612.00 ISK = 61200 aurar
      ];

      const total = calculateSecureTotal(complexOrder, mockCatalog);
      expect(total).toBe(61200);
    });
  });

  describe('Settlement Reconciliation Integrity', () => {
    it('ensures transaction amounts match between gateway and bank', () => {
      // Mock gateway record
      const gatewayTransaction = {
        transaction_id: 'txn-12345',
        amount: 15000, // 150.00 ISK
        currency: 'ISK',
        status: 'completed',
      };

      // Mock bank settlement record
      const bankSettlement = {
        reference: 'txn-12345',
        amount: 150.0, // Bank reports in ISK (major units)
        currency: 'ISK',
      };

      // Convert bank amount to aurar for comparison
      const bankAmountInAurar = Math.round(bankSettlement.amount * 100);

      expect(gatewayTransaction.amount).toBe(bankAmountInAurar);
      expect(gatewayTransaction.currency).toBe(bankSettlement.currency);
    });

    it('detects settlement mismatches that indicate errors', () => {
      const gatewayAmount = 15000; // 150.00 ISK in aurar
      const bankAmount = 15001; // 150.01 ISK in aurar (1 aurar difference)

      const tolerance = 0; // Zero tolerance for financial discrepancies
      const difference = Math.abs(gatewayAmount - bankAmount);

      expect(difference).toBeGreaterThan(tolerance);

      // This should trigger an alert in production
      if (difference > tolerance) {
        const errorMessage = `Settlement mismatch: gateway ${gatewayAmount} vs bank ${bankAmount} (diff: ${difference} aurar)`;
        expect(errorMessage).toContain('Settlement mismatch');
      }
    });
  });

  describe('Currency Format Validation', () => {
    it('formats ISK amounts correctly for display', () => {
      function formatISK(aurar: number): string {
        const isk = aurar / 100;
        return new Intl.NumberFormat('is-IS', {
          style: 'currency',
          currency: 'ISK',
          minimumFractionDigits: 2,
        }).format(isk);
      }

      // Test that formatting works and preserves precision
      expect(formatISK(0)).toContain('0');
      expect(formatISK(100)).toContain('1'); // 1.00 ISK
      expect(formatISK(1550)).toContain('15'); // 15.50 ISK
      expect(formatISK(123456)).toMatch(/1.234|1234/); // 1234.56 ISK (with or without thousands separator)

      // Key requirement: currency code appears
      expect(formatISK(100)).toContain('ISK');

      // Key requirement: no precision loss in conversion
      expect(formatISK(1)).toMatch(/0[.,]01/); // 0.01 ISK (smallest unit)
    });
  });
});
