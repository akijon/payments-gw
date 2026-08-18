/**
 * Dummy end-to-end rehearsal — NOT a substitute for SANDBOX_E2E_GATE.md.
 *
 * SANDBOX_E2E_GATE.md requires a real Verifone/Landsbankinn sandbox tenant and a
 * vendor-signed webhook; none of that is available in this workspace. This test
 * walks the same seven-item checklist end-to-end against mocked Verifone calls
 * (the same `vi.mock()` + `SELF.fetch()` pattern used throughout this suite — see
 * test/checkout.test.ts, test/webhook.test.ts) so the wiring between checkout,
 * return, webhook, reconciliation, and order-status is exercised together, once,
 * before real credentials exist. It gives no evidence about real vendor behavior.
 *
 * Paid -> refunded and paid -> settled are mutually exclusive outcomes for a
 * single order, so items 5 and 6 use their own seeded 'paid' orders rather than
 * forcing one order through both branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { TEST_CHECKOUT_CUSTOMER } from '../fixtures/checkout-customer';

vi.mock('../../src/lib/verifone', () => ({
  createCheckout: vi.fn(),
  createCustomer: vi.fn().mockResolvedValue('cust-mock-1'),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
  normalizePaymentMethod: vi.fn().mockReturnValue('card'),
}));

vi.mock('../../src/lib/crypto', () => ({
  verifyVerifoneWebhook: vi.fn().mockResolvedValue(true),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await env.DB.exec(
    `DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events;
     DELETE FROM processed_webhooks; DELETE FROM reconciliation_exceptions; DELETE FROM reconciliation_runs;
     DELETE FROM settlements; DELETE FROM orders;`,
  );
});

function webhookPayload(
  eventType: string,
  checkoutId: string,
  eventId: string,
  content?: { id: string; amount: number; currency_code: string },
): string {
  return JSON.stringify({
    eventType,
    objectType: 'StandardEvents',
    eventId,
    recordId: checkoutId,
    entityUid: 'test-entity',
    eventDateTime: new Date().toISOString(),
    source: 'Verifone',
    content: content ? { ...content, transaction_type: 'SALE', transaction_status: 'SETTLED' } : undefined,
  });
}

async function seedPaidOrder(params: {
  orderNumber: string;
  checkoutId: string;
  transactionId: string;
  amount?: number;
}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, items_json, verifone_checkout_id, verifone_transaction_id, paid_at)
     VALUES (?, ?, 'paid', 'ISK', ?, '[]', ?, ?, datetime('now'))`,
  )
    .bind(id, params.orderNumber, params.amount ?? 18000, params.checkoutId, params.transactionId)
    .run();
  return id;
}

describe('Sandbox rehearsal (mocked) — SANDBOX_E2E_GATE.md checklist', () => {
  it('walks checkout -> return -> webhook paid -> replay -> refund -> reconcile settled (+ rejects a bad settlement) -> order status', async () => {
    const { createCheckout, getCheckout, parseCheckoutResult } = await import('../../src/lib/verifone');
    const checkoutId = 'chk-rehearsal-1';

    // ── 1. Checkout creates a checkout_created order from server catalog pricing ──
    vi.mocked(createCheckout).mockResolvedValueOnce({
      checkoutId,
      checkoutUrl: 'https://pay.mock.verifone/chk-rehearsal-1',
    });

    const checkoutResp = await SELF.fetch('https://test.example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        ...TEST_CHECKOUT_CUSTOMER,
        items: [{ product_id: 'LOPAPEYSA-M', quantity: 1 }],
        terms_accepted: true,
        terms_version: '2026-08-17',
      }),
    });
    expect(checkoutResp.status).toBe(200);
    const checkoutBody = (await checkoutResp.json()) as {
      order_id: string;
      order_number: string;
      amount: number;
      currency: string;
      order_status_token: string;
    };
    expect(checkoutBody.amount).toBe(18000);
    expect(checkoutBody.currency).toBe('ISK');

    let order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(checkoutBody.order_id)
      .first<{ status: string }>();
    expect(order?.status).toBe('checkout_created');

    // ── 2. Browser return performs server-to-server checkout verification ──
    // Provider has not confirmed a final outcome yet — return must not guess.
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: checkoutId,
      status: 'PENDING',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: checkoutBody.order_number,
      events: [],
    });
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({ status: 'pending' });

    const returnResp = await SELF.fetch(
      `https://test.example.com/api/return?order_id=${checkoutBody.order_id}&checkout_id=${checkoutId}`,
      { redirect: 'manual' },
    );
    expect(returnResp.status).toBe(303);
    expect(returnResp.headers.get('Location')).toContain('status=pending');

    order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(checkoutBody.order_id)
      .first<{ status: string }>();
    expect(order?.status).toBe('checkout_created');

    // ── 3. A valid signed TxnSaleApproved webhook changes it to paid exactly once ──
    vi.mocked(getCheckout).mockResolvedValue({
      id: checkoutId,
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: checkoutBody.order_number,
      transaction_id: 'txn-rehearsal-1',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-rehearsal-1', timestamp: new Date().toISOString() }],
    });
    vi.mocked(parseCheckoutResult).mockReturnValue({ status: 'success', transactionId: 'txn-rehearsal-1' });

    const paidWebhookBody = webhookPayload('TxnSaleApproved', checkoutId, 'evt-rehearsal-paid');
    const webhookResp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: paidWebhookBody,
    });
    expect(webhookResp.status).toBe(200);
    expect(await webhookResp.json()).toEqual({ status: 'processed' });

    const paidOrder = await env.DB.prepare('SELECT status, verifone_transaction_id FROM orders WHERE id = ?')
      .bind(checkoutBody.order_id)
      .first<{ status: string; verifone_transaction_id: string }>();
    expect(paidOrder?.status).toBe('paid');
    expect(paidOrder?.verifone_transaction_id).toBe('txn-rehearsal-1');

    // ── 4. Replaying the identical webhook is idempotent — no second payment event ──
    const replayResp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: paidWebhookBody,
    });
    expect(replayResp.status).toBe(200);
    expect(await replayResp.json()).toEqual({ status: 'already_processed' });

    const paidEventCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM payment_events WHERE order_id = ? AND event_type = 'TxnSaleApproved'`,
    )
      .bind(checkoutBody.order_id)
      .first<{ count: number }>();
    expect(paidEventCount?.count).toBe(1);

    // ── 5. A sandbox refund webhook changes paid to refunded exactly once ──
    // (Separate seeded order: paid -> refunded and paid -> settled are mutually exclusive.)
    const refundCheckoutId = 'chk-rehearsal-refund';
    const refundOrderId = await seedPaidOrder({
      orderNumber: 'IRJA-REHEARSAL-REFUND',
      checkoutId: refundCheckoutId,
      transactionId: 'txn-rehearsal-refund-base',
    });
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: refundCheckoutId,
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-REHEARSAL-REFUND',
      transaction_id: 'txn-rehearsal-refund-base',
      events: [{ type: 'TxnRefundApproved', id: 'refund-rehearsal-1', timestamp: new Date().toISOString() }],
    });

    const refundResp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('TxnRefundApproved', refundCheckoutId, 'evt-rehearsal-refund', {
        id: 'refund-rehearsal-1',
        amount: 18000,
        currency_code: 'ISK',
      }),
    });
    expect(refundResp.status).toBe(200);
    expect(await refundResp.json()).toEqual({ status: 'processed' });

    const refundedOrder = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(refundOrderId)
      .first<{ status: string }>();
    expect(refundedOrder?.status).toBe('refunded');

    // ── 6. Reconciliation accepts a matching settlement (paid -> settled) and ──
    //       rejects a wrong-amount settlement, leaving that order unchanged.
    const settleOrderId = await seedPaidOrder({
      orderNumber: 'IRJA-REHEARSAL-SETTLE',
      checkoutId: 'chk-rehearsal-settle',
      transactionId: 'txn-rehearsal-settle-base',
    });
    const rejectOrderId = await seedPaidOrder({
      orderNumber: 'IRJA-REHEARSAL-SETTLE-BAD-AMOUNT',
      checkoutId: 'chk-rehearsal-settle-bad',
      transactionId: 'txn-rehearsal-settle-bad-base',
    });

    const { reconcile } = await import('../../src/cron/reconcile');
    await reconcile(env, {
      getSettlements: async () => [
        {
          id: 'settlement-rehearsal-1',
          settlementDate: '2026-07-28',
          totalAmount: 36000,
          currency: 'ISK',
          transactionCount: 2,
        },
      ],
      getSettlementTransactions: async () => [
        {
          id: 'acquirer-txn-rehearsal-settle',
          merchantReference: 'IRJA-REHEARSAL-SETTLE',
          amount: 18000,
          currency: 'ISK',
          transactionType: 'SALE',
          transactionStatus: 'SETTLED',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'acquirer-txn-rehearsal-bad-amount',
          merchantReference: 'IRJA-REHEARSAL-SETTLE-BAD-AMOUNT',
          amount: 1, // wrong amount — must be rejected, order stays paid
          currency: 'ISK',
          transactionType: 'SALE',
          transactionStatus: 'SETTLED',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const settledOrder = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(settleOrderId)
      .first<{ status: string }>();
    expect(settledOrder?.status).toBe('settled');

    const rejectedOrder = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(rejectOrderId)
      .first<{ status: string }>();
    expect(rejectedOrder?.status).toBe('paid'); // unchanged — wrong amount rejected

    const mismatchException = await env.DB.prepare(`SELECT reason FROM reconciliation_exceptions WHERE order_id = ?`)
      .bind(rejectOrderId)
      .first<{ reason: string }>();
    expect(mismatchException?.reason).toBe('payment_integrity_mismatch');

    // ── 7. Order-status API requires the checkout-issued capability token ──
    const unauthorized = await SELF.fetch(`https://test.example.com/api/orders/${checkoutBody.order_id}`);
    expect(unauthorized.status).toBe(401);

    const authorized = await SELF.fetch(`https://test.example.com/api/orders/${checkoutBody.order_id}`, {
      headers: { Authorization: `Bearer ${checkoutBody.order_status_token}` },
    });
    expect(authorized.status).toBe(200);
    const authorizedBody = (await authorized.json()) as { status: string; terminal: boolean };
    expect(authorizedBody.status).toBe('paid');
    expect(authorizedBody.terminal).toBe(true);
  });
});
