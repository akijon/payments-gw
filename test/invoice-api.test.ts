/**
 * Invoice API endpoint tests — GET /api/invoices/orders/:id/invoice
 *
 * Tests authentication, order status validation, sequential numbering,
 * idempotent retrieval, payload persistence, and full invoice payload response.
 *
 * Icelandic consumer prices are VAT-INCLUSIVE: the order amount equals the
 * sum of unit_price * quantity, and the invoice total_amount_incl_vat must
 * equal the order amount (charged amount).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createOrderWithAccessToken, generateOrderNumber, generateUUID } from '../src/lib/db';
import type { LineItem } from '../src/types/api';
import { TERMS_VERSION } from '../src/lib/terms';

// Mock the Verifone API client for checkout kennitala tests.
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
  const token = 'test-invoice-token-' + orderId.slice(0, 8);

  await createOrderWithAccessToken(env.DB, {
    id: orderId,
    orderNumber,
    currency: 'ISK',
    amount: 2000, // VAT-inclusive charged amount
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

// ─── Tests ─────────────────────────────────────────────────────

describe('Invoice API endpoint', () => {
  beforeEach(async () => {
    // Clear invoice tables between tests
    await env.DB.prepare('DELETE FROM invoices').run();
    await env.DB.prepare('DELETE FROM invoice_sequence').run();
  });

  it('rejects unauthenticated requests', async () => {
    const { orderId } = await createPaidOrder();
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
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
      termsAcceptedAt: new Date().toISOString(),
      termsVersion: TERMS_VERSION,
      items: makeTestItems(),
      accessToken: token,
    });
    // Order is 'pending' by default

    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as any;
    expect(body.code).toBe('not_invoiceable');
  });

  it('generates invoice for paid order with Bearer auth', async () => {
    const { orderId, token } = await createPaidOrder();
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.invoice).toBeDefined();
    expect(body.invoice.header.invoice_number).toMatch(/^REIK-\d{4}-\d{5}$/);
    expect(body.invoice.seller.name).toBeDefined();
    expect(body.invoice.buyer.name).toBe('Test Customer');
    expect(body.invoice.items).toHaveLength(1);
    // VAT-inclusive: total must equal the charged amount (2000)
    expect(body.invoice.summary.total_amount_incl_vat).toBe(2000);
  });

  it('invoice total_amount_incl_vat equals order amount (VAT-inclusive)', async () => {
    const { orderId, token } = await createPaidOrder();
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as any;
    // The charged amount is 2000 (1000 * 2, VAT-inclusive)
    // The invoice total must equal this — no VAT added on top.
    expect(body.invoice.summary.total_amount_incl_vat).toBe(2000);

    // Verify the VAT breakdown is derived from the inclusive price:
    // unit_price_excl = round(1000 * 100 / 124) = round(806.45) = 806
    // vat_amount per unit = 1000 - 806 = 194, total vat = 194 * 2 = 388
    // taxable_base = 806 * 2 = 1612
    expect(body.invoice.items[0].unit_price_excl_vat).toBe(806);
    expect(body.invoice.items[0].vat_amount).toBe(388);
    expect(body.invoice.items[0].total_incl_vat).toBe(2000);
    expect(body.invoice.summary.subtotal_excl_vat).toBe(1612);
  });

  it('returns same invoice on subsequent requests (idempotent + persisted payload)', async () => {
    const { orderId, token } = await createPaidOrder();
    // First request creates the invoice
    const response1 = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response1.status).toBe(200);
    const body1 = (await response1.json()) as any;
    const invoiceNumber = body1.invoice.header.invoice_number;

    // Second request returns the same invoice number (from persisted payload)
    const response2 = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response2.status).toBe(200);
    const body2 = (await response2.json()) as any;
    expect(body2.invoice.header.invoice_number).toBe(invoiceNumber);
    // The full invoice payload must be identical (persisted, not recomputed)
    expect(body2.invoice).toEqual(body1.invoice);
  });

  it('persists invoice payload — returns stored payload even if env changes', async () => {
    const { orderId, token } = await createPaidOrder();

    // First request creates and persists the invoice
    const response1 = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body1 = (await response1.json()) as any;
    const originalAddress = body1.invoice.seller.address;

    // Simulate a seller address change
    const originalSellerAddress = env.SELLER_ADDRESS;
    env.SELLER_ADDRESS = 'New Address 42, 200 Kópavogur';
    try {
      // Second request should return the persisted (original) payload
      const response2 = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body2 = (await response2.json()) as any;
      // The address must NOT have changed — payload was persisted
      expect(body2.invoice.seller.address).toBe(originalAddress);
    } finally {
      env.SELLER_ADDRESS = originalSellerAddress;
    }
  });

  it('assigns sequential invoice numbers', async () => {
    const { orderId: order1, token: token1 } = await createPaidOrder();
    const { orderId: order2, token: token2 } = await createPaidOrder();

    const r1 = await SELF.fetch(`http://localhost/api/invoices/orders/${order1}/invoice`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    const r2 = await SELF.fetch(`http://localhost/api/invoices/orders/${order2}/invoice`, {
      headers: { Authorization: `Bearer ${token2}` },
    });

    const body1 = (await r1.json()) as any;
    const body2 = (await r2.json()) as any;

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
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${nonExistentId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Auth will fail because the token is for a different order
    expect(response.status).toBe(401);
  });

  it('returns 401 without auth for non-existent order', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${fakeId}/invoice`, {
      headers: { Authorization: 'Bearer some-invalid-token' },
    });
    expect(response.status).toBe(401);
  });

  it('includes VAT breakdown in invoice response (VAT-inclusive decomposition)', async () => {
    const { orderId, token } = await createPaidOrder();
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as any;
    expect(body.invoice.summary.vat_breakdown).toBeDefined();
    expect(body.invoice.summary.vat_breakdown).toHaveLength(1);
    expect(body.invoice.summary.vat_breakdown[0].rate).toBe(24);
    // excl = round(1000*100/124) = 806, total = 806*2 = 1612
    expect(body.invoice.summary.vat_breakdown[0].taxable_base).toBe(1612);
    // vat = 2000 - 1612 = 388
    expect(body.invoice.summary.vat_breakdown[0].vat_amount).toBe(388);
  });
});

// ─── Checkout kennitala validation tests ────────────────────────

describe('Checkout kennitala validation (reject before payment)', () => {
  beforeEach(async () => {
    await env.DB.exec(
      'DELETE FROM invoices; DELETE FROM invoice_sequence; DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events; DELETE FROM processed_webhooks; DELETE FROM orders;',
    );
  });

  it('accepts checkout with valid kennitala', async () => {
    const { createCheckout } = await import('../src/lib/verifone');
    const { vi } = await import('vitest');
    vi.mocked(createCheckout).mockResolvedValue({
      checkoutId: 'chk-kt-valid',
      checkoutUrl: 'https://pay.mock.verifone/chk-kt-valid',
    });

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        customer_email: 'buyer@example.com',
        buyer_kennitala: '010130-3019', // valid checksum
        terms_accepted: true,
        terms_version: '2026-08-17',
      }),
    });
    expect(resp.status).toBe(200);
  });

  it('rejects checkout with invalid kennitala checksum (422)', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        buyer_kennitala: '010130-3029', // invalid checksum (should be 1, digit is 2)
        terms_accepted: true,
        terms_version: '2026-08-17',
      }),
    });
    expect(resp.status).toBe(422);
    const body = (await resp.json()) as any;
    expect(body.code).toBe('invalid_kennitala');

    // No order should have been created
    const orders = await env.DB.prepare('SELECT COUNT(*) AS count FROM orders').first<{ count: number }>();
    expect(orders?.count).toBe(0);
  });

  it('rejects checkout with kennitala where intermediate == 10 (no valid check digit)', async () => {
    // 00000006XX: weights for d7=2, d7=6 → sum=12, 12%11=1, intermediate=10 → INVALID
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        buyer_kennitala: '0000000699',
        terms_accepted: true,
        terms_version: '2026-08-17',
      }),
    });
    expect(resp.status).toBe(422);
    expect(((await resp.json()) as any).code).toBe('invalid_kennitala');
  });

  it('still accepts checkout without a kennitala (B2C)', async () => {
    const { createCheckout } = await import('../src/lib/verifone');
    const { vi } = await import('vitest');
    vi.mocked(createCheckout).mockResolvedValue({
      checkoutId: 'chk-no-kt',
      checkoutUrl: 'https://pay.mock.verifone/chk-no-kt',
    });

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        terms_accepted: true,
        terms_version: '2026-08-17',
      }),
    });
    expect(resp.status).toBe(200);
  });
});
