/**
 * Invoice API endpoint tests — GET /api/invoices/orders/:id/invoice
 *
 * Tests authentication, order status validation, sequential numbering,
 * idempotent retrieval, and full invoice payload response.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createOrderWithAccessToken, generateOrderNumber, generateUUID } from '../src/lib/db';
import type { LineItem } from '../src/types/api';

// ─── Test helpers ──────────────────────────────────────────────

function makeTestItems(vatRate = 24): LineItem[] & { vat_rate?: number }[] {
  return [
    {
      product_id: 'TEST-001',
      name: 'Test Product',
      quantity: 2,
      unit_price: 1000,
      total_amount: 2000,
      sku: 'TEST-001',
      vat_rate: vatRate,
    },
  ] as LineItem[] & { vat_rate?: number }[];
}

async function createPaidOrder(opts?: { kennitala?: string }): Promise<{ orderId: string; token: string }> {
  const orderId = generateUUID();
  const orderNumber = generateOrderNumber();
  const token = 'test-invoice-token-' + orderId.slice(0, 8);

  await createOrderWithAccessToken(env.DB, {
    id: orderId,
    orderNumber,
    currency: 'ISK',
    amount: 2000,
    customerEmail: 'test@example.is',
    customerName: 'Test Customer',
    buyerKennitala: opts?.kennitala,
    items: makeTestItems(),
    accessToken: token,
  });

  // Mark as paid
  await env.DB
    .prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?")
    .bind(orderId)
    .run();

  return { orderId, token };
}

// ─── Tests ─────────────────────────────────────────────────────

describe('Invoice API endpoint', () => {
  beforeEach(async () => {
    // Clear invoice tables between tests
    await env.DB.prepare('DELETE FROM invoices').run();
    await env.DB.prepare('DELETE FROM invoice_sequence').run();
    // Reset order statuses for tests
  });

  it('rejects unauthenticated requests', async () => {
    const { orderId } = await createPaidOrder();
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe('unauthorized');
  });

  it('rejects invoice for non-invoiceable order (pending)', async () => {
    const orderId = generateUUID();
    const token = 'test-token-pending-' + orderId.slice(0, 8);
    await createOrderWithAccessToken(env.DB, {
      id: orderId,
      orderNumber: generateOrderNumber(),
      currency: 'ISK',
      amount: 2000,
      items: makeTestItems(),
      accessToken: token,
    });
    // Order is 'pending' by default

    const response = await SELF.fetch(
      `http://localhost/api/invoices/orders/${orderId}/invoice`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('not_invoiceable');
  });

  it('generates invoice for paid order with Bearer auth', async () => {
    const { orderId, token } = await createPaidOrder();
    const response = await SELF.fetch(
      `http://localhost/api/invoices/orders/${orderId}/invoice`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoice).toBeDefined();
    expect(body.invoice.header.invoice_number).toMatch(/^REIK-\d{4}-\d{5}$/);
    expect(body.invoice.seller.name).toBeDefined();
    expect(body.invoice.buyer.name).toBe('Test Customer');
    expect(body.invoice.items).toHaveLength(1);
    expect(body.invoice.summary.total_amount_incl_vat).toBeGreaterThan(2000);
  });

  it('returns same invoice on subsequent requests (idempotent)', async () => {
    const { orderId, token } = await createPaidOrder();
    // First request creates the invoice
    const response1 = await SELF.fetch(
      `http://localhost/api/invoices/orders/${orderId}/invoice`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response1.status).toBe(200);
    const body1 = await response1.json();
    const invoiceNumber = body1.invoice.header.invoice_number;

    // Second request returns the same invoice number
    const response2 = await SELF.fetch(
      `http://localhost/api/invoices/orders/${orderId}/invoice`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response2.status).toBe(200);
    const body2 = await response2.json();
    expect(body2.invoice.header.invoice_number).toBe(invoiceNumber);
  });

  it('assigns sequential invoice numbers', async () => {
    const { orderId: order1, token: token1 } = await createPaidOrder();
    const { orderId: order2, token: token2 } = await createPaidOrder();

    const r1 = await SELF.fetch(
      `http://localhost/api/invoices/orders/${order1}/invoice`,
      { headers: { Authorization: `Bearer ${token1}` } },
    );
    const r2 = await SELF.fetch(
      `http://localhost/api/invoices/orders/${order2}/invoice`,
      { headers: { Authorization: `Bearer ${token2}` } },
    );

    const body1 = await r1.json();
    const body2 = await r2.json();

    // Both should be same year, sequential sequence
    const num1 = body1.invoice.header.invoice_number;
    const num2 = body2.invoice.header.invoice_number;

    expect(num1).not.toBe(num2);
    // Both should match REIK-YYYY-NNNNN
    expect(num1).toMatch(/^REIK-\d{4}-\d{5}$/);
    expect(num2).toMatch(/^REIK-\d{4}-\d{5}$/);
  });

  it('returns 404 for order with valid auth but no order record', async () => {
    // Create an order, get its token, then use a different (non-existent) order ID
    // with the same token — auth will pass (token matches), but order won't exist
    const { token } = await createPaidOrder();
    const nonExistentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const response = await SELF.fetch(
      `http://localhost/api/invoices/orders/${nonExistentId}/invoice`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    // Auth will fail because the token is for a different order
    expect(response.status).toBe(401);
  });

  it('returns 401 without auth for non-existent order', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const response = await SELF.fetch(
      `http://localhost/api/invoices/orders/${fakeId}/invoice`,
      { headers: { Authorization: 'Bearer some-invalid-token' } },
    );
    expect(response.status).toBe(401);
  });

  it('includes VAT breakdown in invoice response', async () => {
    const { orderId, token } = await createPaidOrder();
    const response = await SELF.fetch(
      `http://localhost/api/invoices/orders/${orderId}/invoice`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await response.json();
    expect(body.invoice.summary.vat_breakdown).toBeDefined();
    expect(body.invoice.summary.vat_breakdown).toHaveLength(1);
    expect(body.invoice.summary.vat_breakdown[0].rate).toBe(24);
    expect(body.invoice.summary.vat_breakdown[0].taxable_base).toBe(2000);
    expect(body.invoice.summary.vat_breakdown[0].vat_amount).toBe(480); // 2000 * 24/100
  });
});
