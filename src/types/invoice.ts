/**
 * Icelandic invoice types — legally compliant sölureikningur.
 *
 * Implements the mandatory fields from Lög um virðisaukaskatt nr. 50/1988
 * and reglugerð nr. 505/2013.
 */

import type { LineItem } from './api';

/** VAT rates recognised in Icelandic tax law. */
export type VatRate = 24 | 11 | 0;

/** Seller identity — all fields legally required on every invoice. */
export interface SellerInfo {
  name: string;
  kennitala: string;
  vsk_number: string;
  address: string;
  email: string;
  phone?: string;
}

/** Buyer identity — kennitala required for B2B, optional for B2C receipts. */
export interface BuyerInfo {
  name: string;
  kennitala?: string;
  address?: string;
  email?: string;
}

/** Line item with VAT breakdown for invoice display. */
export interface InvoiceLineItem {
  sku: string;
  description: string;
  quantity: number;
  unit_price_excl_vat: number; // whole krónur (ISK major units)
  vat_rate: VatRate;
  vat_amount: number; // whole krónur (ISK major units)
  total_incl_vat: number; // whole krónur (ISK major units)
}

/** VAT breakdown by rate. */
export interface VatBreakdownEntry {
  rate: VatRate;
  taxable_base: number; // whole krónur (ISK major units), excl. VAT
  vat_amount: number; // whole krónur (ISK major units)
}

/** Full invoice payload matching the JSON schema. */
export interface Invoice {
  header: {
    invoice_number: string;
    issue_date: string; // YYYY-MM-DD
    due_date: string | null; // YYYY-MM-DD or null
    delivery_date: string | null;
    currency: string; // ISO 4217
  };
  seller: SellerInfo;
  buyer: BuyerInfo;
  items: InvoiceLineItem[];
  summary: {
    subtotal_excl_vat: number;
    vat_breakdown: VatBreakdownEntry[];
    total_amount_incl_vat: number;
  };
}

/** Invoice record as stored in D1. */
export interface InvoiceRecord {
  id: string;
  order_id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  delivery_date: string | null;
  buyer_kennitala: string | null;
  status: 'issued' | 'void' | 'corrected';
  payload_json: string | null;
  audit_hash: string | null;
  retention_until: string | null;
  created_at: string;
}

/**
 * Extended LineItem carrying the VAT rate from the product catalog.
 * This is what invoice computation receives after catalog resolution.
 */
export interface VatLineItem extends LineItem {
  vat_rate: VatRate;
}

/** Credit note record as stored in D1. */
export interface CreditNoteRecord {
  id: string;
  order_id: string;
  credit_note_number: string;
  original_invoice_number: string;
  issue_date: string;
  buyer_kennitala: string | null;
  status: 'issued' | 'void';
  payload_json: string | null;
  audit_hash: string | null;
  retention_until: string | null;
  created_at: string;
}

/**
 * Full credit note payload — an Invoice with an `original_invoice_number`
 * field in the header referencing the sölureikningur being reversed.
 * All line item amounts are negated relative to the original invoice.
 */
export interface CreditNote {
  header: {
    credit_note_number: string;
    original_invoice_number: string;
    issue_date: string; // YYYY-MM-DD
    currency: string; // ISO 4217
  };
  seller: SellerInfo;
  buyer: BuyerInfo;
  items: InvoiceLineItem[];
  summary: {
    subtotal_excl_vat: number; // negative
    vat_breakdown: VatBreakdownEntry[]; // amounts negative
    total_amount_incl_vat: number; // negative
  };
}
