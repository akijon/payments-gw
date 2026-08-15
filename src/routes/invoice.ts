/**
 * Invoice route — GET /api/orders/:id/invoice
 *
 * Generates or retrieves an Icelandic invoice (sölureikningur) for a paid order.
 * Requires Bearer auth (same order_status_token as order polling).
 *
 * Only orders with status 'paid', 'settled', or 'refunded' can have invoices.
 * The invoice is generated lazily on first request — sequential numbering is
 * claimed atomically to prevent gaps or duplicates.
 *
 * On first creation, the full computed invoice JSON is persisted in the
 * `payload_json` column and returned on all subsequent requests, so a seller
 * address change or other env mutation does not retroactively alter a
 * previously issued invoice.
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import type { VatLineItem, Invoice, CreditNote } from '../types/invoice';
import { bearerToken } from '../lib/http';

export const invoiceRoute = new Hono<{ Bindings: Env }>();

invoiceRoute.get('/orders/:id/invoice', async (c) => {
  const orderId = c.req.param('id');
  const { getOrderById, hasOrderAccess, generateUUID } = await import('../lib/db');
  const accessToken = bearerToken(c.req.header('Authorization'));

  if (!(await hasOrderAccess(c.env.DB, orderId, accessToken))) {
    return c.json({ error: 'Valid bearer token required', code: 'unauthorized' }, 401, {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Bearer',
    });
  }

  const order = await getOrderById(c.env.DB, orderId);
  if (!order) {
    return c.json({ error: 'Order not found' }, 404, { 'Cache-Control': 'no-store' });
  }

  // Only invoiceable statuses can produce an invoice
  const invoiceable = ['paid', 'settled', 'refunded'];
  if (!invoiceable.includes(order.status)) {
    return c.json({ error: 'Order is not invoiceable', code: 'not_invoiceable', order_status: order.status }, 409, {
      'Cache-Control': 'no-store',
    });
  }

  // Check if an invoice already exists
  const { getInvoiceByOrderId, createInvoiceRecord, claimVerifiedInvoiceNumber } = await import('../lib/invoice-db');
  const existing = await getInvoiceByOrderId(c.env.DB, orderId);

  // ── Existing invoice: return the persisted payload ──────────────
  // The invoice was stored on first creation. Return it as-is so that
  // later env mutations (seller address, etc.) don't alter it.
  if (existing && existing.status === 'issued') {
    if (existing.payload_json) {
      try {
        const storedInvoice = JSON.parse(existing.payload_json) as Invoice;
        return c.json({ invoice: storedInvoice }, 200, { 'Cache-Control': 'no-store' });
      } catch {
        // Corrupt payload — fall through to recompute (shouldn't happen)
      }
    }
    // No payload stored (legacy) — recompute from current state
    return recomputeInvoice(c, order, existing.invoice_number, existing.issue_date);
  }

  // ── New invoice: claim a sequence number and persist ────────────
  // Get seller info
  const { getSellerInfo } = await import('../lib/seller');
  const seller = getSellerInfo(c.env);
  if (!seller) {
    return c.json({ error: 'Seller identity not configured', code: 'seller_not_configured' }, 503, {
      'Cache-Control': 'no-store',
    });
  }

  // Validate buyer kennitala if provided (B2B requirement)
  const { isValidKennitala, formatKennitala, computeInvoice, buildInvoiceNumber } =
    await import('../lib/invoice-computation');
  const buyerKennitala = order.buyer_kennitala;
  if (buyerKennitala && !isValidKennitala(buyerKennitala)) {
    return c.json({ error: 'Invalid buyer kennitala', code: 'invalid_kennitala' }, 422, {
      'Cache-Control': 'no-store',
    });
  }

  // Build buyer info
  const buyer = {
    name: order.customer_name ?? 'Viðskiptavinur',
    kennitala: formatKennitala(buyerKennitala) ?? undefined,
    email: order.customer_email,
  };

  const now = new Date();
  const year = now.getUTCFullYear();
  const issueDate = now.toISOString().slice(0, 10);
  const vatItems = order.items.map((item) => ({
    ...item,
    vat_rate: (item as { vat_rate?: number }).vat_rate ?? 24,
  })) as VatLineItem[];
  // Shipping must appear as its own line, not just as a number the pricing
  // gate reconciles against — otherwise a charge that includes shipping
  // finalizes correctly but the persisted document silently omits it (e.g. a
  // 10,990 charge with 990 shipping would compute and persist as 10,000).
  // Standard rate: shipping_incl_vat has no per-order VAT rate of its own
  // (see migration 0014_shipping_cost.sql).
  if (order.shipping_incl_vat > 0) {
    vatItems.push({
      product_id: 'SHIPPING',
      name: 'Sendingarkostnaður',
      quantity: 1,
      unit_price: order.shipping_incl_vat,
      total_amount: order.shipping_incl_vat,
      vat_rate: 24,
    });
  }

  // Reconcile the charge BEFORE claiming a number: an order whose invoice
  // arithmetic does not match the money taken must not consume a sequence
  // number, or a blocked finalization would leave a permanent hole in the
  // series it was refusing to misstate.
  //
  // The number is a placeholder here purely so the totals can be computed; the
  // authoritative payload is recomputed below with the number actually claimed.
  const draft = computeInvoice({
    items: vatItems,
    currency: order.currency,
    seller,
    buyer,
    invoiceNumber: buildInvoiceNumber(year, 1),
    issueDate,
    dueDate: null,
    deliveryDate: order.paid_at?.slice(0, 10) ?? issueDate,
  });

  if (!draft) {
    return c.json({ error: 'Failed to compute invoice', code: 'computation_failed' }, 500, {
      'Cache-Control': 'no-store',
    });
  }

  // shipping_incl_vat is NOT passed separately here: it was folded into
  // vatItems above as its own line, so draft.summary already includes it in
  // both subtotal_excl_vat and vat_breakdown. Passing it again would double
  // count it and reject every order that actually charged for shipping.
  const { assertPricingIntegrity, PricingIntegrityError } = await import('../lib/payment-integrity');
  try {
    assertPricingIntegrity({
      chargedAmount: order.amount,
      subtotalExclVat: draft.summary.subtotal_excl_vat,
      totalVat: draft.summary.vat_breakdown.reduce((sum, entry) => sum + entry.vat_amount, 0),
      shippingInclVat: 0,
    });
  } catch (error) {
    if (error instanceof PricingIntegrityError) {
      return c.json(
        { error: 'Invoice does not reconcile with the charged amount', code: error.code, details: error.details },
        409,
        {
          'Cache-Control': 'no-store',
        },
      );
    }
    throw error;
  }

  // Claim invoice number atomically.
  // Refuse to append a number onto an already-broken series. A gap cannot be
  // repaired by retrying, so this is a hard stop rather than a queued retry.
  let seq: number;
  try {
    seq = await claimVerifiedInvoiceNumber(c.env.DB, year);
  } catch (error) {
    const { SequenceIntegrityError } = await import('../lib/sequence-management');
    if (error instanceof SequenceIntegrityError) {
      return c.json(
        { error: 'Invoice sequence integrity check failed', code: error.code, details: error.details },
        409,
        {
          'Cache-Control': 'no-store',
        },
      );
    }
    throw error;
  }
  const invoiceNumber = buildInvoiceNumber(year, seq);

  // Recompute with the claimed number — same inputs as the reconciled draft,
  // so the totals verified above are the totals persisted here.
  const invoice = computeInvoice({
    items: vatItems,
    currency: order.currency,
    seller,
    buyer,
    invoiceNumber,
    issueDate,
    dueDate: null,
    deliveryDate: order.paid_at?.slice(0, 10) ?? issueDate,
  });

  if (!invoice) {
    return c.json({ error: 'Failed to compute invoice', code: 'computation_failed' }, 500, {
      'Cache-Control': 'no-store',
    });
  }

  // Persist invoice record with the computed payload
  // INSERT OR IGNORE handles the concurrency race: if two requests race to
  // create the first invoice for the same order, only one insert succeeds.
  // The loser's insert is silently ignored (inserted=false); it must re-read
  // the existing record and return that instead.
  const payloadJson = JSON.stringify(invoice);
  const { computeAuditHash, computeRetentionDate } = await import('../lib/invoice-db');
  const auditHash = await computeAuditHash(payloadJson);
  const retentionUntil = computeRetentionDate(issueDate);

  const { inserted } = await createInvoiceRecord(c.env.DB, {
    id: generateUUID(),
    orderId,
    invoiceNumber,
    issueDate,
    dueDate: null, // Immediate payment — B2C receipt
    deliveryDate: order.paid_at?.slice(0, 10) ?? issueDate,
    buyerKennitala: formatKennitala(buyerKennitala),
    payloadJson,
    auditHash,
    retentionUntil,
  });

  if (!inserted) {
    // A concurrent request won the race — re-read and return the existing
    // invoice instead of erroring. This makes lookup-and-create atomic.
    const raced = await getInvoiceByOrderId(c.env.DB, orderId);
    if (raced && raced.payload_json) {
      try {
        const storedInvoice = JSON.parse(raced.payload_json) as Invoice;
        return c.json({ invoice: storedInvoice }, 200, { 'Cache-Control': 'no-store' });
      } catch {
        // Corrupt payload — fall through to recompute
      }
    }
    // Fallback: recompute from the existing record's number/date
    if (raced) {
      return recomputeInvoice(c, order, raced.invoice_number, raced.issue_date);
    }
  }

  return c.json({ invoice }, 200, { 'Cache-Control': 'no-store' });
});

// ─── Credit note (kreditreikningur) ──────────────────────────────

/**
 * GET /api/orders/:id/credit-note
 *
 * Generates or retrieves an Icelandic credit note (kreditreikningur) for a
 * refunded order. Requires Bearer auth (same order_status_token).
 *
 * A credit note reverses the previously issued invoice (sölureikningur):
 * - Only orders with status 'refunded' can produce a credit note
 * - An invoice must have been issued first (the original invoice is
 *   retrieved and its amounts are negated)
 * - Uses a separate KREDIT-YYYY-NNNNN sequence (does not gap the invoice seq)
 * - References the original REIK-YYYY-NNNNN number in the header
 *
 * Legal basis: Reglugerð nr. 505/2013, Lög um reikningshald nr. 145/1994.
 */
invoiceRoute.get('/orders/:id/credit-note', async (c) => {
  const orderId = c.req.param('id');
  const { getOrderById, hasOrderAccess, generateUUID } = await import('../lib/db');
  const accessToken = bearerToken(c.req.header('Authorization'));

  if (!(await hasOrderAccess(c.env.DB, orderId, accessToken))) {
    return c.json({ error: 'Valid bearer token required', code: 'unauthorized' }, 401, {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Bearer',
    });
  }

  const order = await getOrderById(c.env.DB, orderId);
  if (!order) {
    return c.json({ error: 'Order not found' }, 404, { 'Cache-Control': 'no-store' });
  }

  // Only refunded orders can produce a credit note
  if (order.status !== 'refunded') {
    return c.json({ error: 'Order is not refunded', code: 'not_refunded', order_status: order.status }, 409, {
      'Cache-Control': 'no-store',
    });
  }

  // Check if a credit note already exists
  const { getCreditNoteByOrderId, createCreditNoteRecord, nextCreditNoteNumber } =
    await import('../lib/credit-note-db');
  const existing = await getCreditNoteByOrderId(c.env.DB, orderId);

  if (existing && existing.status === 'issued') {
    if (existing.payload_json) {
      try {
        const storedCreditNote = JSON.parse(existing.payload_json) as CreditNote;
        return c.json({ credit_note: storedCreditNote }, 200, { 'Cache-Control': 'no-store' });
      } catch {
        // Corrupt payload — fall through to recompute (shouldn't happen)
      }
    }
  }

  // Retrieve the original invoice — a credit note must reference it
  const { getInvoiceByOrderId } = await import('../lib/invoice-db');
  const invoiceRecord = await getInvoiceByOrderId(c.env.DB, orderId);

  if (!invoiceRecord || !invoiceRecord.payload_json) {
    return c.json({ error: 'No invoice found to credit', code: 'no_original_invoice' }, 409, {
      'Cache-Control': 'no-store',
    });
  }

  let originalInvoice: Invoice;
  try {
    originalInvoice = JSON.parse(invoiceRecord.payload_json) as Invoice;
  } catch {
    return c.json({ error: 'Original invoice payload is corrupt', code: 'corrupt_original' }, 500, {
      'Cache-Control': 'no-store',
    });
  }

  // Claim credit note number atomically (separate sequence from invoices)
  const { computeCreditNote, buildCreditNoteNumber } = await import('../lib/invoice-computation');
  const now = new Date();
  const year = now.getUTCFullYear();
  const seq = await nextCreditNoteNumber(c.env.DB, year);
  const creditNoteNumber = buildCreditNoteNumber(year, seq);
  const issueDate = now.toISOString().slice(0, 10);

  const creditNote = computeCreditNote(originalInvoice, creditNoteNumber, issueDate);

  if (!creditNote) {
    return c.json({ error: 'Failed to compute credit note', code: 'computation_failed' }, 500, {
      'Cache-Control': 'no-store',
    });
  }

  // Persist credit note record with the computed payload
  const buyerKennitala = invoiceRecord.buyer_kennitala;
  const creditPayloadJson = JSON.stringify(creditNote);
  const { computeAuditHash, computeRetentionDate } = await import('../lib/invoice-db');
  const creditAuditHash = await computeAuditHash(creditPayloadJson);
  const creditRetentionUntil = computeRetentionDate(issueDate);

  const { inserted } = await createCreditNoteRecord(c.env.DB, {
    id: generateUUID(),
    orderId,
    creditNoteNumber,
    originalInvoiceNumber: originalInvoice.header.invoice_number,
    issueDate,
    buyerKennitala,
    payloadJson: creditPayloadJson,
    auditHash: creditAuditHash,
    retentionUntil: creditRetentionUntil,
  });

  if (!inserted) {
    // A concurrent request won the race — re-read and return the existing credit note
    const raced = await getCreditNoteByOrderId(c.env.DB, orderId);
    if (raced && raced.payload_json) {
      try {
        const storedCreditNote = JSON.parse(raced.payload_json) as CreditNote;
        return c.json({ credit_note: storedCreditNote }, 200, { 'Cache-Control': 'no-store' });
      } catch {
        // Corrupt payload — fall through
      }
    }
  }

  return c.json({ credit_note: creditNote }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * Recompute the invoice from the current env/order state using an existing
 * invoice number and issue date. Used as a fallback for legacy records that
 * have no persisted payload_json.
 */
async function recomputeInvoice(
  c: { env: Env; json: (body: unknown, status: number, headers?: Record<string, string>) => Response },
  order: {
    items: unknown[];
    currency: string;
    buyer_kennitala?: string;
    customer_name?: string;
    customer_email?: string;
    paid_at?: string | null;
  },
  invoiceNumber: string,
  issueDate: string,
): Promise<Response> {
  const { getSellerInfo } = await import('../lib/seller');
  const { isValidKennitala, formatKennitala, computeInvoice } = await import('../lib/invoice-computation');

  const seller = getSellerInfo(c.env);
  if (!seller) {
    return c.json({ error: 'Seller identity not configured', code: 'seller_not_configured' }, 503, {
      'Cache-Control': 'no-store',
    });
  }

  const buyerKennitala = order.buyer_kennitala;
  if (buyerKennitala && !isValidKennitala(buyerKennitala)) {
    return c.json({ error: 'Invalid buyer kennitala', code: 'invalid_kennitala' }, 422, {
      'Cache-Control': 'no-store',
    });
  }

  const buyer = {
    name: order.customer_name ?? 'Viðskiptavinur',
    kennitala: formatKennitala(buyerKennitala) ?? undefined,
    email: order.customer_email ?? undefined,
  };

  const invoice = computeInvoice({
    items: (order.items as Record<string, unknown>[]).map((item) => ({
      ...item,
      vat_rate: (item as { vat_rate?: number }).vat_rate ?? 24,
    })) as VatLineItem[],
    currency: order.currency,
    seller,
    buyer,
    invoiceNumber,
    issueDate,
    dueDate: null,
    deliveryDate: order.paid_at?.slice(0, 10) ?? issueDate,
  });

  if (!invoice) {
    return c.json({ error: 'Failed to compute invoice', code: 'computation_failed' }, 500, {
      'Cache-Control': 'no-store',
    });
  }

  return c.json({ invoice }, 200, { 'Cache-Control': 'no-store' });
}
