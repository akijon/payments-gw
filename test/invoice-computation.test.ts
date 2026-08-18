/**
 * Invoice computation unit tests — VAT calculation, rounding,
 * kennitala validation, and invoice assembly.
 *
 * Icelandic consumer prices are VAT-INCLUSIVE: the catalog unit_price is what
 * the customer pays. computeInvoice reverse-extracts the excl-VAT base and VAT
 * amount from the inclusive price so that total_amount_incl_vat == order.amount.
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
  describe('VAT calculation (VAT-inclusive pricing)', () => {
    it('decomposes 24% VAT-inclusive price correctly', () => {
      // unit_price 8065 is VAT-inclusive (what customer pays)
      const invoice = computeInvoice({
        items: [makeItem(8065, 1, 24)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();
      // excl = round(8065 * 100 / 124) = round(6504.03) = 6504
      expect(invoice!.items[0].unit_price_excl_vat).toBe(6504);
      expect(invoice!.items[0].vat_rate).toBe(24);
      // vat = 8065 - 6504 = 1561
      expect(invoice!.items[0].vat_amount).toBe(1561);
      // total_incl = charged amount (8065)
      expect(invoice!.items[0].total_incl_vat).toBe(8065);
      expect(invoice!.summary.subtotal_excl_vat).toBe(6504);
      expect(invoice!.summary.vat_breakdown).toEqual([{ rate: 24, taxable_base: 6504, vat_amount: 1561 }]);
      // total must equal charged amount
      expect(invoice!.summary.total_amount_incl_vat).toBe(8065);
    });

    it('decomposes 11% reduced VAT-inclusive price correctly', () => {
      const invoice = computeInvoice({
        items: [makeItem(10000, 1, 11)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();
      // excl = round(10000 * 100 / 111) = round(9009.01) = 9009
      expect(invoice!.items[0].unit_price_excl_vat).toBe(9009);
      // vat = 10000 - 9009 = 991
      expect(invoice!.items[0].vat_amount).toBe(991);
      // total_incl = charged amount
      expect(invoice!.items[0].total_incl_vat).toBe(10000);
      expect(invoice!.summary.vat_breakdown[0]).toEqual({
        rate: 11,
        taxable_base: 9009,
        vat_amount: 991,
      });
    });

    it('handles 0% VAT (excl == incl)', () => {
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
      expect(invoice!.items[0].unit_price_excl_vat).toBe(5000);
      expect(invoice!.items[0].total_incl_vat).toBe(10000);
      expect(invoice!.summary.total_amount_incl_vat).toBe(10000);
    });

    it('aggregates items with same VAT rate into one breakdown entry', () => {
      const invoice = computeInvoice({
        items: [makeItem(5000, 1, 24, 'Item A', 'SKU-A'), makeItem(3000, 2, 24, 'Item B', 'SKU-B')],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice).not.toBeNull();
      // Item A: excl = round(5000*100/124) = 4032, vat = 5000-4032 = 968
      // Item B: excl = round(3000*100/124) = 2419, vat = 6000-2419*2 = 1162
      // taxable_base = 4032 + 2419*2 = 8870, vat = 968 + 1162 = 2130
      expect(invoice!.summary.vat_breakdown).toHaveLength(1);
      expect(invoice!.summary.vat_breakdown[0].taxable_base).toBe(8870);
      expect(invoice!.summary.vat_breakdown[0].vat_amount).toBe(2130);
      // total_incl = 5000 + 6000 = 11000 (charged amount)
      expect(invoice!.summary.total_amount_incl_vat).toBe(11000);
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
      // total_incl must equal charged amount: 10000+10000+5000 = 25000
      expect(invoice!.summary.total_amount_incl_vat).toBe(25000);
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
    it('reverse-extracts excl-VAT with half-up rounding', () => {
      // 8065 incl @ 24% → excl = round(8065*100/124) = round(6504.032) = 6504
      const invoice = computeInvoice({
        items: [makeItem(8065, 1, 24)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice!.items[0].unit_price_excl_vat).toBe(6504);
      expect(invoice!.items[0].vat_amount).toBe(1561);
    });

    it('handles exact divisions without error', () => {
      // 10000 incl @ 24% → excl = round(10000*100/124) = round(8064.516) = 8065
      const invoice = computeInvoice({
        items: [makeItem(10000, 1, 24)],
        currency: 'ISK',
        seller: SELLER,
        buyer: BUYER,
        invoiceNumber: 'REIK-2026-00001',
        issueDate: '2026-08-15',
      });
      expect(invoice!.items[0].unit_price_excl_vat).toBe(8065);
      expect(invoice!.items[0].vat_amount).toBe(1935); // 10000 - 8065
    });

    // Amounts are whole krónur, not aurar: ISK is stored and charged in major
    // units. Rounding to the nearest króna is therefore Math.round, not a
    // round-to-nearest-100. The old behaviour quantised every figure to the
    // nearest 100 kr, which would silently rewrite invoice totals.
    it('roundToIsk rounds to the nearest whole króna', () => {
      expect(roundToIsk(0)).toBe(0);
      expect(roundToIsk(49)).toBe(49);
      expect(roundToIsk(100)).toBe(100);
      expect(roundToIsk(18_000)).toBe(18_000);
      expect(roundToIsk(4990.4)).toBe(4990);
      expect(roundToIsk(4990.5)).toBe(4991); // half-up
    });

    it('roundToIsk never quantises to the nearest 100 krónur', () => {
      // 18_050 kr is a legitimate price; it must not collapse to 18_000.
      expect(roundToIsk(18_050)).toBe(18_050);
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

    it('rejects kennitala where intermediate == 10 (no valid check digit)', () => {
      // A kennitala where the weighted sum mod 11 == 1 produces intermediate 10,
      // which has no valid check digit. This is the edge case the old
      // (11 - sum%11) % 10 formula incorrectly mapped to 0.
      // Find a kennitala with sum%11 == 1: digits 00000000X9
      // d0..d7 = 0,0,0,0,0,0,0,0 → sum=0, intermediate=11 → checksum=0
      // d0..d7 = 0,0,0,0,0,0,0,1 → sum=2, intermediate=9
      // We need sum%11==1: d0=0,d1=0,d2=0,d3=0,d4=0,d5=0,d6=0,d7=?
      // weight for d7 is 2, so d7*2 must give sum%11==1 → d7*2=1 mod 11 → no integer
      // Try d0=1 (weight 3): sum=3, 11-3=8, checksum=8
      // Try d0=0,d1=0,d2=0,d3=0,d4=0,d5=0,d6=0,d7=6: sum=12, 12%11=1, intermediate=10 → INVALID
      expect(isValidKennitala('00000006-99')).toBe(false);
      expect(isValidKennitala('00000006-09')).toBe(false);
      // Any 10-digit with those first 8 digits should be rejected regardless of d8
      expect(isValidKennitala('00000006-59')).toBe(false);
    });

    it('accepts kennitala where intermediate == 11 (checksum maps to 0)', () => {
      // sum%11 == 0 → intermediate = 11 → checksum = 0
      // d0..d7 all zero → sum=0, intermediate=11, checksum=0
      // So 000000-0009 should be valid (d8=0)
      expect(isValidKennitala('000000-0009')).toBe(true);
      // And 000000-0109 should be invalid (d8=1)
      expect(isValidKennitala('000000-0109')).toBe(false);
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
      // 8900 is VAT-inclusive @ 24%
      // excl = round(8900*100/124) = round(7177.42) = 7177
      // vat = 8900 - 7177 = 1723
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
      expect(invoice!.items[0].unit_price_excl_vat).toBe(7177);
      expect(invoice!.items[0].vat_rate).toBe(24);

      // Summary — total_incl_vat must equal charged amount
      expect(invoice!.summary.subtotal_excl_vat).toBe(7177);
      expect(invoice!.summary.vat_breakdown).toEqual([{ rate: 24, taxable_base: 7177, vat_amount: 1723 }]);
      expect(invoice!.summary.total_amount_incl_vat).toBe(8900);
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
      // total_incl = 5000 (charged amount)
      expect(invoice!.summary.total_amount_incl_vat).toBe(5000);
    });
  });
});
