/**
 * Document classification fallback rules.
 *
 * Rule: kennitala present + valid -> formal B2B sölureikningur.
 *       kennitala absent/invalid  -> standard B2C sölukvittun, at ANY amount.
 *
 * There is deliberately no value threshold: an unidentified buyer cannot be
 * issued a B2B invoice regardless of order size, because the kennitala is the
 * field that makes the document a sölureikningur in the first place.
 */
import { describe, it, expect } from 'vitest';
import { classifyDocument, validateCustomerData } from '../src/lib/document-classification';

const VALID_KT = '010190-2319';

describe('Document classification', () => {
  describe('kennitala drives the document type', () => {
    it('issues a formal sölureikningur when a valid kennitala is present', () => {
      const result = classifyDocument({ amount: 1_500_000, buyerKennitala: VALID_KT });

      expect(result.documentType).toBe('sölureikningur');
      expect(result.requiresKennitala).toBe(true);
    });

    it('falls back to a B2C sölukvittun when kennitala is absent', () => {
      const result = classifyDocument({ amount: 1_500_000 });

      expect(result.documentType).toBe('sölukvittun');
      expect(result.requiresKennitala).toBe(false);
    });

    it('falls back to a B2C sölukvittun when kennitala fails checksum', () => {
      // Check digit (position 9) altered from the valid 010190-2319.
      const result = classifyDocument({ amount: 1_500_000, buyerKennitala: '010190-2229' });

      expect(result.documentType).toBe('sölukvittun');
      expect(result.requiresKennitala).toBe(false);
    });
  });

  describe('no value threshold overrides a missing kennitala', () => {
    // Guards the removed 50,000 ISK rule: a high-value consumer order without a
    // kennitala must stay a receipt rather than silently becoming an invoice.
    const amounts = [
      { label: 'below the old 50k threshold', amount: 10_000 * 100 },
      { label: 'exactly at the old 50k threshold', amount: 50_000 * 100 },
      { label: 'far above the old 50k threshold', amount: 900_000 * 100 },
    ];

    for (const { label, amount } of amounts) {
      it(`classifies as sölukvittun ${label}`, () => {
        expect(classifyDocument({ amount }).documentType).toBe('sölukvittun');
      });
    }

    it('classifies as sölureikningur at any amount once a kennitala is supplied', () => {
      for (const { amount } of amounts) {
        expect(classifyDocument({ amount, buyerKennitala: VALID_KT }).documentType).toBe('sölureikningur');
      }
    });
  });

  describe('business-name indicators', () => {
    it('treats a company suffix as a B2B transaction requiring a kennitala', () => {
      const result = classifyDocument({ amount: 10_000, customerName: 'Kaffi Norður ehf' });

      expect(result.documentType).toBe('sölureikningur');
      expect(result.requiresKennitala).toBe(true);
    });

    it('does not treat a personal name as a business', () => {
      const result = classifyDocument({ amount: 10_000, customerName: 'Jón Jónsson' });

      expect(result.documentType).toBe('sölukvittun');
    });
  });

  describe('customer data status', () => {
    it('reports valid for an identified B2B buyer', () => {
      const result = validateCustomerData({ amount: 900_000 * 100, buyerKennitala: VALID_KT });

      expect(result.status).toBe('valid');
      expect(result.classification.documentType).toBe('sölureikningur');
    });

    it('reports fallback_receipt for an unidentified consumer at any amount', () => {
      const result = validateCustomerData({ amount: 900_000 * 100 });

      expect(result.status).toBe('fallback_receipt');
      expect(result.classification.documentType).toBe('sölukvittun');
    });

    it('reports PENDING_CUSTOMER_DATA when a business lacks a valid kennitala', () => {
      const result = validateCustomerData({ amount: 10_000, customerName: 'Kaffi Norður ehf' });

      expect(result.status).toBe('PENDING_CUSTOMER_DATA');
    });
  });
});
