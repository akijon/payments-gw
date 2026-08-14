import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';

vi.mock('../src/lib/verifone', () => ({
  getVerifoneToken: vi.fn().mockResolvedValue('mock-token'),
  createCheckout: vi.fn().mockResolvedValue({
    checkoutId: 'test-checkout-id',
    checkoutUrl: 'https://test.verifone.com/checkout/test-checkout-id',
  }),
  createCustomer: vi.fn().mockResolvedValue('cust-mock-1'),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events; DELETE FROM processed_webhooks; DELETE FROM orders;',
  );
});

/**
 * Verifies the `ocr` [security · critical] claim against src/lib/catalog.ts:143-166:
 * "An attacker could craft values that pass the Math.trunc equality test but
 *  still manipulate pricing."
 *
 * The claim is that the consistency check at 143-159 creates a bypass. The
 * unconditional `hasUnit || hasTotal` throw at 161 should make that impossible.
 */
describe('ocr critical finding — consistent-price bypass attempt', () => {
  it('rejects internally CONSISTENT unit_price x quantity === total_amount', async () => {
    // Passes Math.trunc equality: 1 * 2 === 2. If 143-159 were the only
    // gate, this would sail through and buy a hoodie for 2 aurar.
    const res = await SELF.fetch('https://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'HOODIE-BLK-M', quantity: 2, unit_price: 1, total_amount: 2 }],
        customer_email: 'attacker@example.com',
      }),
    });

    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).toContain('price_manipulation');
  });

  it('rejects total_amount alone (no unit_price to compare against)', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'HOODIE-BLK-M', quantity: 1, total_amount: 1 }],
        customer_email: 'attacker@example.com',
      }),
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('price_manipulation');
  });

  it('rejects zero-valued money fields (falsy but present)', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'HOODIE-BLK-M', quantity: 1, unit_price: 0, total_amount: 0 }],
        customer_email: 'attacker@example.com',
      }),
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('price_manipulation');
  });

  it('still charges the catalog price on a clean request', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'HOODIE-BLK-M', quantity: 2 }],
        customer_email: 'buyer@example.com',
      }),
    });

    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT amount FROM orders ORDER BY rowid DESC LIMIT 1').first<{
      amount: number;
    }>();

    // Authoritative price comes from D1, never the client.
    const product = await env.DB.prepare('SELECT unit_price FROM products WHERE id = ?')
      .bind('HOODIE-BLK-M')
      .first<{ unit_price: number }>();

    expect(row?.amount).toBe((product?.unit_price ?? 0) * 2);
    expect(Number.isInteger(row?.amount)).toBe(true);
  });
});
