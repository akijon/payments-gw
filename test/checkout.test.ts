/**
 * Checkout route — integration tests via SELF + vi.mock
 *
 * Secure contract: client sends product_id + quantity only.
 * Amounts come from the server-side product catalog.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { TERMS_VERSION } from '../src/lib/terms';
import type { CreateCheckoutInput } from '../src/usecases/create-checkout';

vi.mock('../src/lib/verifone', () => ({
  createCheckout: vi.fn().mockResolvedValue({
    checkoutId: 'chk-test-1',
    checkoutUrl: 'https://pay.mock.verifone/chk-1',
  }),
  createCustomer: vi.fn().mockResolvedValue('cust-mock-1'),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

const TEST_CUSTOMER = {
  customer_email: 'shopper@example.com',
  billing: {
    first_name: 'Jón',
    last_name: 'Jónsson',
    address_1: 'Laugavegur 1',
    city: 'Reykjavík',
    country_code: 'IS',
    postal_code: '101',
  },
} as const;

beforeEach(async () => {
  vi.clearAllMocks();
  await env.DB.exec(
    'DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events; DELETE FROM processed_webhooks; DELETE FROM orders;',
  );
});

describe('POST /api/checkout', () => {
  it('creates, persists, and attaches a 3DS-ready Verifone customer before checkout', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        customer_email: 'shopper@example.com',
        billing: {
          first_name: 'Jón',
          last_name: 'Jónsson',
          address_1: 'Laugavegur 1',
          city: 'Reykjavík',
          country_code: 'IS',
          postal_code: '101',
        },
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
    });

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { order_id: string };
    const { createCustomer, createCheckout } = await import('../src/lib/verifone');
    expect(vi.mocked(createCustomer)).toHaveBeenCalledWith(env, {
      email: 'shopper@example.com',
      firstName: 'Jón',
      lastName: 'Jónsson',
      billingAddress1: 'Laugavegur 1',
      billingCity: 'Reykjavík',
      billingCountryCode: 'IS',
      billingPostalCode: '101',
    });
    expect(vi.mocked(createCheckout).mock.calls[0]?.[1].customer).toBe('cust-mock-1');

    const order = await env.DB.prepare(
      `SELECT billing_first_name, billing_last_name, billing_address_1, billing_city,
              billing_country_code, billing_postal_code, verifone_customer_id
       FROM orders WHERE id = ?`,
    )
      .bind(data.order_id)
      .first<Record<string, unknown>>();
    expect(order).toMatchObject({
      billing_first_name: 'Jón',
      billing_last_name: 'Jónsson',
      billing_address_1: 'Laugavegur 1',
      billing_city: 'Reykjavík',
      billing_country_code: 'IS',
      billing_postal_code: '101',
      verifone_customer_id: 'cust-mock-1',
    });
  });

  it('fails atomically and safely retries customer creation with the same idempotency key', async () => {
    const { createCustomer, createCheckout } = await import('../src/lib/verifone');
    vi.mocked(createCustomer).mockRejectedValueOnce(new Error('provider unavailable'));
    const idempotencyKey = 'customer-creation-retry-0001';
    const body = JSON.stringify({
      ...TEST_CUSTOMER,
      items: [{ product_id: 'TEST-001', quantity: 1 }],
      terms_accepted: true,
      terms_version: TERMS_VERSION,
    });
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });

    expect(resp.status).toBe(502);
    expect(await resp.json()).toMatchObject({ code: 'customer_provider_unavailable' });
    expect(createCheckout).not.toHaveBeenCalled();
    const order = await env.DB.prepare('SELECT status FROM orders').first<{ status: string }>();
    expect(order?.status).toBe('failed');
    const attempt = await env.DB.prepare('SELECT status FROM checkout_attempts').first<{ status: string }>();
    expect(attempt?.status).toBe('failed');
    const event = await env.DB.prepare(
      "SELECT event_type FROM payment_events WHERE event_type = 'customer_creation_failed'",
    ).first<{ event_type: string }>();
    expect(event?.event_type).toBe('customer_creation_failed');

    const retry = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(retry.status).toBe(200);
    expect(createCustomer).toHaveBeenCalledTimes(2);
    expect(createCheckout).toHaveBeenCalledTimes(1);
  });

  it('requires email and complete billing identity for every 3DS checkout', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        customer_email: undefined,
        billing: undefined,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
    });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ code: 'customer_details_required' });
  });

  it('creates order and returns checkout_url + order_id from catalog prices', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'LOPAPEYSA-M', quantity: 1 }],
        customer_email: 'test@example.com',
        terms_accepted: true,
        terms_version: TERMS_VERSION,
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
    // Terms-of-sale consent is persisted with the order: the version the buyer
    // accepted and the moment the acceptance was recorded.
    expect(order!.terms_version).toBe(TERMS_VERSION);
    expect(order!.terms_accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const { createCheckout } = await import('../src/lib/verifone');
    const request = vi.mocked(createCheckout).mock.calls[0]?.[1];
    // No PUBLIC_API_URL in wrangler.test.toml: the request origin is the callback origin.
    expect(request?.returnUrl).toMatch(/^https:\/\/test\.example\.com\/api\/return\?order_id=[0-9a-f-]+$/);
  });

  it('rejects checkout when terms_accepted is missing', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ items: [{ product_id: 'TEST-001', quantity: 1 }] }),
    });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ code: 'terms_not_accepted' });
  });

  it('rejects checkout when terms_accepted is false', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        terms_accepted: false,
        terms_version: '2026-08-17',
      }),
    });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ code: 'terms_not_accepted' });
  });

  it('rejects checkout with a stale terms_version', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        terms_accepted: true,
        terms_version: '1970-01-01',
      }),
    });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ code: 'terms_version_mismatch' });
  });

  it('replays a completed checkout after a terms-version bump', async () => {
    const idempotencyKey = 'checkout-terms-bump-replay-0001';
    const oldTermsVersion = '2026-08-16';
    const items = [{ product_id: 'TEST-001', quantity: 1 }];
    const { hashIdempotencyValue } = await import('../src/lib/db');
    const keyHash = await hashIdempotencyValue(idempotencyKey);
    const requestHash = await hashIdempotencyValue(
      JSON.stringify({
        items,
        customer_email: null,
        customer_name: null,
        buyer_kennitala: null,
        terms_accepted: true,
        terms_version: oldTermsVersion,
      }),
    );
    const orderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await env.DB.prepare(
      `INSERT INTO orders (id, order_number, status, currency, amount, items_json, terms_accepted_at, terms_version)
       VALUES (?, 'IRJA-TERMS-REPLAY', 'checkout_created', 'ISK', 1000, '[]', '2026-08-16T00:00:00.000Z', ?)`,
    )
      .bind(orderId, oldTermsVersion)
      .run();
    await env.DB.prepare(
      `INSERT INTO checkout_attempts (key_hash, request_hash, order_id, status, checkout_url)
       VALUES (?, ?, ?, 'completed', 'https://pay.mock.verifone/old-terms-checkout')`,
    )
      .bind(keyHash, requestHash, orderId)
      .run();

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ items, terms_accepted: true, terms_version: oldTermsVersion }),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({
      order_id: orderId,
      checkout_url: 'https://pay.mock.verifone/old-terms-checkout',
      idempotent_replay: true,
    });
  });

  it("rejects checkout when terms_accepted is the string 'true' (no type coercion)", async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        terms_accepted: 'true',
        terms_version: '2026-08-17',
      }),
    });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ code: 'terms_not_accepted' });
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
        body: JSON.stringify({
          ...TEST_CUSTOMER,
          items: [{ product_id: 'TEST-001', quantity: 1 }],
          terms_accepted: true,
          terms_version: TERMS_VERSION,
        }),
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

  it('sends STOREFRONT_URL as shop_url so a cancelled HPP returns the buyer to the store', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
    });
    expect(resp.status).toBe(200);

    const { createCheckout } = await import('../src/lib/verifone');
    const request = vi.mocked(createCheckout).mock.calls.at(-1)?.[1];
    expect(request?.shopUrl).toBe(env.STOREFRONT_URL);
  });

  it('returns 400 for empty items', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ items: [], terms_accepted: true, terms_version: TERMS_VERSION }),
    });
    expect(resp.status).toBe(400);
  });

  it('returns 400 for missing items', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ customer_email: 'test@example.com', terms_accepted: true, terms_version: TERMS_VERSION }),
    });
    expect(resp.status).toBe(400);
  });

  it('calculates amount from catalog only (ignores any client total notions)', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [
          { product_id: 'HOODIE-BLK-M', quantity: 2 }, // 8900 * 2
          { product_id: 'TSHIRT-WHT-L', quantity: 1 }, // 4500
        ],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
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
        ...TEST_CUSTOMER,
        items: [{ sku: 'TEST-001', quantity: 3 }],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
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
        ...TEST_CUSTOMER,
        items: [
          { product_id: 'TEST-001', quantity: 1 },
          { product_id: 'EUR-TEST-001', quantity: 1 },
        ],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
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
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
    });

    expect(resp.status).toBe(502);
  });

  it('rejects checkout bodies larger than 16 KiB before creating an order', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        customer_name: 'x'.repeat(16 * 1024),
        terms_accepted: true,
        terms_version: TERMS_VERSION,
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
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
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
        body: JSON.stringify({
          ...TEST_CUSTOMER,
          items: [{ product_id: 'TEST-001', quantity: 1 }],
          terms_accepted: true,
          terms_version: TERMS_VERSION,
        }),
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
    const body = JSON.stringify({
      ...TEST_CUSTOMER,
      items: [{ product_id: 'CATALOG-DRIFT-TEST', quantity: 1 }],
      terms_accepted: true,
      terms_version: TERMS_VERSION,
    });

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
        body: JSON.stringify({
          ...TEST_CUSTOMER,
          items: [{ product_id: 'TEST-001', quantity }],
          terms_accepted: true,
          terms_version: TERMS_VERSION,
        }),
      });

    expect((await send(1)).status).toBe(200);
    const conflict = await send(2);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
  });

  it('rejects reuse of an idempotency key when billing identity changes', async () => {
    const idempotencyKey = 'checkout-billing-conflict-0001';
    const send = (address: string) =>
      SELF.fetch('https://test.example.com/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          ...TEST_CUSTOMER,
          billing: { ...TEST_CUSTOMER.billing, address_1: address },
          items: [{ product_id: 'TEST-001', quantity: 1 }],
          terms_accepted: true,
          terms_version: TERMS_VERSION,
        }),
      });

    expect((await send('Laugavegur 1')).status).toBe(200);
    const conflict = await send('Laugavegur 2');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
  });

  it('renews the attempt lease after serialized customer calls before creating the HPP session', async () => {
    const idempotencyKey = 'checkout-customer-lease-0001';
    const { createCustomer, createCheckout } = await import('../src/lib/verifone');
    vi.mocked(createCustomer).mockImplementationOnce(async () => {
      await env.DB.prepare("UPDATE checkout_attempts SET updated_at = '2000-01-01 00:00:00'").run();
      return 'cust-lease-1';
    });
    vi.mocked(createCheckout).mockImplementationOnce(async () => {
      const attempt = await env.DB.prepare(
        "SELECT key_hash, request_hash, order_id FROM checkout_attempts WHERE status = 'processing'",
      ).first<{ key_hash: string; request_hash: string; order_id: string }>();
      expect(attempt).not.toBeNull();
      const { generateUUID, reclaimStaleCheckoutAttempt } = await import('../src/lib/db');
      const reclaim = await reclaimStaleCheckoutAttempt(env.DB, {
        keyHash: attempt!.key_hash,
        requestHash: attempt!.request_hash,
        orderId: generateUUID(),
      });
      expect(reclaim.reclaimed).toBe(false);
      expect(reclaim.attempt.order_id).toBe(attempt!.order_id);
      return { checkoutId: 'chk-lease-1', checkoutUrl: 'https://pay.mock.verifone/chk-lease-1' };
    });

    const response = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'TEST-001', quantity: 1 }],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
    });

    expect(response.status).toBe(200);
    expect(createCheckout).toHaveBeenCalledTimes(1);
  });

  it('rejects a retry while a checkout attempt is still genuinely in flight', async () => {
    const idempotencyKey = 'checkout-inflight-00001';
    const body = JSON.stringify({
      ...TEST_CUSTOMER,
      items: [{ product_id: 'TEST-001', quantity: 1 }],
      terms_accepted: true,
      terms_version: TERMS_VERSION,
    });
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

  it('recovers a persisted provider result after finalization rollback without creating a second HPP session', async () => {
    const idempotencyKey = 'checkout-finalization-recovery-0001';
    const body = JSON.stringify({
      ...TEST_CUSTOMER,
      items: [{ product_id: 'TEST-001', quantity: 1 }],
      terms_accepted: true,
      terms_version: TERMS_VERSION,
    });
    const conflictingOrderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await env.DB.prepare(
      `INSERT INTO orders (
         id, order_number, status, currency, amount, items_json, verifone_checkout_id
       ) VALUES (?, 'IRJA-20260815-CONFLICT', 'checkout_created', 'ISK', 1000, '[]', 'chk-recovery-1')`,
    )
      .bind(conflictingOrderId)
      .run();

    const { createCheckout } = await import('../src/lib/verifone');
    vi.mocked(createCheckout).mockResolvedValueOnce({
      checkoutId: 'chk-recovery-1',
      checkoutUrl: 'https://pay.mock.verifone/chk-recovery-1',
    });

    const first = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(first.status).toBe(500);

    const originalAttempt = await env.DB.prepare(
      'SELECT order_id, status, checkout_url FROM checkout_attempts WHERE request_hash IS NOT NULL AND order_id != ?',
    )
      .bind(conflictingOrderId)
      .first<{ order_id: string; status: string; checkout_url: string | null }>();
    expect(originalAttempt).toMatchObject({ status: 'processing', checkout_url: null });

    await env.DB.prepare('UPDATE orders SET verifone_checkout_id = NULL WHERE id = ?').bind(conflictingOrderId).run();
    await env.DB.prepare("UPDATE checkout_attempts SET updated_at = '2000-01-01 00:00:00' WHERE order_id = ?")
      .bind(originalAttempt!.order_id)
      .run();

    const retry = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { order_id: string; checkout_url: string; idempotent_replay: boolean };
    expect(retryBody).toMatchObject({
      order_id: originalAttempt!.order_id,
      checkout_url: 'https://pay.mock.verifone/chk-recovery-1',
      idempotent_replay: true,
    });
    expect(vi.mocked(createCheckout)).toHaveBeenCalledTimes(1);
  });

  it('returns the finalized checkout when a same-key retry wins the finalization race', async () => {
    const idempotencyKey = 'checkout-finalization-race-0001';
    const checkoutInput: CreateCheckoutInput = {
      idempotencyKey,
      items: [{ product_id: 'TEST-001', quantity: 1 }],
      customerEmail: TEST_CUSTOMER.customer_email,
      customerName: `${TEST_CUSTOMER.billing.first_name} ${TEST_CUSTOMER.billing.last_name}`,
      billing: TEST_CUSTOMER.billing,
      termsAccepted: true,
      termsVersion: TERMS_VERSION,
      publicApiOrigin: 'https://test.example.com',
    };
    const db = await import('../src/lib/db');
    const recordProviderResult = db.recordCheckoutProviderResult;
    let signalRecorded!: () => void;
    let releaseOriginal!: () => void;
    const recorded = new Promise<void>((resolve) => {
      signalRecorded = resolve;
    });
    const originalMayContinue = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    const recordSpy = vi.spyOn(db, 'recordCheckoutProviderResult').mockImplementationOnce(async (...args) => {
      await recordProviderResult(...args);
      signalRecorded();
      await originalMayContinue;
    });
    const { createCheckout } = await import('../src/lib/verifone');
    vi.mocked(createCheckout).mockResolvedValueOnce({
      checkoutId: 'chk-race-1',
      checkoutUrl: 'https://pay.mock.verifone/chk-race-1',
    });

    const { createCheckoutUseCase } = await import('../src/usecases/create-checkout');

    try {
      const originalOutcomePromise = createCheckoutUseCase(env, checkoutInput);
      await recorded;

      const retry = await createCheckoutUseCase(env, checkoutInput);
      expect(retry.status).toBe(200);
      if (retry.status !== 200) throw new Error('Retry did not recover checkout');

      releaseOriginal();
      const original = await originalOutcomePromise;
      expect(original.status).toBe(200);
      if (original.status !== 200) throw new Error('Original request did not observe completed checkout');
      expect(original.body).toMatchObject({
        order_id: retry.body.order_id,
        checkout_url: retry.body.checkout_url,
      });
      const storedOrder = await env.DB.prepare('SELECT id, verifone_checkout_id FROM orders WHERE id = ?')
        .bind(retry.body.order_id)
        .first<{ id: string; verifone_checkout_id: string | null }>();
      expect(storedOrder).toEqual({ id: retry.body.order_id, verifone_checkout_id: 'chk-race-1' });
      expect(vi.mocked(createCheckout)).toHaveBeenCalledTimes(1);
    } finally {
      releaseOriginal();
      recordSpy.mockRestore();
    }
  });

  it('reclaims a stale idempotency attempt that never got a provider checkout_url', async () => {
    // A Worker that dies before persisting checkout_url must not wedge the key
    // forever — once the lease window has passed, a retry should succeed fresh.
    const idempotencyKey = 'checkout-stale-00001';
    const body = JSON.stringify({
      ...TEST_CUSTOMER,
      items: [{ product_id: 'TEST-001', quantity: 1 }],
      terms_accepted: true,
      terms_version: TERMS_VERSION,
    });

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
});
