import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';

vi.mock('../src/lib/verifone', () => ({
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

describe('Price Manipulation Security Tests', () => {
  it('rejects checkout when client sends unit_price (price manipulation)', async () => {
    const maliciousRequest = {
      items: [
        {
          name: 'Expensive Product (RRP: 50000 aurar)',
          quantity: 1,
          unit_price: 1,
          total_amount: 1,
          sku: 'HOODIE-BLK-M',
        },
      ],
      customer_email: 'attacker@example.com',
      terms_accepted: true,
      terms_version: '2026-08-17',
    };

    const response = await SELF.fetch('http://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(maliciousRequest),
    });

    expect(response.status).toBe(400);
    const responseData = (await response.json()) as { error?: string; code?: string };
    expect(responseData.error?.toLowerCase()).toContain('price manipulation');
    expect(responseData.code).toBe('price_manipulation');
  });

  it('rejects checkout when client provides inconsistent price and total', async () => {
    const maliciousRequest = {
      items: [
        {
          name: 'Test Product',
          quantity: 10,
          unit_price: 1000,
          total_amount: 100,
          sku: 'TEST-001',
        },
      ],
      customer_email: 'attacker@example.com',
      terms_accepted: true,
      terms_version: '2026-08-17',
    };

    const response = await SELF.fetch('http://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(maliciousRequest),
    });

    expect(response.status).toBe(400);
    const responseData = (await response.json()) as { error?: string; code?: string };
    expect(responseData.error?.toLowerCase()).toContain('inconsistent pricing');
    expect(responseData.code).toBe('inconsistent_pricing');
  });

  it('rejects checkout when client provides unknown SKU', async () => {
    const maliciousRequest = {
      items: [
        {
          product_id: 'FAKE-999999',
          quantity: 1,
        },
      ],
      customer_email: 'attacker@example.com',
      terms_accepted: true,
      terms_version: '2026-08-17',
    };

    const response = await SELF.fetch('http://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(maliciousRequest),
    });

    expect(response.status).toBe(400);
    const responseData = (await response.json()) as { error?: string; code?: string };
    expect(responseData.error?.toLowerCase()).toContain('unknown product');
    expect(responseData.code).toBe('unknown_product');
  });

  it('accepts secure product_id + quantity and charges catalog price only', async () => {
    const secureRequest = {
      items: [{ product_id: 'HOODIE-BLK-M', quantity: 1 }],
      customer_email: 'buyer@example.com',
      terms_accepted: true,
      terms_version: '2026-08-17',
    };

    const response = await SELF.fetch('http://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(secureRequest),
    });

    expect(response.status).toBe(200);
    const responseData = (await response.json()) as {
      checkout_url?: string;
      order_id?: string;
      amount?: number;
    };
    expect(responseData.checkout_url).toBeDefined();
    expect(responseData.order_id).toBeDefined();
    expect(responseData.amount).toBe(8900); // catalog price, not client-controlled
  });

  it('rejects client unit_price even when product_id is valid', async () => {
    const response = await SELF.fetch('http://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'HOODIE-BLK-M', quantity: 1, unit_price: 1 }],
        terms_accepted: true,
        terms_version: '2026-08-17',
      }),
    });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error?: string };
    expect(data.error?.toLowerCase()).toContain('price manipulation');
  });
});
