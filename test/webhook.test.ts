/**
 * Webhook route — integration tests via SELF + vi.mock
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

vi.mock('../src/lib/crypto', () => ({
  verifyVerifoneWebhook: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/lib/verifone', () => ({
  getVerifoneToken: vi.fn().mockResolvedValue('mock-token'),
  createCheckout: vi.fn(),
  getCheckout: vi.fn().mockImplementation(async (_env: unknown, checkoutId: string) => ({
    id: checkoutId,
    status: 'COMPLETED',
    amount: 18000,
    currency_code: 'ISK',
    merchant_reference: 'IRJA-20260725-HOOK',
    events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-s2s', timestamp: new Date().toISOString() }],
    transaction_id: 'txn-s2s',
    payment_product: 'VISA', // Mock as card payment by default
  })),
  parseCheckoutResult: vi.fn().mockReturnValue({ status: 'success', transactionId: 'txn-s2s' }),
  normalizePaymentMethod: vi.fn().mockReturnValue('card'), // Mock as card by default
}));

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events; DELETE FROM processed_webhooks; DELETE FROM orders;',
  );
  const { getCheckout, parseCheckoutResult, normalizePaymentMethod } = await import('../src/lib/verifone');
  vi.mocked(getCheckout).mockImplementation(async (_env: unknown, checkoutId: string) => ({
    id: checkoutId,
    status: 'COMPLETED',
    amount: 18000,
    currency_code: 'ISK',
    merchant_reference: 'IRJA-20260725-HOOK',
    events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-s2s', timestamp: new Date().toISOString() }],
    transaction_id: 'txn-s2s',
    payment_product: 'VISA', // Mock as card payment by default
  }));
  vi.mocked(parseCheckoutResult).mockReturnValue({ status: 'success', transactionId: 'txn-s2s' });
  vi.mocked(normalizePaymentMethod).mockReturnValue('card');
});

async function seedOrder(checkoutId: string, amount = 18000) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, customer_email, items_json, verifone_checkout_id)
     VALUES (?, 'IRJA-20260725-HOOK', 'checkout_created', 'ISK', ?, 'test@test.is', '[]', ?)`,
  )
    .bind(id, amount, checkoutId)
    .run();
  return id;
}

function webhookPayload(eventType: string, checkoutId: string, contentId?: string, eventId?: string) {
  return JSON.stringify({
    eventType,
    objectType: 'StandardEvents',
    eventId: eventId ?? `evt-${Math.random().toString(36).slice(2)}`,
    recordId: checkoutId,
    entityUid: 'test-entity',
    eventDateTime: new Date().toISOString(),
    source: 'Verifone',
    content: contentId
      ? {
          id: contentId,
          amount: 18000,
          currency_code: 'ISK',
          transaction_type: 'SALE',
          transaction_status: 'SETTLED',
          payment_product: 'VISA', // Mock as card payment by default
        }
      : undefined,
  });
}

describe('POST /api/webhooks/verifone', () => {
  it('returns 401 when x-vfi-jws header is missing', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: webhookPayload('Checkout - Transaction succeeded', 'chk-wh-1'),
    });
    expect(resp.status).toBe(401);
  });

  it('returns 401 when signature is invalid', async () => {
    const { verifyVerifoneWebhook } = await import('../src/lib/crypto');
    vi.mocked(verifyVerifoneWebhook).mockResolvedValueOnce(false);

    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'fake.jws.sig' },
      body: webhookPayload('Checkout - Transaction succeeded', 'chk-wh-1'),
    });
    expect(resp.status).toBe(401);
  });

  it('updates order to paid on "Checkout - Transaction succeeded"', async () => {
    const checkoutId = 'chk-wh-paid';
    const orderId = await seedOrder(checkoutId);

    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('Checkout - Transaction succeeded', checkoutId, 'txn-paid-1'),
    });

    expect(resp.status).toBe(200);

    const order = await env.DB.prepare('SELECT status, paid_at, verifone_transaction_id FROM orders WHERE id = ?')
      .bind(orderId)
      .first();
    expect(order!.status).toBe('paid');
    expect(order!.paid_at).not.toBeNull();
    expect(order!.verifone_transaction_id).toBe('txn-s2s');
  });

  it('persists PayPal from a verified payment provider response', async () => {
    const checkoutId = 'chk-wh-paypal';
    const orderId = await seedOrder(checkoutId);
    const { getCheckout, normalizePaymentMethod } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: checkoutId,
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-HOOK',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-paypal-webhook', timestamp: new Date().toISOString() }],
      transaction_id: 'txn-paypal-webhook',
      payment_product: 'PAYPAL',
    });
    vi.mocked(normalizePaymentMethod).mockReturnValue('paypal');

    const response = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('Checkout - Transaction succeeded', checkoutId, 'txn-paypal-webhook'),
    });

    expect(response).toHaveProperty('status', 200);
    const order = await env.DB.prepare('SELECT status, payment_method FROM orders WHERE id = ?').bind(orderId).first();
    expect(order).toMatchObject({ status: 'paid', payment_method: 'paypal' });
    expect(normalizePaymentMethod).toHaveBeenCalledWith('PAYPAL');
  });

  it('updates order to failed on "Checkout - Transaction failed" once the provider confirms it', async () => {
    const checkoutId = 'chk-wh-fail';
    const orderId = await seedOrder(checkoutId);
    const { getCheckout, parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: checkoutId,
      status: 'DECLINED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-HOOK',
      events: [{ type: 'TRANSACTION_FAILED', id: 'txn-fail-s2s', timestamp: new Date().toISOString() }],
    });
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({ status: 'failed', transactionId: 'txn-fail-s2s' });

    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('Checkout - Transaction failed', checkoutId),
    });

    expect(resp.status).toBe(200);

    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('failed');
  });

  it('does not mark an order failed when the provider has not confirmed the failure', async () => {
    // A delayed/stale "Transaction failed" webhook must not flip order state on its
    // own claim — the provider must confirm failure server-to-server first.
    const checkoutId = 'chk-wh-fail-unverified';
    const orderId = await seedOrder(checkoutId);
    const { parseCheckoutResult } = await import('../src/lib/verifone');
    vi.mocked(parseCheckoutResult).mockReturnValueOnce({ status: 'pending' });

    const eventId = 'evt-fail-unverified';
    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('Checkout - Transaction failed', checkoutId, undefined, eventId),
    });

    expect(resp.status).toBe(503);
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('checkout_created');
    const processed = await env.DB.prepare('SELECT 1 FROM processed_webhooks WHERE verifone_event_id = ?')
      .bind(eventId)
      .first();
    expect(processed).toBeNull();
  });

  it('recovers an order from failed to paid once the provider confirms success', async () => {
    // A prior (correctly or incorrectly applied) failed transition must not be a dead
    // end: a later verified success has to be able to override it.
    const checkoutId = 'chk-wh-recover';
    const orderId = await seedOrder(checkoutId);
    await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind('failed', orderId).run();

    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('Checkout - Transaction succeeded', checkoutId, 'txn-recovered'),
    });

    expect(resp.status).toBe(200);
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('paid');
  });

  it('refunds an order that reconciliation already moved from paid to settled', async () => {
    // Daily reconciliation moves paid -> settled before a refund webhook may arrive;
    // that must not strand the refund as a permanently unresolved illegal_transition.
    const checkoutId = 'chk-wh-refund-settled';
    const orderId = await seedOrder(checkoutId);
    await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind('settled', orderId).run();
    const { getCheckout } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: checkoutId,
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-HOOK',
      transaction_id: 'txn-s2s',
      events: [{ type: 'TxnRefundApproved', id: 'refund-settled-1', timestamp: new Date().toISOString() }],
    });

    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('TxnRefundApproved', checkoutId, 'refund-settled-1'),
    });

    expect(resp.status).toBe(200);
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('refunded');
  });

  it('updates order to refunded only after provider API confirmation', async () => {
    const checkoutId = 'chk-wh-refund';
    const orderId = await seedOrder(checkoutId);
    await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind('paid', orderId).run();
    const { getCheckout } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: checkoutId,
      status: 'COMPLETED',
      amount: 18000,
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-HOOK',
      transaction_id: 'txn-s2s',
      events: [{ type: 'TxnRefundApproved', id: 'refund-s2s-1', timestamp: new Date().toISOString() }],
    });

    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('TxnRefundApproved', checkoutId, 'refund-s2s-1'),
    });

    expect(resp.status).toBe(200);

    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('refunded');
  });

  it('does not refund when provider API has not confirmed the refund transaction', async () => {
    const checkoutId = 'chk-wh-refund-pending';
    const orderId = await seedOrder(checkoutId);
    await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind('paid', orderId).run();

    const eventId = 'evt-refund-provider-lag';
    const response = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('TxnRefundApproved', checkoutId, 'refund-not-in-provider-detail', eventId),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
    expect(await response.json()).toMatchObject({ code: 'refund_verification_mismatch' });
    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order?.status).toBe('paid');
    const processed = await env.DB.prepare('SELECT 1 FROM processed_webhooks WHERE verifone_event_id = ?')
      .bind(eventId)
      .first();
    expect(processed).toBeNull();
  });

  it('returns 200 for duplicate eventId (idempotent skip)', async () => {
    const checkoutId = 'chk-wh-dup';
    await seedOrder(checkoutId);
    const payload = webhookPayload('Checkout - Transaction succeeded', checkoutId, 'txn-dup-1', 'evt-dup-fixed');

    await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: payload,
    });

    const resp2 = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: payload,
    });

    expect(resp2.status).toBe(200);
    const data = (await resp2.json()) as { status: string };
    expect(data.status).toBe('already_processed');
  });

  it('rejects oversized webhook bodies before signature verification', async () => {
    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: JSON.stringify({ padding: 'x'.repeat(64 * 1024) }),
    });
    expect(resp.status).toBe(413);
  });

  it('rejects signed events for another Verifone entity', async () => {
    const payload = JSON.parse(webhookPayload('Checkout - Transaction succeeded', 'chk-wh-tenant')) as Record<
      string,
      unknown
    >;
    payload.entityUid = 'other-merchant-entity';
    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: JSON.stringify(payload),
    });
    expect(resp.status).toBe(401);
  });

  it('returns a retryable error for a recognized event before its order mapping exists', async () => {
    const eventId = 'evt-orphan-retry';
    const response = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('Checkout - Transaction succeeded', 'chk-not-persisted-yet', 'txn-orphan', eventId),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    const processed = await env.DB.prepare('SELECT 1 FROM processed_webhooks WHERE verifone_event_id = ?')
      .bind(eventId)
      .first();
    expect(processed).toBeNull();
  });

  it('processes an identical webhook delivered concurrently on two parallel connections exactly once', async () => {
    // Characterizes the race where Verifone (or a retry proxy) delivers the same
    // event on two simultaneous connections: the pre-check (isWebhookProcessed) is
    // not atomic with the write, so both requests can pass it before either has
    // written processed_webhooks. The INSERT OR IGNORE inside processWebhookAtomically
    // is the actual concurrency guard — exactly one request must apply the
    // transition and log an event; the other must observe 'duplicate'.
    const checkoutId = 'chk-wh-concurrent';
    const orderId = await seedOrder(checkoutId);
    const payload = webhookPayload(
      'Checkout - Transaction succeeded',
      checkoutId,
      'txn-concurrent-1',
      'evt-concurrent-1',
    );

    const [respA, respB] = await Promise.all([
      SELF.fetch('https://test.example.com/api/webhooks/verifone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
        body: payload,
      }),
      SELF.fetch('https://test.example.com/api/webhooks/verifone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
        body: payload,
      }),
    ]);

    expect(respA.status).toBe(200);
    expect(respB.status).toBe(200);
    const [dataA, dataB] = [(await respA.json()) as { status: string }, (await respB.json()) as { status: string }];
    const statuses = [dataA.status, dataB.status].sort();
    // Exactly one side applies the transition; the other observes it as already done,
    // whichever of the two race outcomes ('duplicate' from the atomic insert, or
    // 'already_processed' from the earlier pre-check) it lands on.
    expect(statuses[0]).toMatch(/^(already_processed|duplicate)$/);
    expect(statuses[1]).toBe('processed');

    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{
      status: string;
    }>();
    expect(order?.status).toBe('paid');

    const processedCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM processed_webhooks WHERE verifone_event_id = ?',
    )
      .bind('evt-concurrent-1')
      .first<{ count: number }>();
    expect(processedCount?.count).toBe(1);

    const eventCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_events WHERE order_id = ? AND event_type = 'Checkout - Transaction succeeded'",
    )
      .bind(orderId)
      .first<{ count: number }>();
    expect(eventCount?.count).toBe(1);
  });

  it('rejects paid webhook when S2S amount does not match order', async () => {
    const checkoutId = 'chk-wh-amt';
    await seedOrder(checkoutId, 18000);
    const { getCheckout } = await import('../src/lib/verifone');
    vi.mocked(getCheckout).mockResolvedValueOnce({
      id: checkoutId,
      status: 'COMPLETED',
      amount: 1, // attacker-priced amount — must not mark paid
      currency_code: 'ISK',
      merchant_reference: 'IRJA-20260725-HOOK',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-bad', timestamp: new Date().toISOString() }],
      transaction_id: 'txn-bad',
    });

    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('Checkout - Transaction succeeded', checkoutId, 'txn-bad'),
    });

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { status: string };
    expect(data.status).toBe('integrity_mismatch');

    const order = await env.DB.prepare('SELECT status FROM orders WHERE verifone_checkout_id = ?')
      .bind(checkoutId)
      .first();
    expect(order!.status).toBe('checkout_created'); // not paid
  });
});
