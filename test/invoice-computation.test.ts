/**
 * Invoice computation unit tests — VAT calculation, rounding,
 * kennitala validation, and invoice assembly.
 */
import { describe, it, expect } from 'vitest';
import {
  computeInvoice,
  isValidKennitala,
  formatKennitala,
  buildInvoiceNumber,
  parseInvoiceNumber,
  roundToIsk,
} from '../src/lib/invoice-computation';
import type { VatLineItem } from '../src/types/invoice';
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

function makeItem(
  unitPrice: number,
  quantity: number,
  vatRate: 24 | 11 | 0,
  name = 'Test Product',
  sku = 'TEST-001',
): VatLineItem {
  return {
    product_id: sku,
    name,
    quantity,
    unit_price: unitPrice,
    total_amount: unitPrice * quantity,
    sku,
    vat_rate: vatRate,
  };
}

describe('Invoice computation', () => {
  describe('VAT calculation', () => {
    it('computes 24% VAT correctly', () => {
      const invoice = computeInvoice({
        items: [makeItem(8065, 1, 24)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.items[0].unit_price_excl_vat).toBe(8065);
      expect(invoice!.items[0].vat_rate).toBe(24);
      expect(invoice!.items[0].vat_amount).toBe(1936); // round(8065 * 24 / 100) = round(1935.6) = 1936
      expect(invoice!.items[0].total_incl_vat).toBe(10001); // 8065 + 1936
      expect(invoice!.summary.subtotal_excl_vat).toBe(8065);
      expect(invoice!.summary.vat_breakdown).toEqual([
        { rate: 24, taxable_base: 8065, vat_amount: 1936 },
      ]);
      expect(invoice!.summary.total_amount_incl_vat).toBe(10001);
    });

    it('computes 11% reduced VAT correctly', () => {
      const invoice = computeInvoice({
        items: [makeItem(10000, 1, 11)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.items[0].vat_amount).toBe(1100); // 10000 * 11 / 100 = 1100
      expect(invoice!.items[0].total_incl_vat).toBe(11100);
      expect(invoice!.summary.vat_breakdown[0]).toEqual({
        rate: 11,
        taxable_base: 10000,
        vat_amount: 1100,
      });
    });

    it('computes 0% VAT correctly', () => {
      const invoice = computeInvoice({
        items: [makeItem(5000, 2, 0)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.items[0].vat_amount).toBe(0);
      expect(invoice!.items[0].total_incl_vat).toBe(10000);
      expect(invoice!.summary.total_amount_incl_vat).toBe(10000);
    });

    it('aggregates items with same VAT rate into one breakdown entry', () => {
      const invoice = computeInvoice({
        items: [
          makeItem(5000, 1, 24, 'Item A', 'SKU-A'),
          makeItem(3000, 2, 24, 'Item B', 'SKU-B'),
        ],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.summary.vat_breakdown).toHaveLength(1);
      expect(invoice!.summary.vat_breakdown[0].taxable_base).toBe(11000); // 5000 + 6000
      expect(invoice!.summary.vat_breakdown[0].vat_amount).toBe(2640); // round(11000 * 24/100) = 2640
    });

    it('creates separate VAT breakdown entries for different rates', () => {
      const invoice = computeInvoice({
        items: [
          makeItem(10000, 1, 24, 'Standard', 'SKU-24'),
          makeItem(10000, 1, 11, 'Reduced', 'SKU-11'),
          makeItem(5000, 1, 0, 'Zero', 'SKU-0'),
        ],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.summary.vat_breakdown).toHaveLength(3);
      // Sorted descending by rate
      expect(invoice!.summary.vat_breakdown[0].rate).toBe(24);
      expect(invoice!.summary.vat_breakdown[1].rate).toBe(11);
      expect(invoice!.summary.vat_breakdown[2].rate).toBe(0);
    });

    it('returns null for empty items', () => {
      const invoice = computeInvoice({
        items: [],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).toBeNull();
    });
  });

  describe('Rounding', () => {
    it('rounds half-up to nearest aurar', () => {
      // 8065 * 24 / 100 = 1935.6 → rounds to 1936
      const invoice = computeInvoice({
        items: [makeItem(8065, 1, 24)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice!.items[0].vat_amount).toBe(1936);
    });

    it('rounds exact divisions without error', () => {
      // 10000 * 24 / 100 = 2400 exactly
      const invoice = computeInvoice({
        items: [makeItem(10000, 1, 24)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice!.items[0].vat_amount).toBe(2400);
    });

    it('roundToIsk rounds to nearest 100 aurar', () => {
      expect(roundToIsk(0)).toBe(0);
      expect(roundToIsk(49)).toBe(0);
      expect(roundToIsk(50)).toBe(100); // half-up: 50 aurar → 100 aurar (1 ISK)
      expect(roundToIsk(100)).toBe(100);
      expect(roundToIsk(150)).toBe(200);
      expect(roundToIsk(250)).toBe(300);
    });
  });

  describe('Kennitala validation', () => {
    it('validates a correct kennitala', () => {
      // Real kennitala format — use known valid test KT
      expect(isValidKennitala('010130-3019')).toBe(true);
    });

    it('rejects invalid checksum', () => {
      // 010130-3029: checksum should be 1, but digit 8 is 2
      expect(isValidKennitala('010130-3029')).toBe(false);
    });

    it('rejects wrong length', () => {
      expect(isValidKennitala('12345-678')).toBe(false);
      expect(isValidKennitala('123456789')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidKennitala('')).toBe(false);
      expect(isValidKennitala(null as unknown as string)).toBe(false);
    });

    it('accepts both XXXXXX-XXXX and XXXXXXXXXX formats', () => {
      expect(isValidKennitala('010130-3019')).toBe(true);
      expect(isValidKennitala('0101303019')).toBe(true);
    });

    it('formats kennitala as XXXXXX-XXXX', () => {
      expect(formatKennitala('0101303019')).toBe('010130-3019');
      expect(formatKennitala('010130-3019')).toBe('010130-3019');
      expect(formatKennitala(undefined)).toBeNull();
      expect(formatKennitala(null)).toBeNull();
      expect(formatKennitala('12345')).toBeNull();
    });
  });

  describe('Invoice numbering', () => {
    it('builds invoice number with 5-digit zero-padded sequence', () => {
      expect(buildInvoiceNumber(2026, 1)).toBe('REIK-2026-00001');
      expect(buildInvoiceNumber(2026, 12345)).toBe('REIK-2026-12345');
      expect(buildInvoiceNumber(2027, 100)).toBe('REIK-2027-00100');
    });

    it('parses invoice number back to year + sequence', () => {
      expect(parseInvoiceNumber('REIK-2026-00001')).toEqual({ year: 2026, sequence: 1 });
      expect(parseInvoiceNumber('REIK-2026-12345')).toEqual({ year: 2026, sequence: 12345 });
    });

    it('returns null for invalid format', () => {
      expect(parseInvoiceNumber('REIK-2026-1')).toBeNull();
      expect(parseInvoiceNumber('REIK-26-00001')).toBeNull();
      expect(parseInvoiceNumber('')).toBeNull();
    });
  });

  describe('Full invoice structure', () => {
    it('produces a complete invoice with all mandatory fields', () => {
      const invoice = computeInvoice({
        items: [makeItem(8900, 1, 24)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
        dueDate: '2026-08-15',
        deliveryDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();

      // Header
      expect(invoice!.header.invoice_number).toBe('REIK-2026-00001');
      expect(invoice!.header.issue_date).toBe('2026-08-15');
      expect(invoice!.header.due_date).toBe('2026-08-15');
      expect(invoice!.header.delivery_date).toBe('2026-08-15');
      expect(invoice!.header.currency).toBe('ISK');

      // Seller
      expect(invoice!.seller.name).toBe('Irja ehf.');
      expect(invoice!.seller.kennitala).toBe('570915-1422');
      expect(invoice!.seller.vsk_number).toBe('570915');
      expect(invoice!.seller.address).toContain('Reykjavík');
      expect(invoice!.seller.email).toBe('sala@irja.is');

      // Buyer
      expect(invoice!.buyer.name).toBe('Jón Jónsson');
      expect(invoice!.buyer.kennitala).toBe('010190-2319');

      // Items
      expect(invoice!.items).toHaveLength(1);
      expect(invoice!.items[0].sku).toBe('TEST-001');
      expect(invoice!.items[0].description).toBe('Test Product');
      expect(invoice!.items[0].quantity).toBe(1);
      expect(invoice!.items[0].unit_price_excl_vat).toBe(8900);
      expect(invoice!.items[0].vat_rate).toBe(24);

      // Summary
      expect(invoice!.summary.subtotal_excl_vat).toBe(8900);
      expect(invoice!.summary.vat_breakdown).toEqual([
        { rate: 24, taxable_base: 8900, vat_amount: 2136 },
      ]);
      expect(invoice!.summary.total_amount_incl_vat).toBe(11036); // 8900 + 2136
    });

    it('handles buyer without kennitala (B2C receipt)', () => {
      const invoice = computeInvoice({
        items: [makeItem(5000, 1, 24)],
        currency: 'ISK',
        seller: SELLER,
        buyer: { name: 'Anonymous Customer' },
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.buyer.kennitala).toBeUndefined();
    });
  });
});
