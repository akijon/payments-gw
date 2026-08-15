/**
 * Credit note computation unit tests — number generation, parsing,
 * and amount negation (reversal of original invoice).
 */
import { describe, it, expect } from 'vitest';
import { buildCreditNoteNumber, parseCreditNoteNumber, computeCreditNote } from '../src/lib/invoice-computation';
import type { Invoice } from '../src/types/invoice';
import type { SellerInfo, BuyerInfo } from '../src/types/invoice';

const SELLER: SellerInfo = {
  name: 'Irja ehf.',
  kennitala: '570915-1422',
  vsk_number: '570915',
  address: 'Laugavegur 1, 101 Reykjavík',
  email: 'sala@irja.is',
};

const BUYER: BuyerInfo = {
  name: 'Jón Jónsson',
  kennitala: '010190-2319',
  address: 'Bakkastígur 4, 200 Kópavogur',
  email: 'jon@example.is',
};

function makeInvoice(): Invoice {
  return {
    header: {
      invoice_number: 'REIK-2026-00001',
      issue_date: '2026-08-15',
      due_date: null,
      delivery_date: '2026-08-15',
      currency: 'ISK',
    },
    seller: SELLER,
    buyer: BUYER,
    items: [
      {
        sku: 'TEST-001',
        description: 'Test Product',
        quantity: 2,
        unit_price_excl_vat: 806, // excl = round(1000 * 100/124) = 806
        vat_rate: 24,
        vat_amount: 388, // 2000 - 1612 = 388
        total_incl_vat: 2000,
      },
    ],
    summary: {
      subtotal_excl_vat: 1612, // 806 * 2
      vat_breakdown: [
        {
          rate: 24,
          taxable_base: 1612,
          vat_amount: 388,
        },
      ],
      total_amount_incl_vat: 2000,
    },
  };
}

describe('Credit note computation', () => {
  describe('buildCreditNoteNumber', () => {
    it('builds KREDIT-YYYY-NNNNN format', () => {
      expect(buildCreditNoteNumber(2026, 1)).toBe('KREDIT-2026-00001');
      expect(buildCreditNoteNumber(2026, 42)).toBe('KREDIT-2026-00042');
      expect(buildCreditNoteNumber(2027, 99999)).toBe('KREDIT-2027-99999');
    });

    it('zero-pads sequence to 5 digits', () => {
      expect(buildCreditNoteNumber(2026, 1)).toMatch(/^KREDIT-\d{4}-\d{5}$/);
    });
  });

  describe('parseCreditNoteNumber', () => {
    it('parses valid KREDIT-YYYY-NNNNN', () => {
      expect(parseCreditNoteNumber('KREDIT-2026-00001')).toEqual({ year: 2026, sequence: 1 });
      expect(parseCreditNoteNumber('KREDIT-2026-00042')).toEqual({ year: 2026, sequence: 42 });
    });

    it('rejects invalid format', () => {
      expect(parseCreditNoteNumber('REIK-2026-00001')).toBeNull();
      expect(parseCreditNoteNumber('KREDIT-2026-1')).toBeNull();
      expect(parseCreditNoteNumber('KREDIT-26-00001')).toBeNull();
      expect(parseCreditNoteNumber('')).toBeNull();
    });
  });

  describe('computeCreditNote', () => {
    it('negates all line item amounts', () => {
      const invoice = makeInvoice();
      const creditNote = computeCreditNote(invoice, 'KREDIT-2026-00001', '2026-08-16');

      expect(creditNote).not.toBeNull();
      const item = creditNote!.items[0];
      expect(item.unit_price_excl_vat).toBe(-806);
      expect(item.vat_amount).toBe(-388);
      expect(item.total_incl_vat).toBe(-2000);
      // Quantity stays positive — only monetary amounts are negated
      expect(item.quantity).toBe(2);
      expect(item.vat_rate).toBe(24);
    });

    it('negates summary totals', () => {
      const invoice = makeInvoice();
      const creditNote = computeCreditNote(invoice, 'KREDIT-2026-00001', '2026-08-16');

      expect(creditNote!.summary.subtotal_excl_vat).toBe(-1612);
      expect(creditNote!.summary.total_amount_incl_vat).toBe(-2000);
    });

    it('negates VAT breakdown entries', () => {
      const invoice = makeInvoice();
      const creditNote = computeCreditNote(invoice, 'KREDIT-2026-00001', '2026-08-16');

      const breakdown = creditNote!.summary.vat_breakdown[0];
      expect(breakdown.rate).toBe(24); // rate stays positive
      expect(breakdown.taxable_base).toBe(-1612);
      expect(breakdown.vat_amount).toBe(-388);
    });

    it('references the original invoice number in the header', () => {
      const invoice = makeInvoice();
      const creditNote = computeCreditNote(invoice, 'KREDIT-2026-00001', '2026-08-16');

      expect(creditNote!.header.original_invoice_number).toBe('REIK-2026-00001');
      expect(creditNote!.header.credit_note_number).toBe('KREDIT-2026-00001');
    });

    it('preserves seller and buyer identity from the original', () => {
      const invoice = makeInvoice();
      const creditNote = computeCreditNote(invoice, 'KREDIT-2026-00001', '2026-08-16');

      expect(creditNote!.seller).toEqual(SELLER);
      expect(creditNote!.buyer).toEqual(BUYER);
    });

    it('uses the credit note issue date, not the original invoice date', () => {
      const invoice = makeInvoice();
      const creditNote = computeCreditNote(invoice, 'KREDIT-2026-00001', '2026-08-16');

      expect(creditNote!.header.issue_date).toBe('2026-08-16');
      expect(creditNote!.header.issue_date).not.toBe(invoice.header.issue_date);
    });

    it('returns null for an invoice with no items', () => {
      const emptyInvoice: Invoice = {
        ...makeInvoice(),
        items: [],
      };
      expect(computeCreditNote(emptyInvoice, 'KREDIT-2026-00001', '2026-08-16')).toBeNull();
    });

    it('round-trips: credit note total == -(invoice total)', () => {
      const invoice = makeInvoice();
      const creditNote = computeCreditNote(invoice, 'KREDIT-2026-00001', '2026-08-16');

      expect(creditNote!.summary.total_amount_incl_vat).toBe(-invoice.summary.total_amount_incl_vat);
    });
  });
});
