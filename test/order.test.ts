/**
 * Order status API — integration tests via SELF + real D1
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/types/env';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

const VALID_ORDER_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const NONEXISTENT_ID = '00000000-0000-4000-0000-000000000000';

const LINE_ITEMS = [
  { name: 'Lopapeysa', quantity: 2, unit_price: 18000, total_amount: 36000 },
  { name: 'Wool Scarf', quantity: 1, unit_price: 7500, total_amount: 7500 },
];

describe('GET /api/orders/:id', () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO orders (id, order_number, status, currency, amount, customer_email, customer_name, items_json)
       VALUES (?, 'IRJA-20260725-ORD1', 'pending', 'ISK', 43500, 'customer@test.is', 'Gudrun', ?)`
    ).bind(VALID_ORDER_ID, JSON.stringify(LINE_ITEMS)).run();
  });

  it('returns order JSON for a valid order', async () => {
    const resp = await SELF.fetch(`https://test.example.com/api/orders/${VALID_ORDER_ID}`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.id).toBe(VALID_ORDER_ID);
    expect(data.order_number).toBe('IRJA-20260725-ORD1');
    expect(data.status).toBe('pending');
    expect(data.amount).toBe(43500);
    expect(data.currency).toBe('ISK');
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.created_at).toBeDefined();
  });

  it('returns 404 for non-existent order', async () => {
    const resp = await SELF.fetch(`https://test.example.com/api/orders/${NONEXISTENT_ID}`);
    expect(resp.status).toBe(404);
  });

  it('does not expose sensitive internal fields', async () => {
    const resp = await SELF.fetch(`https://test.example.com/api/orders/${VALID_ORDER_ID}`);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.verifone_transaction_id).toBeUndefined();
    expect(data.verifone_checkout_id).toBeUndefined();
    expect(data.landsbankinn_settlement_id).toBeUndefined();
    expect(data.items_json).toBeUndefined();
  });
});
