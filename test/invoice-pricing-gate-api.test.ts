/**
 * Invoice route blocks finalization when the charge does not reconcile.
 *
 * Rule: charged amount must strictly equal
 *   subtotal_excl_vat + total_vat + shipping_incl_vat
 *
 * computeInvoice already proves the invoice agrees with itself. This proves it
 * agrees with the money actually taken from the customer — the discrepancy a
 * Skatturinn audit surfaces. An order whose stored shipping does not account
 * for the gap between its charge and its line items must not produce an
 * invoice at all, rather than produce one that misstates the sale.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createOrderWithAccessToken, generateUUID, generateOrderNumber } from '../src/lib/db';
import type { LineItem } from '../src/types/api';
import { TERMS_VERSION } from '../src/lib/terms';

vi.mock('../src/lib/verifone', () => ({
  getVerifoneToken: vi.fn().mockResolvedValue('mock-token'),
  createCheckout: vi.fn(),
  createCustomer: vi.fn(),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

/** Tokens must be realistic length — hasOrderAccess compares fixed-size hashes. */
function makeToken(label: string): string {
  return `pricing-gate-token-${label}-aaaaaaaa`;
}

async function seedPaidOrder(opts: {
  token: string;
  /** What the customer was actually charged. */
  amount: number;
  /** Sum of line items (VAT-inclusive). */
  lineTotal: number;
  shippingInclVat?: number;
}): Promise<string> {
  const orderId = generateUUID();

  await createOrderWithAccessToken(env.DB, {
    id: orderId,
    orderNumber: generateOrderNumber(),
    currency: 'ISK',
    amount: opts.amount,
    customerEmail: 'buyer@example.is',
    customerName: 'Test Customer',
    termsAcceptedAt: new Date().toISOString(),
    termsVersion: TERMS_VERSION,
    items: [
      {
        product_id: 'TEST-001',
        name: 'Test Product',
        quantity: 1,
        unit_price: opts.lineTotal,
        total_amount: opts.lineTotal,
      },
    ] as LineItem[],
    accessToken: opts.token,
  });

  await env.DB.prepare(
    "UPDATE orders SET status = 'paid', paid_at = datetime('now'), shipping_incl_vat = ? WHERE id = ?",
  )
    .bind(opts.shippingInclVat ?? 0, orderId)
    .run();

  return orderId;
}

function fetchInvoice(orderId: string, token: string): Promise<Response> {
  return SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('Invoice route pricing gate', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM invoices').run();
    await env.DB.prepare('DELETE FROM invoice_sequence').run();
  });

  it('issues an invoice when the charge reconciles with no shipping', async () => {
    const token = makeToken('ok');
    const orderId = await seedPaidOrder({ token, amount: 10_000, lineTotal: 10_000 });

    const response = await fetchInvoice(orderId, token);

    expect(response.status).toBe(200);
  });

  it('issues an invoice when the charge reconciles including shipping', async () => {
    const token = makeToken('ship');
    const orderId = await seedPaidOrder({
      token,
      amount: 10_990, // 10,000 goods + 990 shipping
      lineTotal: 10_000,
      shippingInclVat: 990,
    });

    const response = await fetchInvoice(orderId, token);

    expect(response.status).toBe(200);
  });

  it('blocks finalization when shipping was charged but not recorded', async () => {
    // Customer paid 10,990 but the order records no shipping, so the invoice
    // would account for only 10,000 of the charge.
    const token = makeToken('gap');
    const orderId = await seedPaidOrder({ token, amount: 10_990, lineTotal: 10_000 });

    const response = await fetchInvoice(orderId, token);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'pricing_mismatch' });
  });

  it('blocks finalization when recorded shipping overstates the charge', async () => {
    const token = makeToken('over');
    const orderId = await seedPaidOrder({
      token,
      amount: 10_000,
      lineTotal: 10_000,
      shippingInclVat: 990,
    });

    const response = await fetchInvoice(orderId, token);

    expect(response.status).toBe(409);
  });

  it('does not persist an invoice for a blocked order', async () => {
    const token = makeToken('nopersist');
    const orderId = await seedPaidOrder({ token, amount: 10_990, lineTotal: 10_000 });

    await fetchInvoice(orderId, token);

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM invoices WHERE order_id = ?')
      .bind(orderId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('does not consume an invoice number for a blocked order', async () => {
    const blockedToken = makeToken('burn');
    const blockedId = await seedPaidOrder({ token: blockedToken, amount: 10_990, lineTotal: 10_000 });
    await fetchInvoice(blockedId, blockedToken);

    // A blocked finalization must leave the series untouched, so the next
    // legitimate sale still receives the first number.
    const okToken = makeToken('after');
    const okId = await seedPaidOrder({ token: okToken, amount: 10_000, lineTotal: 10_000 });
    const response = await fetchInvoice(okId, okToken);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { invoice: { header: { invoice_number: string } } };
    expect(body.invoice.header.invoice_number).toMatch(/-00001$/);
  });

  it('still requires authorization before reporting a pricing problem', async () => {
    const token = makeToken('auth');
    const orderId = await seedPaidOrder({ token, amount: 10_990, lineTotal: 10_000 });

    const response = await fetchInvoice(orderId, makeToken('wrong'));

    expect(response.status).toBe(401);
  });
});
