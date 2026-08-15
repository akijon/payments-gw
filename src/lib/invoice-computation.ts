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

import type { VatRate, Invoice, InvoiceLineItem, VatBreakdownEntry, SellerInfo, BuyerInfo, VatLineItem } from '../types/invoice';

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

/**
 * For invoice line items, amounts are in minor units and must be integers.
 * VAT amount per line = round_half_up(unit_price_excl_vat * vat_rate / 100) * quantity
 * But since unit_price is already in aurar, we compute:
 *   vat_amount = round(unit_excl * rate / 100) — aurar-level precision, then × qty
 * Actually: line_vat = round(unit_excl * qty * rate / 100)
 * Icelandic standard: round each line independently to nearest aurar (integer minor units).
 * D1 stores integer minor units, so no fractional aurar exist.
 */
function computeLineVat(unitPriceExclVat: number, quantity: number, vatRate: VatRate): number {
  // unitPriceExclVat and quantity are integers; rate is 0/11/24
  // vat_amount = trunc(unitPriceExclVat * quantity * vatRate / 100)
  // Using Math.round for half-up rounding at aurar level
  return Math.round((unitPriceExclVat * quantity * vatRate) / 100);
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
  const checksum = (11 - (sum % 11)) % 10;
  return checksum === d[8];
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
 * Returns null if items are empty or computation overflows.
 */
export function computeInvoice(input: InvoiceComputationInput): Invoice | null {
  if (input.items.length === 0) return null;

  const lineItems: InvoiceLineItem[] = [];
  let subtotalExclVat = 0;
  const vatBuckets = new Map<VatRate, VatBreakdownEntry>();

  for (const item of input.items) {
    const vatAmount = computeLineVat(item.unit_price, item.quantity, item.vat_rate);
    const totalInclVat = item.total_amount + vatAmount;

    if (!Number.isSafeInteger(totalInclVat) || !Number.isSafeInteger(subtotalExclVat + item.total_amount)) {
      return null; // overflow guard
    }

    subtotalExclVat += item.total_amount;

    // Aggregate into VAT bucket
    const bucket = vatBuckets.get(item.vat_rate);
    if (bucket) {
      bucket.taxable_base += item.total_amount;
      bucket.vat_amount += vatAmount;
    } else {
      vatBuckets.set(item.vat_rate, {
        rate: item.vat_rate,
        taxable_base: item.total_amount,
        vat_amount: vatAmount,
      });
    }

    lineItems.push({
      sku: item.sku ?? item.product_id,
      description: item.name,
      quantity: item.quantity,
      unit_price_excl_vat: item.unit_price,
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

  const totalInclVat = subtotalExclVat + totalVat;
  if (!Number.isSafeInteger(totalInclVat)) return null;

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
      total_amount_incl_vat: totalInclVat,
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
