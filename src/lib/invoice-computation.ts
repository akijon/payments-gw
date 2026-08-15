/**
 * Icelandic invoice computation — VAT calculation, kennitala validation,
 * sequential numbering, and invoice assembly.
 *
 * VAT rates: 24% standard, 11% reduced (food, books, lodging), 0% exempt.
 * All amounts in minor units (aurar for ISK). Rounding follows Icelandic
 * standard: half-up to nearest whole króna (1 ISK = 100 aurar).
 *
 * Legal basis: Lög um virðisaukaskatt nr. 50/1988, reglugerð nr. 505/2013.
 */

import type {
  VatRate,
  Invoice,
  InvoiceLineItem,
  VatBreakdownEntry,
  SellerInfo,
  BuyerInfo,
  VatLineItem,
} from '../types/invoice';

// ─── VAT rates ──────────────────────────────────────────────────

export const STANDARD_VAT_RATE: VatRate = 24;
export const REDUCED_VAT_RATE: VatRate = 11;
export const ZERO_VAT_RATE: VatRate = 0;

export const VALID_VAT_RATES: ReadonlySet<number> = new Set([0, 11, 24]);

// ─── Rounding ───────────────────────────────────────────────────

/**
 * Round half-up to nearest whole króna (100 aurar).
 * ISK has no fractional unit in practice; prices are whole krónur.
 * Minor units are aurar (1 ISK = 100 aurar), so we round to nearest 100.
 */
export function roundToIsk(minorUnits: number): number {
  return Math.round(minorUnits / 100) * 100;
}

// ─── Kennitala validation ──────────────────────────────────────

/**
 * Validate an Icelandic kennitala (national ID).
 * Format: XXXXXX-XXXX or XXXXXXXXXX (10 digits).
 * Checksum: digit 9 = (11 - (sum of weighted digits 1-8) mod 11) mod 10.
 * Weights for digits 1-8: 3, 2, 7, 6, 5, 4, 3, 2.
 *
 * For invoice purposes, we validate format + checksum.
 * A valid kennitala is required for B2B invoices.
 */
export function isValidKennitala(kt: string): boolean {
  if (!kt) return false;
  const digits = kt.replace(/\D/g, '');
  if (digits.length !== 10) return false;
  if (!/^\d{10}$/.test(digits)) return false;

  const d = digits.split('').map(Number);
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += d[i] * weights[i];
  }
  const intermediate = 11 - (sum % 11);
  // If intermediate == 11, checksum is 0 (sum % 11 == 0 case).
  // If intermediate == 10, no valid check digit exists — reject.
  // Otherwise checksum = intermediate.
  if (intermediate === 11) return d[8] === 0;
  if (intermediate === 10) return false;
  return d[8] === intermediate;
}

/**
 * Normalise kennitala to XXXXXX-XXXX display format.
 * Returns null if the input is empty/invalid-format (does not validate checksum).
 */
export function formatKennitala(kt: string | undefined | null): string | null {
  if (!kt) return null;
  const digits = kt.replace(/\D/g, '');
  if (digits.length !== 10) return null;
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}

// ─── Invoice assembly ──────────────────────────────────────────

export interface InvoiceComputationInput {
  items: VatLineItem[];
  currency: string;
  seller: SellerInfo;
  buyer: BuyerInfo;
  invoiceNumber: string;
  issueDate: string;
  dueDate?: string | null;
  deliveryDate?: string | null;
}

/**
 * Compute line items with VAT breakdown and totals.
 *
 * Icelandic consumer prices are VAT-INCLUSIVE: the catalog `unit_price` is
 * what the customer pays, and `order.amount = sum(unit_price * quantity)`
 * is sent to Verifone. The invoice must decompose that inclusive price:
 *   unit_price_excl_vat = round(unit_price_incl_vat * 100 / (100 + vat_rate))
 *   vat_amount = unit_price_incl_vat - unit_price_excl_vat
 *   total_incl_vat = unit_price_incl_vat * quantity  (= charged amount)
 *
 * Returns null if items are empty or computation overflows.
 */
export function computeInvoice(input: InvoiceComputationInput): Invoice | null {
  if (input.items.length === 0) return null;

  const lineItems: InvoiceLineItem[] = [];
  let subtotalExclVat = 0;
  const vatBuckets = new Map<VatRate, VatBreakdownEntry>();

  for (const item of input.items) {
    // item.unit_price and item.total_amount are VAT-inclusive (the charged price).
    const unitPriceInclVat = item.unit_price;
    const totalInclVat = item.total_amount; // already unit_price * quantity

    // Reverse VAT extraction: excl = round(incl * 100 / (100 + rate))
    const unitPriceExclVat = Math.round((unitPriceInclVat * 100) / (100 + item.vat_rate));
    const vatAmount = totalInclVat - unitPriceExclVat * item.quantity;

    if (
      !Number.isSafeInteger(unitPriceExclVat) ||
      !Number.isSafeInteger(vatAmount) ||
      !Number.isSafeInteger(totalInclVat) ||
      !Number.isSafeInteger(subtotalExclVat + unitPriceExclVat * item.quantity)
    ) {
      return null; // overflow guard
    }

    const lineExclVat = unitPriceExclVat * item.quantity;
    subtotalExclVat += lineExclVat;

    // Aggregate into VAT bucket
    const bucket = vatBuckets.get(item.vat_rate);
    if (bucket) {
      bucket.taxable_base += lineExclVat;
      bucket.vat_amount += vatAmount;
    } else {
      vatBuckets.set(item.vat_rate, {
        rate: item.vat_rate,
        taxable_base: lineExclVat,
        vat_amount: vatAmount,
      });
    }

    lineItems.push({
      sku: item.sku ?? item.product_id,
      description: item.name,
      quantity: item.quantity,
      unit_price_excl_vat: unitPriceExclVat,
      vat_rate: item.vat_rate,
      vat_amount: vatAmount,
      total_incl_vat: totalInclVat,
    });
  }

  // Sort VAT breakdown by rate descending (24%, 11%, 0%)
  const vatBreakdown = Array.from(vatBuckets.values()).sort((a, b) => b.rate - a.rate);

  let totalVat = 0;
  for (const b of vatBreakdown) {
    totalVat += b.vat_amount;
  }

  const totalAmountInclVat = subtotalExclVat + totalVat;
  if (!Number.isSafeInteger(totalAmountInclVat)) return null;

  // Assert: invoice total must equal the sum of item totals (charged amount)
  let sumItemTotals = 0;
  for (const li of lineItems) {
    sumItemTotals += li.total_incl_vat;
  }
  if (totalAmountInclVat !== sumItemTotals) return null;

  return {
    header: {
      invoice_number: input.invoiceNumber,
      issue_date: input.issueDate,
      due_date: input.dueDate ?? null,
      delivery_date: input.deliveryDate ?? null,
      currency: input.currency,
    },
    seller: input.seller,
    buyer: input.buyer,
    items: lineItems,
    summary: {
      subtotal_excl_vat: subtotalExclVat,
      vat_breakdown: vatBreakdown,
      total_amount_incl_vat: totalAmountInclVat,
    },
  };
}

// ─── Invoice number generation ─────────────────────────────────

export function buildInvoiceNumber(year: number, sequence: number): string {
  return `REIK-${year}-${String(sequence).padStart(5, '0')}`;
}

/**
 * Parse a invoice number to extract year + sequence.
 * Returns null if the format doesn't match REIK-YYYY-NNNNN.
 */
export function parseInvoiceNumber(invoiceNumber: string): { year: number; sequence: number } | null {
  const match = invoiceNumber.match(/^REIK-(\d{4})-(\d{5})$/);
  if (!match) return null;
  return { year: Number(match[1]), sequence: Number(match[2]) };
}
