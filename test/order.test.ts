/**
 * Order status API — integration tests via SELF + real D1
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';

const VALID_ORDER_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ORDER_ACCESS_TOKEN = 'test-order-access-token';

const LINE_ITEMS = [
  {
    product_id: 'LOPAPEYSA-M',
    name: 'Lopapeysa M',
    quantity: 2,
    unit_price: 18000,
    total_amount: 36000,
    sku: 'LOPAPEYSA-M',
  },
  {
    product_id: 'WOOL-SCARF',
    name: 'Wool Scarf',
    quantity: 1,
    unit_price: 7500,
    total_amount: 7500,
    sku: 'WOOL-SCARF',
  },
];

describe('GET /api/orders/:id', () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO orders (id, order_number, status, currency, amount, customer_email, customer_name, items_json)
       VALUES (?, 'IRJA-20260725-ORD1', 'pending', 'ISK', 43500, 'customer@test.is', 'Gudrun', ?)`,
    )
      .bind(VALID_ORDER_ID, JSON.stringify(LINE_ITEMS))
      .run();
    const { createOrderAccessToken } = await import('../src/lib/db');
    await createOrderAccessToken(env.DB, VALID_ORDER_ID, ORDER_ACCESS_TOKEN);
  });

  it('returns order JSON only with the order access token', async () => {
    const resp = await SELF.fetch(`https://test.example.com/api/orders/${VALID_ORDER_ID}`, {
      headers: { Authorization: `Bearer ${ORDER_ACCESS_TOKEN}` },
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.id).toBe(VALID_ORDER_ID);
    expect(data.order_number).toBe('IRJA-20260725-ORD1');
    expect(data.status).toBe('pending');
    expect(data.amount).toBe(43500);
    expect(data.currency).toBe('ISK');
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.created_at).toBeDefined();
    expect(data.updated_at).toBeDefined();
    expect(data.terminal).toBe(false);
    expect(data.next_poll_ms).toBe(3000);
    expect(data.can_retry).toBe(false);
  });

  it('rejects a missing access token without exposing order status', async () => {
    const resp = await SELF.fetch(`https://test.example.com/api/orders/${VALID_ORDER_ID}`);
    expect(resp.status).toBe(401);
    expect(resp.headers.get('Cache-Control')).toBe('no-store');
  });

  it('does not expose sensitive internal fields', async () => {
    const resp = await SELF.fetch(`https://test.example.com/api/orders/${VALID_ORDER_ID}`, {
      headers: { Authorization: `Bearer ${ORDER_ACCESS_TOKEN}` },
    });
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.verifone_transaction_id).toBeUndefined();
    expect(data.verifone_checkout_id).toBeUndefined();
    expect(data.verifone_customer_id).toBeUndefined();
    expect(data.landsbankinn_settlement_id).toBeUndefined();
    expect(data.customer_email).toBeUndefined();
    expect(data.customer_name).toBeUndefined();
    expect(data.billing).toBeUndefined();
    expect(data.billing_address_1).toBeUndefined();
    expect(data.items_json).toBeUndefined();
  });

  it('does not accept access tokens in URLs', async () => {
    const resp = await SELF.fetch(`https://test.example.com/api/orders/${VALID_ORDER_ID}?token=${ORDER_ACCESS_TOKEN}`);
    expect(resp.status).toBe(401);
  });
});
