/**
 * Checkout route — integration tests via SELF + vi.mock
 *
 * Secure contract: client sends product_id + quantity only.
 * Amounts come from the server-side product catalog.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

vi.mock('../src/lib/verifone', () => ({
  getVerifoneToken: vi.fn().mockResolvedValue('mock-token'),
  createCheckout: vi.fn().mockResolvedValue({
    checkoutId: 'chk-test-1',
    checkoutUrl: 'https://pay.mock.verifone/chk-1',
  }),
  createCustomer: vi.fn().mockResolvedValue('cust-mock-1'),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await env.DB.exec(
    'DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events; DELETE FROM processed_webhooks; DELETE FROM orders;',
  );
});

describe('POST /api/checkout', () => {
  it('creates order and returns checkout_url + order_id from catalog prices', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'LOPAPEYSA-M', quantity: 1 }],
        customer_email: 'test@example.com',
      }),
    });

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      checkout_url: string;
      order_id: string;
      order_number: string;
      amount: number;
      total_amount: number;
    };
    expect(data.checkout_url).toBe('https://pay.mock.verifone/chk-1');
    expect(data.order_id).toBeDefined();
    expect(data.order_number).toMatch(/^IRJA-/);
    expect(data.amount).toBe(18000);
    expect(data.total_amount).toBe(18000);

    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(data.order_id).first();
    expect(order).not.toBeNull();
    expect(order!.status).toBe('checkout_created');
    expect(order!.amount).toBe(18000);
    expect(order!.verifone_checkout_id).toBe('chk-test-1');

    const { createCheckout } = await import('../src/lib/verifone');
    const request = vi.mocked(createCheckout).mock.calls[0]?.[1];
    // No PUBLIC_API_URL in wrangler.test.toml: the request origin is the callback origin.
    expect(request?.returnUrl).toMatch(/^https:\/\/test\.example\.com\/api\/return\?order_id=[0-9a-f-]+$/);
  });

  it('builds return_url from PUBLIC_API_URL when the Worker is reached through another origin', async () => {
    // Sandbox/production put the Worker behind the storefront origin (a /api/*
    // service-binding proxy), so the provider must return to that public origin
    // and not to the origin that happens to serve this request.
    env.PUBLIC_API_URL = 'https://public.example.net';
    try {
      const resp = await SELF.fetch('https://test.example.com/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ items: [{ product_id: 'TEST-001', quantity: 1 }] }),
      });
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { order_id: string };

      const { createCheckout } = await import('../src/lib/verifone');
      const request = vi.mocked(createCheckout).mock.calls[0]?.[1];
      expect(request?.returnUrl).toBe(`https://public.example.net/api/return?order_id=${data.order_id}`);
    } finally {
      delete env.PUBLIC_API_URL;
    }
  });

  it('returns 400 for empty items', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ items: [] }),
    });
    expect(resp.status).toBe(400);
  });

  it('returns 400 for missing items', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ customer_email: 'test@example.com' }),
    });
    expect(resp.status).toBe(400);
  });

  it('calculates amount from catalog only (ignores any client total notions)', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [
          { product_id: 'HOODIE-BLK-M', quantity: 2 }, // 8900 * 2
          { product_id: 'TSHIRT-WHT-L', quantity: 1 }, // 4500
        ],
      }),
    });

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { order_id: string; amount: number };
    expect(data.amount).toBe(22300);
    const order = await env.DB.prepare('SELECT amount, items_json FROM orders WHERE id = ?')
      .bind(data.order_id)
      .first();
    expect(order!.amount).toBe(22300);
    const items = JSON.parse(order!.items_json as string) as Array<{ unit_price: number; product_id: string }>;
    expect(items[0].unit_price).toBe(8900);
    expect(items[0].product_id).toBe('HOODIE-BLK-M');
  });

  it('accepts sku as alias for product_id', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ sku: 'TEST-001', quantity: 3 }],
      }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { amount: number };
    expect(data.amount).toBe(3000);
  });

  it('rejects active products with a currency different from the rest of the cart', async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO products (id, name, unit_price, currency, active)
       VALUES ('EUR-TEST-001', 'Euro test product', 100, 'EUR', 1)`,
    ).run();

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [
          { product_id: 'TEST-001', quantity: 1 },
          { product_id: 'EUR-TEST-001', quantity: 1 },
        ],
      }),
    });

    expect(resp.status).toBe(400);
    const data = (await resp.json()) as { code?: string };
    expect(data.code).toBe('mixed_currency');
  });

  it('returns 502 when Verifone API fails', async () => {
    const { createCheckout } = await import('../src/lib/verifone');
    vi.mocked(createCheckout).mockRejectedValueOnce(new Error('Verifone API down'));

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ items: [{ product_id: 'TEST-001', quantity: 1 }] }),
    });

    expect(resp.status).toBe(502);
  });

  it('rejects checkout bodies larger than 16 KiB before creating an order', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        customer_name: 'x'.repeat(16 * 1024),
      }),
    });

    expect(resp.status).toBe(413);
    const orders = await env.DB.prepare('SELECT COUNT(*) AS count FROM orders').first<{ count: number }>();
    expect(orders?.count).toBe(0);
  });

  it('requires an idempotency key', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ product_id: 'TEST-001', quantity: 1 }] }),
    });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ code: 'idempotency_key_required' });
  });

  it('replays the same completed checkout without creating a duplicate order', async () => {
    const idempotencyKey = 'checkout-retry-00000001';
    const request = () =>
      SELF.fetch('https://test.example.com/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ items: [{ product_id: 'TEST-001', quantity: 1 }] }),
      });

    const first = await request();
    const second = await request();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { order_id: string; order_status_token: string };
    const secondBody = (await second.json()) as {
      order_id: string;
      order_status_token: string;
      idempotent_replay: boolean;
    };
    expect(secondBody.order_id).toBe(firstBody.order_id);
    expect(secondBody.order_status_token).toBe(firstBody.order_status_token);
    expect(secondBody.idempotent_replay).toBe(true);

    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM orders').first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it('replays a completed checkout even if the catalog changed since the original attempt', async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO products (id, name, unit_price, currency, active)
       VALUES ('CATALOG-DRIFT-TEST', 'Catalog drift test product', 5000, 'ISK', 1)`,
    ).run();

    const idempotencyKey = 'checkout-catalog-drift-0001';
    const body = JSON.stringify({ items: [{ product_id: 'CATALOG-DRIFT-TEST', quantity: 1 }] });

    const first = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { order_id: string; amount: number };
    expect(firstBody.amount).toBe(5000);

    // Simulate the product being renamed, repriced, and deactivated after the
    // original checkout succeeded — none of this should affect the replay.
    await env.DB.prepare(
      `UPDATE products SET unit_price = 9999, active = 0, name = 'Renamed' WHERE id = 'CATALOG-DRIFT-TEST'`,
    ).run();

    const retry = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });

    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { order_id: string; amount: number; idempotent_replay: boolean };
    expect(retryBody.idempotent_replay).toBe(true);
    expect(retryBody.order_id).toBe(firstBody.order_id);
    expect(retryBody.amount).toBe(5000);

    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM orders').first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it('rejects reuse of an idempotency key for a different cart', async () => {
    const idempotencyKey = 'checkout-conflict-00001';
    const send = (quantity: number) =>
      SELF.fetch('https://test.example.com/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ items: [{ product_id: 'TEST-001', quantity }] }),
      });

    expect((await send(1)).status).toBe(200);
    const conflict = await send(2);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
  });

  it('rejects a retry while a checkout attempt is still genuinely in flight', async () => {
    const idempotencyKey = 'checkout-inflight-00001';
    const body = JSON.stringify({ items: [{ product_id: 'TEST-001', quantity: 1 }] });
    const first = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { order_id: string };

    // Simulate a crash after the claim was made but before any provider session
    // could have been created: recent updated_at, no checkout_url.
    await env.DB.prepare("UPDATE checkout_attempts SET status = 'processing', checkout_url = NULL WHERE order_id = ?")
      .bind(firstBody.order_id)
      .run();

    const retry = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: 'idempotency_processing' });
    expect(retry.headers.get('Retry-After')).toBe('2');
  });

  it('reclaims a stale idempotency attempt that never got a provider checkout_url', async () => {
    // A Worker that dies before persisting checkout_url must not wedge the key
    // forever — once the lease window has passed, a retry should succeed fresh.
    const idempotencyKey = 'checkout-stale-00001';
    const body = JSON.stringify({ items: [{ product_id: 'TEST-001', quantity: 1 }] });

    // Distinct provider checkout IDs per call, as a real second Verifone session would get.
    const { createCheckout } = await import('../src/lib/verifone');
    vi.mocked(createCheckout)
      .mockResolvedValueOnce({ checkoutId: 'chk-stale-1', checkoutUrl: 'https://pay.mock.verifone/chk-stale-1' })
      .mockResolvedValueOnce({ checkoutId: 'chk-stale-2', checkoutUrl: 'https://pay.mock.verifone/chk-stale-2' });

    const first = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { order_id: string };

    await env.DB.prepare(
      "UPDATE checkout_attempts SET status = 'processing', checkout_url = NULL, updated_at = '2000-01-01 00:00:00' WHERE order_id = ?",
    )
      .bind(firstBody.order_id)
      .run();

    const retry = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { order_id: string; idempotent_replay: boolean };
    expect(retryBody.idempotent_replay).toBe(false);
    expect(retryBody.order_id).not.toBe(firstBody.order_id);

    const orders = await env.DB.prepare('SELECT COUNT(*) AS count FROM orders').first<{ count: number }>();
    expect(orders?.count).toBe(2); // original order left orphaned at 'checkout_created', new one created
  });

  it('attempts a Verifone customer creation when an email is given (best-effort async)', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        customer_email: 'buyer@example.com',
        customer_name: 'Jón Jónsson',
      }),
    });

    expect(resp.status).toBe(200);
    const { createCustomer } = await import('../src/lib/verifone');
    expect(vi.mocked(createCustomer)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'buyer@example.com', firstName: 'Jón', lastName: 'Jónsson' }),
    );
  });

  it('does not create a Verifone customer with no email', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ items: [{ product_id: 'TEST-001', quantity: 1 }] }),
    });

    expect(resp.status).toBe(200);
    const { createCustomer } = await import('../src/lib/verifone');
    expect(vi.mocked(createCustomer)).not.toHaveBeenCalled();
  });

  it('proceeds with checkout even if customer creation fails (best-effort async)', async () => {
    const { createCustomer } = await import('../src/lib/verifone');
    vi.mocked(createCustomer).mockRejectedValueOnce(new Error('customer-service down'));

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        customer_email: 'buyer@example.com',
      }),
    });

    expect(resp.status).toBe(200);
    expect(vi.mocked(createCustomer)).toHaveBeenCalled();
  });
});
