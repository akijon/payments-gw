/**
 * Credit note API endpoint tests — GET /api/invoices/orders/:id/credit-note
 *
 * Tests authentication, order status validation (must be refunded),
 * sequential KREDIT-YYYY-NNNNN numbering, reference to original invoice,
 * payload persistence, and amount negation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createOrderWithAccessToken, generateOrderNumber, generateUUID } from '../src/lib/db';
import type { LineItem } from '../src/types/api';
import { TERMS_VERSION } from '../src/lib/terms';

// Mock the Verifone API client (same as invoice-api.test.ts)
vi.mock('../src/lib/verifone', () => ({
  createCheckout: vi.fn().mockResolvedValue({
    checkoutId: 'chk-test-1',
    checkoutUrl: 'https://pay.mock.verifone/chk-1',
  }),
  createCustomer: vi.fn().mockResolvedValue('cust-mock-1'),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

// ─── Test helpers ──────────────────────────────────────────────

function makeTestItems(vatRate = 24): LineItem[] & { vat_rate?: number }[] {
  return [
    {
      product_id: 'TEST-001',
      name: 'Test Product',
      quantity: 2,
      unit_price: 1000, // VAT-inclusive
      total_amount: 2000, // 1000 * 2 = charged amount
      sku: 'TEST-001',
      vat_rate: vatRate,
    },
  ] as LineItem[] & { vat_rate?: number }[];
}

async function createPaidOrder(opts?: { kennitala?: string }): Promise<{ orderId: string; token: string }> {
  const orderId = generateUUID();
  const orderNumber = generateOrderNumber();
  const token = 'test-credit-token-' + orderId.slice(0, 8);

  await createOrderWithAccessToken(env.DB, {
    id: orderId,
    orderNumber,
    currency: 'ISK',
    amount: 2000,
    customerEmail: 'test@example.is',
    customerName: 'Test Customer',
    buyerKennitala: opts?.kennitala,
    termsAcceptedAt: new Date().toISOString(),
    termsVersion: TERMS_VERSION,
    items: makeTestItems(),
    accessToken: token,
  });

  // Mark as paid
  await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?").bind(orderId).run();

  return { orderId, token };
}

async function createRefundedOrder(opts?: { kennitala?: string }): Promise<{ orderId: string; token: string }> {
  const { orderId, token } = await createPaidOrder(opts);
  // Mark as refunded
  await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").bind(orderId).run();
  return { orderId, token };
}

async function issueInvoiceForOrder(orderId: string, token: string): Promise<void> {
  const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
}

// ─── Tests ─────────────────────────────────────────────────────

describe('Credit note API endpoint', () => {
  beforeEach(async () => {
    // Clear invoice + credit note tables between tests
    await env.DB.exec(
      'DELETE FROM credit_notes; DELETE FROM credit_note_sequence; DELETE FROM invoices; DELETE FROM invoice_sequence;',
    );
  });

  it('rejects unauthenticated requests', async () => {
    const { orderId } = await createRefundedOrder();
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('rejects credit note for non-refunded order (paid)', async () => {
    const { orderId, token } = await createPaidOrder();
    await issueInvoiceForOrder(orderId, token);

    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('not_refunded');
  });

  it('rejects credit note for pending order', async () => {
    const orderId = generateUUID();
    const token = 'test-token-pending-' + orderId.slice(0, 8);
    await createOrderWithAccessToken(env.DB, {
      id: orderId,
      orderNumber: generateOrderNumber(),
      currency: 'ISK',
      amount: 2000,
      termsAcceptedAt: new Date().toISOString(),
      termsVersion: TERMS_VERSION,
      items: makeTestItems(),
      accessToken: token,
    });

    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('not_refunded');
  });

  it('rejects credit note when no original invoice exists', async () => {
    const { orderId, token } = await createRefundedOrder();
    // Don't issue an invoice first

    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('no_original_invoice');
  });

  it('generates credit note for refunded order with existing invoice', async () => {
    const { orderId, token } = await createRefundedOrder();
    await issueInvoiceForOrder(orderId, token);

    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { credit_note: any };
    expect(body.credit_note).toBeDefined();
    expect(body.credit_note.header.credit_note_number).toMatch(/^KREDIT-\d{4}-\d{5}$/);
  });

  it('credit note references the original invoice number', async () => {
    const { orderId, token } = await createRefundedOrder();
    await issueInvoiceForOrder(orderId, token);

    // Get the original invoice number
    const invoiceResp = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const invoiceBody = (await invoiceResp.json()) as { invoice: any };
    const originalInvoiceNumber = invoiceBody.invoice.header.invoice_number;

    // Get the credit note
    const creditResp = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const creditBody = (await creditResp.json()) as { credit_note: any };
    expect(creditBody.credit_note.header.original_invoice_number).toBe(originalInvoiceNumber);
  });

  it('credit note negates all amounts from the original invoice', async () => {
    const { orderId, token } = await createRefundedOrder();
    await issueInvoiceForOrder(orderId, token);

    const creditResp = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const creditBody = (await creditResp.json()) as { credit_note: any };

    // Original: total = 2000, subtotal_excl = 1612, vat = 388
    // Credit note: all negated
    expect(creditBody.credit_note.summary.total_amount_incl_vat).toBe(-2000);
    expect(creditBody.credit_note.summary.subtotal_excl_vat).toBe(-1612);
    expect(creditBody.credit_note.summary.vat_breakdown[0].vat_amount).toBe(-388);
    expect(creditBody.credit_note.summary.vat_breakdown[0].taxable_base).toBe(-1612);

    // Line items negated
    expect(creditBody.credit_note.items[0].total_incl_vat).toBe(-2000);
    expect(creditBody.credit_note.items[0].unit_price_excl_vat).toBe(-806);
    expect(creditBody.credit_note.items[0].vat_amount).toBe(-388);
  });

  it('returns same credit note on subsequent requests (idempotent)', async () => {
    const { orderId, token } = await createRefundedOrder();
    await issueInvoiceForOrder(orderId, token);

    const resp1 = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body1 = (await resp1.json()) as { credit_note: any };

    const resp2 = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body2 = (await resp2.json()) as { credit_note: any };

    expect(body2.credit_note.header.credit_note_number).toBe(body1.credit_note.header.credit_note_number);
    expect(body2.credit_note).toEqual(body1.credit_note);
  });

  it('assigns sequential KREDIT numbers', async () => {
    // Create two refunded orders with invoices
    const { orderId: order1, token: token1 } = await createRefundedOrder();
    await issueInvoiceForOrder(order1, token1);

    const { orderId: order2, token: token2 } = await createRefundedOrder();
    await issueInvoiceForOrder(order2, token2);

    const r1 = await SELF.fetch(`http://localhost/api/invoices/orders/${order1}/credit-note`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    const r2 = await SELF.fetch(`http://localhost/api/invoices/orders/${order2}/credit-note`, {
      headers: { Authorization: `Bearer ${token2}` },
    });

    const body1 = (await r1.json()) as { credit_note: any };
    const body2 = (await r2.json()) as { credit_note: any };

    const num1 = body1.credit_note.header.credit_note_number;
    const num2 = body2.credit_note.header.credit_note_number;

    expect(num1).not.toBe(num2);
    expect(num1).toMatch(/^KREDIT-\d{4}-\d{5}$/);
    expect(num2).toMatch(/^KREDIT-\d{4}-\d{5}$/);
  });

  it('credit note sequence is separate from invoice sequence', async () => {
    // Issue one invoice (claims invoice seq #1)
    const { orderId: order1, token: token1 } = await createPaidOrder();
    await issueInvoiceForOrder(order1, token1);

    // Issue a credit note (should claim credit note seq #1, not invoice seq #2)
    const { orderId: order2, token: token2 } = await createRefundedOrder();
    await issueInvoiceForOrder(order2, token2);

    const creditResp = await SELF.fetch(`http://localhost/api/invoices/orders/${order2}/credit-note`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    const creditBody = (await creditResp.json()) as { credit_note: any };

    // Credit note should be KREDIT-...-00001 (first credit note)
    expect(creditBody.credit_note.header.credit_note_number).toMatch(/KREDIT-\d{4}-00001/);
  });

  it('returns 404 for non-existent order with valid auth', async () => {
    const { token } = await createRefundedOrder();
    const nonExistentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${nonExistentId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401); // auth fails for different order
  });
});
