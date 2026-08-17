/**
 * Financial integrity gate — the unit-scale invariant.
 *
 * This gate exists because of a real 100x overcharge: the storefront's catalog
 * generator wrote `unit_price = priceIsk * 100` on an "aurar" assumption, while
 * ISK is charged in MAJOR units (whole krónur). The gateway forwards
 * `unit_price` to Verifone as the checkout `amount`, so an 8.900 kr valve would
 * have been billed as 890.000 kr.
 *
 * The invariant that would have caught it, and that this file pins:
 *
 *   D1 unit_price x quantity
 *     === order.amount (persisted)
 *     === response.amount (shown to the buyer)
 *     === amount sent to Verifone
 *
 * Every assertion below reads the price from D1 rather than hardcoding it, so
 * a scaling bug introduced anywhere in that chain — catalog seed, resolver,
 * request builder — breaks this file. Assertions over literal arithmetic
 * (`expect(1500 + 250).toBe(1750)`) would not have caught it and are not tests
 * of this system; the previous version of this file consisted entirely of
 * those and imported nothing from `src/`.
 *
 * Related coverage: `test/pricing-integrity.test.ts` (invoice vs charged
 * amount), `test/price-manipulation.test.ts` (client-supplied prices),
 * `test/invoice-computation.test.ts` (VAT decomposition).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { TERMS_VERSION } from '../../src/lib/terms';
import { buildVerifoneCheckoutRequest } from '../../src/lib/verifone';
import { computeInvoice } from '../../src/lib/invoice-computation';
import type { Env } from '../../src/types/env';
import type * as VerifoneModule from '../../src/lib/verifone';

vi.mock('../../src/lib/verifone', async (importOriginal) => {
  // Keep the real request builder — it is under test here — and stub only the
  // network calls. Mocking the builder would defeat the purpose of the gate.
  const actual = await importOriginal<typeof VerifoneModule>();
  return {
    ...actual,
    createCheckout: vi.fn().mockResolvedValue({
      checkoutId: 'chk-integrity-1',
      checkoutUrl: 'https://pay.mock.verifone/chk-integrity-1',
    }),
    createCustomer: vi.fn().mockResolvedValue('cust-integrity-1'),
    getCheckout: vi.fn(),
  };
});

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

async function catalogPrice(productId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT unit_price FROM products WHERE id = ?').bind(productId).first();
  if (!row) throw new Error(`Catalog fixture missing: ${productId}`);
  return row.unit_price as number;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await env.DB.exec(
    'DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events; DELETE FROM processed_webhooks; DELETE FROM orders;',
  );
});

describe('financial integrity: catalog price reaches the provider unscaled', () => {
  it('carries D1 unit_price through to the amount sent to Verifone, unmodified', async () => {
    const unitPrice = await catalogPrice('HOODIE-BLK-M');
    const quantity = 2;
    const expected = unitPrice * quantity;

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'HOODIE-BLK-M', quantity }],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { order_id: string; amount: number };

    // 1. what the buyer is shown
    expect(data.amount).toBe(expected);

    // 2. what is persisted
    const order = await env.DB.prepare('SELECT amount FROM orders WHERE id = ?').bind(data.order_id).first();
    expect(order!.amount).toBe(expected);

    // 3. what the provider is asked to charge — the step that actually moves money
    const { createCheckout } = await import('../../src/lib/verifone');
    const sent = vi.mocked(createCheckout).mock.calls.at(-1)?.[1];
    expect(sent?.amount).toBe(expected);
    expect(sent?.currency).toBe('ISK');
  });

  it('does not scale the amount by 100 in either direction', async () => {
    const unitPrice = await catalogPrice('LOPAPEYSA-M');

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'LOPAPEYSA-M', quantity: 1 }],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
    });
    expect(resp.status).toBe(200);
    const { amount } = (await resp.json()) as { amount: number };

    expect(amount).not.toBe(unitPrice * 100);
    expect(amount).not.toBe(Math.round(unitPrice / 100));
    expect(amount).toBe(unitPrice);
  });

  it('sums a mixed cart from D1 prices across quantities', async () => {
    const [hoodie, shirt] = await Promise.all([catalogPrice('HOODIE-BLK-M'), catalogPrice('TSHIRT-WHT-L')]);

    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [
          { product_id: 'HOODIE-BLK-M', quantity: 3 },
          { product_id: 'TSHIRT-WHT-L', quantity: 1 },
        ],
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
    });
    expect(resp.status).toBe(200);
    const { amount } = (await resp.json()) as { amount: number };

    expect(amount).toBe(hoodie * 3 + shirt);
  });

  it('rejects a checkout that carries client-supplied money fields', async () => {
    // The server does not merely ignore client totals — it refuses the request,
    // so a tampered cart can never be priced at all.
    const resp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CUSTOMER,
        items: [{ product_id: 'HOODIE-BLK-M', quantity: 1 }],
        amount: 1,
        total_amount: 1,
        terms_accepted: true,
        terms_version: TERMS_VERSION,
      }),
    });

    expect(resp.status).toBe(400);
  });
});

describe('financial integrity: money crossing the provider boundary is a safe integer', () => {
  function env0(): Env {
    return {
      VERIFONE_ENTITY_ID: 'entity-1',
      VERIFONE_PAYMENT_CONTRACT_ID: 'card-ppc-1',
      VERIFONE_3DS_CONTRACT_ID: '3ds-contract-1',
    } as Env;
  }

  const params = {
    orderNumber: 'ORD-INTEGRITY-1',
    currency: 'ISK',
    returnUrl: 'https://api.example.test/api/return?order_id=ord-1',
  };

  it('passes representative ISK shelf prices through the builder unchanged', () => {
    for (const amount of [3900, 4990, 8900, 14_500, 18_000, 55_000]) {
      const body = buildVerifoneCheckoutRequest(env0(), { ...params, amount });
      expect(body.amount).toBe(amount);
      expect(body.currency_code).toBe('ISK');
    }
  });

  it('rejects a fractional amount instead of silently rounding it', () => {
    expect(() => buildVerifoneCheckoutRequest(env0(), { ...params, amount: 8900.5 })).toThrow(
      /Invalid checkout amount/,
    );
  });

  it('rejects zero and negative amounts', () => {
    expect(() => buildVerifoneCheckoutRequest(env0(), { ...params, amount: 0 })).toThrow(/Invalid checkout amount/);
    expect(() => buildVerifoneCheckoutRequest(env0(), { ...params, amount: -8900 })).toThrow(
      /Invalid checkout amount/,
    );
  });

  it('rejects an amount beyond safe integer precision', () => {
    expect(() => buildVerifoneCheckoutRequest(env0(), { ...params, amount: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      /Invalid checkout amount/,
    );
  });
});

describe('financial integrity: the invoice reconstructs the charged amount', () => {
  it('produces a VAT-inclusive total equal to the amount charged, with no quantisation', () => {
    // 18.050 kr is deliberately not a round hundred: a rounding step that
    // quantised to the nearest 100 kr (the old roundToIsk) would shift it.
    const items = [
      { product_id: 'A', name: 'A', quantity: 1, unit_price: 18_050, total_amount: 18_050, vat_rate: 24 as const },
      { product_id: 'B', name: 'B', quantity: 2, unit_price: 4_990, total_amount: 9_980, vat_rate: 24 as const },
    ];
    const charged = items.reduce((sum, item) => sum + item.total_amount, 0);

    const invoice = computeInvoice({
      invoiceNumber: 'INV-INTEGRITY-1',
      issueDate: '2026-08-17',
      seller: {
        name: 'Irja',
        kennitala: '1234567890',
        vsk_number: '12345',
        address: 'Laugavegur 1, 101 Reykjavík',
        email: 'reikningar@example.is',
      },
      buyer: { name: 'Jón Jónsson' },
      items,
      currency: 'ISK',
    });

    expect(invoice).not.toBeNull();
    expect(invoice!.summary.total_amount_incl_vat).toBe(charged);

    // VAT breakdown must reconcile to the same total, not merely be present.
    const rebuilt = invoice!.summary.vat_breakdown.reduce(
      (sum, entry) => sum + entry.taxable_base + entry.vat_amount,
      0,
    );
    expect(rebuilt).toBe(charged);
  });
});
