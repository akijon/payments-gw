/**
 * Invoice route rejects finalization on a broken number series.
 *
 * A gap in the issued series means órofin númeraröð is already broken. No
 * retry repairs that, so the route must refuse rather than append another
 * number — and must say so distinctly from a transient failure, since the two
 * demand opposite operator responses (investigate the ledger vs. wait).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createOrderWithAccessToken } from '../src/lib/db';
import type { LineItem } from '../src/types/api';
import { TERMS_VERSION } from '../src/lib/terms';

// Matches test/invoice-api.test.ts: the Worker entrypoint pulls in the Verifone
// client at module load, which cannot initialize under the test runtime.
vi.mock('../src/lib/verifone', () => ({
  createCheckout: vi.fn().mockResolvedValue({
    checkoutId: 'chk-test-1',
    checkoutUrl: 'https://pay.mock.verifone/chk-1',
  }),
  createCustomer: vi.fn().mockResolvedValue('cust-mock-1'),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

const YEAR = new Date().getUTCFullYear();

async function seedPaidOrder(id: string, token: string): Promise<void> {
  await createOrderWithAccessToken(env.DB, {
    id,
    orderNumber: `IRJA-seqgate-${id}`,
    currency: 'ISK',
    amount: 10000, // VAT-inclusive charged amount
    customerEmail: 'buyer@example.is',
    customerName: 'Test Customer',
    termsAcceptedAt: new Date().toISOString(),
    termsVersion: TERMS_VERSION,
    items: [
      {
        product_id: 'TEST-001',
        name: 'Test Product',
        quantity: 1,
        unit_price: 10000,
        total_amount: 10000,
      },
    ] as LineItem[],
    accessToken: token,
  });

  await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?").bind(id).run();
}

async function seedInvoiceNumber(invoiceNumber: string, suffix: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
     VALUES (?, ?, 'paid', 'ISK', 10000, '[]')`,
  )
    .bind(`seqgate-src-${suffix}`, `IRJA-seqgate-src-${suffix}`)
    .run();
  await env.DB.prepare(`INSERT INTO invoices (id, order_id, invoice_number, issue_date) VALUES (?, ?, ?, '2031-01-01')`)
    .bind(`seqgate-inv-${suffix}`, `seqgate-src-${suffix}`, invoiceNumber)
    .run();
}

/**
 * Advance the year's cursor without writing invoice rows — simulates claims
 * whose invoice write never landed, which is the actual shape of ledger
 * corruption (as opposed to seedInvoiceNumber, which writes a row the cursor
 * never claimed).
 */
async function advanceCursor(count: number): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO invoice_sequence (year, next_number) VALUES (?, 1)').bind(YEAR).run();
  await env.DB.prepare('UPDATE invoice_sequence SET next_number = ? WHERE year = ?')
    .bind(count + 1, YEAR)
    .run();
}

describe('Invoice route sequence gate', () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM invoices WHERE invoice_number LIKE 'REIK-${YEAR}-%'`).run();
    await env.DB.prepare("DELETE FROM order_access_tokens WHERE order_id LIKE 'seqgate-%'").run();
    await env.DB.prepare("DELETE FROM orders WHERE id LIKE 'seqgate-%'").run();
    await env.DB.prepare('DELETE FROM invoice_sequence WHERE year = ?').bind(YEAR).run();
  });

  it('issues an invoice when the series is intact', async () => {
    await seedPaidOrder('seqgate-ok', 'seqgate-token-ok-aaaaaaaaaaaa');

    const response = await SELF.fetch(`http://localhost/api/invoices/orders/seqgate-ok/invoice`, {
      headers: { Authorization: 'Bearer seqgate-token-ok-aaaaaaaaaaaa' },
    });

    expect(response.status).toBe(200);
  });

  it('refuses to finalize when the series has a gap', async () => {
    await advanceCursor(3);
    await seedInvoiceNumber(`REIK-${YEAR}-00001`, 'a');
    await seedInvoiceNumber(`REIK-${YEAR}-00003`, 'b');
    await seedPaidOrder('seqgate-broken', 'seqgate-token-broken-aaaaaaa');

    const response = await SELF.fetch(`https://example.com/api/invoices/orders/seqgate-broken/invoice`, {
      headers: { Authorization: 'Bearer seqgate-token-broken-aaaaaaa' },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'sequence_out_of_order' });
  });

  it('does not persist an invoice for the rejected order', async () => {
    await advanceCursor(3);
    await seedInvoiceNumber(`REIK-${YEAR}-00001`, 'a');
    await seedInvoiceNumber(`REIK-${YEAR}-00003`, 'b');
    await seedPaidOrder('seqgate-broken', 'seqgate-token-broken-aaaaaaa');

    await SELF.fetch(`https://example.com/api/invoices/orders/seqgate-broken/invoice`, {
      headers: { Authorization: 'Bearer seqgate-token-broken-aaaaaaa' },
    });

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM invoices WHERE order_id = ?')
      .bind('seqgate-broken')
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('still requires authorization before reporting a sequence problem', async () => {
    await advanceCursor(3);
    await seedInvoiceNumber(`REIK-${YEAR}-00001`, 'a');
    await seedInvoiceNumber(`REIK-${YEAR}-00003`, 'b');
    await seedPaidOrder('seqgate-broken', 'seqgate-token-broken-aaaaaaa');

    const response = await SELF.fetch(`https://example.com/api/invoices/orders/seqgate-broken/invoice`, {
      headers: { Authorization: 'Bearer seqgate-token-wrong-aaaaaaaa' },
    });

    expect(response.status).toBe(401);
  });
});
