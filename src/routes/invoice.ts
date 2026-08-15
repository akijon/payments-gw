/**
 * Invoice route — GET /api/orders/:id/invoice
 *
 * Generates or retrieves an Icelandic invoice (sölureikningur) for a paid order.
 * Requires Bearer auth (same order_status_token as order polling).
 *
 * Only orders with status 'paid', 'settled', or 'refunded' can have invoices.
 * The invoice is generated lazily on first request — sequential numbering is
 * claimed atomically to prevent gaps or duplicates.
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import type { VatLineItem } from '../types/invoice';
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
  const { getInvoiceByOrderId, createInvoiceRecord, nextInvoiceNumber } = await import('../lib/invoice-db');
  const existing = await getInvoiceByOrderId(c.env.DB, orderId);

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

  // Determine the invoice number: reuse existing or claim a new one
  let invoiceNumber: string;
  let issueDate: string;
  if (existing && existing.status === 'issued') {
    invoiceNumber = existing.invoice_number;
    issueDate = existing.issue_date;
  } else {
    // Claim invoice number atomically
    const now = new Date();
    const year = now.getUTCFullYear();
    const seq = await nextInvoiceNumber(c.env.DB, year);
    invoiceNumber = buildInvoiceNumber(year, seq);
    issueDate = now.toISOString().slice(0, 10);

    // Persist invoice record
    await createInvoiceRecord(c.env.DB, {
      id: generateUUID(),
      orderId,
      invoiceNumber,
      issueDate,
      dueDate: null, // Immediate payment — B2C receipt
      deliveryDate: order.paid_at?.slice(0, 10) ?? issueDate,
      buyerKennitala: formatKennitala(buyerKennitala),
    });
  }

  // Compute full invoice payload
  // Items stored in items_json include vat_rate (VatLineItem) for new orders.
  // Legacy orders without vat_rate default to standard 24%.
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

  return c.json({ invoice }, 200, { 'Cache-Control': 'no-store' });
});
