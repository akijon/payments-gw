/**
 * Return route — integration tests via SELF + vi.mock
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/types/env';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

vi.mock('../src/lib/verifone', () => ({
  getVerifoneToken: vi.fn().mockResolvedValue('mock-token'),
  createCheckout: vi.fn(),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

beforeEach(async () => {
  await env.DB.exec('DELETE FROM orders;');
  await env.DB.exec('DELETE FROM payment_events;');
  await env.DB.exec('DELETE FROM processed_webhooks;');
});

async function seedOrder(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) ?? crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, customer_email, items_json, verifone_checkout_id)
     VALUES (?, 'IRJA-20260725-TEST', 'checkout_created', 'ISK', 18000, 'test@test.is', '[]', ?)`
  ).bind(id, overrides.verifone_checkout_id ?? 'chk-return-1').run();
  return id;
}

describe('GET /api/return', () => {
  it('returns 400 when order_id missing', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/return');
    expect(resp.status).toBe(400);
  });

  it('returns 404 when order not found', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/return?order_id=00000000-0000-4000-0000-000000000000');
    expect(resp.status).toBe(404);
  });

  it('redirects to storefront with paid status on successful transaction', async () => {
    const orderId = await seedOrder();

    const { getCheckout, parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'COMPLETED',
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

    expect(resp.status).toBe(302);
    const location = resp.headers.get('location')!;
    expect(location).toContain('/order/');
    expect(location).toContain('status=paid');

    // Verify order was updated in D1
    const order = await env.DB.prepare('SELECT status, paid_at, verifone_transaction_id FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('paid');
    expect(order!.paid_at).not.toBeNull();
    expect(order!.verifone_transaction_id).toBe('txn-success-1');
  });

  it('redirects with error status on transaction_id mismatch', async () => {
    const orderId = await seedOrder();

    const { getCheckout } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'COMPLETED',
      transaction_id: 'different-txn-id',
      events: [],
    });

    const resp = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${orderId}&transaction_id=tampered-id&checkout_id=chk-return-1`,
      { redirect: 'manual' },
    );

    expect(resp.status).toBe(302);
    expect(resp.headers.get('location')).toContain('status=error');
  });

  it('redirects with failed status on failed transaction', async () => {
    const orderId = await seedOrder();

    const { getCheckout, parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: 'chk-return-1',
      status: 'FAILED',
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

    expect(resp.status).toBe(302);
    expect(resp.headers.get('location')).toContain('status=failed');

    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('failed');
  });
});
