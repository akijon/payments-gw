/**
 * Checkout route — integration tests via SELF + vi.mock
 *
 * Tests the full pipeline: HTTP request → Worker route → D1 → mocked Verifone API → response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/types/env';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

vi.mock('../src/lib/verifone', () => ({
  getVerifoneToken: vi.fn().mockResolvedValue('mock-token'),
  createCheckout: vi.fn().mockResolvedValue({
    checkoutId: 'chk-test-1',
    checkoutUrl: 'https://pay.mock.verifone/chk-1',
  }),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

beforeEach(async () => {
  await env.DB.exec('DELETE FROM orders;');
  await env.DB.exec('DELETE FROM payment_events;');
  await env.DB.exec('DELETE FROM processed_webhooks;');
});

describe('POST /api/checkout', () => {
  it('creates order and returns checkout_url + order_id', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ name: 'Lopapeysa', quantity: 1, unit_price: 18000, total_amount: 18000 }],
        customer_email: 'test@example.com',
      }),
    });

    expect(resp.status).toBe(200);
    const data = await resp.json() as { checkout_url: string; order_id: string; order_number: string };
    expect(data.checkout_url).toBe('https://pay.mock.verifone/chk-1');
    expect(data.order_id).toBeDefined();
    expect(data.order_number).toMatch(/^IRJA-/);

    // Verify order was stored in D1
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(data.order_id).first();
    expect(order).not.toBeNull();
    expect(order!.status).toBe('checkout_created');
    expect(order!.amount).toBe(18000);
    expect(order!.verifone_checkout_id).toBe('chk-test-1');
  });

  it('returns 400 for empty items', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    expect(resp.status).toBe(400);
  });

  it('returns 400 for missing items', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_email: 'test@example.com' }),
    });
    expect(resp.status).toBe(400);
  });

  it('calculates amount server-side from items', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          { name: 'Item A', quantity: 2, unit_price: 10000, total_amount: 20000 },
          { name: 'Item B', quantity: 1, unit_price: 5500, total_amount: 5500 },
        ],
      }),
    });

    expect(resp.status).toBe(200);
    const data = await resp.json() as { order_id: string };
    const order = await env.DB.prepare('SELECT amount FROM orders WHERE id = ?').bind(data.order_id).first();
    expect(order!.amount).toBe(25500); // 20000 + 5500, not any client-supplied amount
  });

  it('returns 502 when Verifone API fails', async () => {
    const { createCheckout } = await import('../src/lib/verifone');
    vi.mocked(createCheckout).mockRejectedValueOnce(new Error('Verifone API down'));

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ name: 'Test', quantity: 1, unit_price: 1000, total_amount: 1000 }],
      }),
    });

    expect(resp.status).toBe(502);
  });
});
