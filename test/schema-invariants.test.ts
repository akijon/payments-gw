import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function insertOrder(id: string, checkoutId: string | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, items_json, verifone_checkout_id)
     VALUES (?, ?, 'pending', 'ISK', 1000, '[]', ?)`,
  )
    .bind(id, `ORDER-${id}`, checkoutId)
    .run();
}

describe('database payment invariants', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM payment_events'),
      env.DB.prepare('DELETE FROM order_access_tokens'),
      env.DB.prepare('DELETE FROM checkout_attempts'),
      env.DB.prepare('DELETE FROM orders'),
    ]);
  });

  it('rejects invalid status, non-positive amounts, and malformed currencies', async () => {
    const statements = [
      env.DB.prepare(
        `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
         VALUES ('bad-status', 'BAD-STATUS', 'invented', 'ISK', 1000, '[]')`,
      ),
      env.DB.prepare(
        `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
         VALUES ('bad-amount', 'BAD-AMOUNT', 'pending', 'ISK', 0, '[]')`,
      ),
      env.DB.prepare(
        `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
         VALUES ('bad-currency', 'BAD-CURRENCY', 'pending', 'isk', 1000, '[]')`,
      ),
    ];

    for (const statement of statements) await expect(statement.run()).rejects.toThrow();
  });

  it('rejects duplicate non-null provider checkout identifiers', async () => {
    await insertOrder('order-a', 'checkout-unique');
    await expect(insertOrder('order-b', 'checkout-unique')).rejects.toThrow();
  });

  it('requires a known payment method', async () => {
    const statements = [
      env.DB.prepare(
        `INSERT INTO orders (id, order_number, status, currency, amount, items_json, payment_method)
         VALUES ('null-method', 'NULL-METHOD', 'pending', 'ISK', 1000, '[]', NULL)`,
      ),
      env.DB.prepare(
        `INSERT INTO orders (id, order_number, status, currency, amount, items_json, payment_method)
         VALUES ('invented-method', 'INVENTED-METHOD', 'pending', 'ISK', 1000, '[]', 'bank_transfer')`,
      ),
    ];

    for (const statement of statements) await expect(statement.run()).rejects.toThrow();
  });
});
