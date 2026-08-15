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
import type { VatLineItem, Invoice } from '../types/invoice';
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
    return c.json(
      { error: 'Order is not invoiceable', code: 'not_invoiceable', order_status: order.status },
      409,
      { 'Cache-Control': 'no-store' },
    );
  }

  // Check if an invoice already exists
  const { getInvoiceByOrderId, createInvoiceRecord, nextInvoiceNumber } = await import(
    '../lib/invoice-db'
  );
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
  const { isValidKennitala, formatKennitala, computeInvoice, buildInvoiceNumber } = await import(
    '../lib/invoice-computation'
  );
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

  // Claim invoice number atomically
  const now = new Date();
  const year = now.getUTCFullYear();
  const seq = await nextInvoiceNumber(c.env.DB, year);
  const invoiceNumber = buildInvoiceNumber(year, seq);
  const issueDate = now.toISOString().slice(0, 10);

  // Compute full invoice payload
  const invoice = computeInvoice({
    items: order.items.map((item) => ({
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

  // Persist invoice record with the computed payload
  // INSERT OR IGNORE handles the concurrency race: if two requests race to
  // create the first invoice for the same order, only one insert succeeds.
  // The loser's insert is silently ignored (inserted=false); it must re-read
  // the existing record and return that instead.
  const { inserted } = await createInvoiceRecord(c.env.DB, {
    id: generateUUID(),
    orderId,
    invoiceNumber,
    issueDate,
    dueDate: null, // Immediate payment — B2C receipt
    deliveryDate: order.paid_at?.slice(0, 10) ?? issueDate,
    buyerKennitala: formatKennitala(buyerKennitala),
    payloadJson: JSON.stringify(invoice),
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
  const { isValidKennitala, formatKennitala, computeInvoice } = await import(
    '../lib/invoice-computation'
  );

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
