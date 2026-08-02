/**
 * Return route — integration tests via SELF + vi.mock
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

vi.mock('../src/lib/verifone', () => ({
  getVerifoneToken: vi.fn().mockResolvedValue('mock-token'),
  createCheckout: vi.fn(),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
  normalizePaymentMethod: vi.fn().mockReturnValue('card'),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await env.DB.exec(
    'DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events; DELETE FROM processed_webhooks; DELETE FROM orders;',
  );
  const { parseCheckoutResult } = await import('../src/lib/verifone');
  vi.mocked(parseCheckoutResult).mockReturnValue({ status: 'pending' });
});

async function seedOrder(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) ?? crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, customer_email, items_json, verifone_checkout_id)
     VALUES (?, 'IRJA-20260725-TEST', 'checkout_created', 'ISK', 18000, 'test@test.is', '[]', ?)`,
  )
    .bind(id, overrides.verifone_checkout_id ?? 'chk-return-1')
    .run();
  return id;
}

describe('GET /api/return', () => {
  it('returns 400 when order_id missing', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/return');
    expect(resp.status).toBe(400);
  });

  it('returns 404 when order not found', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/return?order_id=00000000-0000-4000-8000-000000000000');
    expect(resp.status).toBe(404);
  });

  it('redirects to storefront with paid status on successful transaction', async () => {
    const orderId = await seedOrder();

    const { getCheckout, parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-TEST',
      transaction_id: 'txn-success-1',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-success-1', timestamp: '2026-07-25T10:00:00Z' }],
    });
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({
      status: 'success',
      transactionId: 'txn-success-1',
    });

    const resp = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${orderId}&transaction_id=txn-success-1&checkout_id=chk-return-1`,
      { redirect: 'manual' },
    );

    expect(resp.status).toBe(303);
    const location = resp.headers.get('location')!;
    expect(location).toContain('/order/');
    expect(location).toContain('status=paid');

    // Verify order was updated in D1
    const order = await env.DB.prepare('SELECT status, paid_at, verifone_transaction_id FROM orders WHERE id = ?')
      .bind(orderId)
      .first();
    expect(order!.status).toBe('paid');
    expect(order!.paid_at).not.toBeNull();
    expect(order!.verifone_transaction_id).toBe('txn-success-1');
  });

  it('persists PayPal after a server-verified successful return', async () => {
    const orderId = await seedOrder();
    const { getCheckout, parseCheckoutResult, normalizePaymentMethod } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-TEST',
      transaction_id: 'txn-paypal-return',
      payment_product: 'PAYPAL',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-paypal-return', timestamp: '2026-07-25T10:00:00Z' }],
    });
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({ status: 'success', transactionId: 'txn-paypal-return' });
    vi.mocked(normalizePaymentMethod).mockReturnValueOnce('paypal');

    const response = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${orderId}&transaction_id=txn-paypal-return&checkout_id=chk-return-1`,
      { redirect: 'manual' },
    );

    expect(response.headers.get('location')).toContain('status=paid');
    const order = await env.DB.prepare('SELECT status, payment_method FROM orders WHERE id = ?').bind(orderId).first();
    expect(order).toMatchObject({ status: 'paid', payment_method: 'paypal' });
    expect(normalizePaymentMethod).toHaveBeenCalledWith('PAYPAL');
  });

  it('redirects with error status on transaction_id mismatch', async () => {
    const orderId = await seedOrder();

    const { getCheckout } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-TEST',
      transaction_id: 'different-txn-id',
      events: [],
    });

    const resp = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${orderId}&transaction_id=tampered-id&checkout_id=chk-return-1`,
      { redirect: 'manual' },
    );

    expect(resp.status).toBe(303);
    expect(resp.headers.get('location')).toContain('status=error');
  });

  it('redirects with error status on amount mismatch', async () => {
    const orderId = await seedOrder();

    const { getCheckout, parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'COMPLETED',
      amount: 1, // does not match order.amount 18000
      transaction_id: 'txn-amt-1',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-amt-1', timestamp: '2026-07-25T10:00:00Z' }],
    });
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({
      status: 'success',
      transactionId: 'txn-amt-1',
    });

    const resp = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${orderId}&transaction_id=txn-amt-1&checkout_id=chk-return-1`,
      { redirect: 'manual' },
    );

    expect(resp.status).toBe(303);
    expect(resp.headers.get('location')).toContain('status=error');

    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('checkout_created');
  });

  it('redirects with error when client swaps checkout_id', async () => {
    const orderId = await seedOrder();

    const resp = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${orderId}&checkout_id=chk-attacker-swapped`,
      { redirect: 'manual' },
    );

    expect(resp.status).toBe(303);
    expect(resp.headers.get('location')).toContain('status=error');
  });

  it('does not mark paid when the provider currency differs', async () => {
    const orderId = await seedOrder();
    const { getCheckout, parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'EUR',
      merchant_reference: 'IRJA-20260725-TEST',
      transaction_id: 'txn-wrong-currency',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-wrong-currency', timestamp: '2026-07-25T10:00:00Z' }],
    });
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({ status: 'success', transactionId: 'txn-wrong-currency' });

    const resp = await SELF.fetch(`https://test.example.com/api/return?order_id=${orderId}&checkout_id=chk-return-1`, {
      redirect: 'manual',
    });
    expect(resp.status).toBe(303);
    expect(resp.headers.get('location')).toContain('status=error');
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order?.status).toBe('checkout_created');
  });

  it('redirects with failed status on failed transaction', async () => {
    const orderId = await seedOrder();

    const { getCheckout, parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'FAILED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-TEST',
      transaction_id: 'txn-fail-1',
      events: [{ type: 'TRANSACTION_FAILED', id: 'txn-fail-1', timestamp: '2026-07-25T10:00:00Z' }],
    });
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({
      status: 'failed',
      transactionId: 'txn-fail-1',
    });

    const resp = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${orderId}&transaction_id=txn-fail-1&checkout_id=chk-return-1`,
      { redirect: 'manual' },
    );

    expect(resp.status).toBe(303);
    expect(resp.headers.get('location')).toContain('status=failed');

    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('failed');
  });

  it('recovers an order from failed to paid on a verified late-arriving success', async () => {
    const orderId = await seedOrder();
    await env.DB.prepare(
      `UPDATE orders SET status = 'failed', verifone_transaction_id = 'txn-earlier-fail' WHERE id = ?`,
    )
      .bind(orderId)
      .run();

    const { getCheckout, parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-TEST',
      transaction_id: 'txn-recovered',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-recovered', timestamp: '2026-07-31T10:00:00Z' }],
    });
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({ status: 'success', transactionId: 'txn-recovered' });

    const resp = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${orderId}&transaction_id=txn-recovered&checkout_id=chk-return-1`,
      { redirect: 'manual' },
    );

    expect(resp.status).toBe(303);
    expect(resp.headers.get('location')).toContain('status=paid');
    const order = await env.DB.prepare('SELECT status, verifone_transaction_id FROM orders WHERE id = ?')
      .bind(orderId)
      .first<{ status: string; verifone_transaction_id: string }>();
    expect(order).toEqual({ status: 'paid', verifone_transaction_id: 'txn-recovered' });
  });

  it('does not overwrite or duplicate-audit a concurrent webhook transition', async () => {
    const orderId = await seedOrder();
    const { getCheckout, parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockImplementationOnce(async () => {
      await env.DB.prepare(
        `UPDATE orders SET status = 'paid', verifone_transaction_id = 'txn-from-webhook',
         paid_at = datetime('now') WHERE id = ?`,
      )
        .bind(orderId)
        .run();
      return {
        id: 'chk-return-1',
        status: 'COMPLETED',
        amount: 18000,
        currency_code: 'ISK',
        merchant_reference: 'IRJA-20260725-TEST',
        transaction_id: 'txn-success-race',
        events: [],
      };
    });
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({ status: 'success', transactionId: 'txn-success-race' });

    const response = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${orderId}&checkout_id=chk-return-1`,
      { redirect: 'manual' },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('status=paid');
    const order = await env.DB.prepare('SELECT status, verifone_transaction_id FROM orders WHERE id = ?')
      .bind(orderId)
      .first<{ status: string; verifone_transaction_id: string }>();
    expect(order).toEqual({ status: 'paid', verifone_transaction_id: 'txn-from-webhook' });
    const returnEvents = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_events WHERE order_id = ? AND source = 'verifone_return'",
    )
      .bind(orderId)
      .first<{ count: number }>();
    expect(returnEvents?.count).toBe(0);
  });
});
