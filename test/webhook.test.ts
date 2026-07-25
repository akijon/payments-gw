/**
 * Webhook route — integration tests via SELF + vi.mock
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/types/env';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

vi.mock('../src/lib/crypto', () => ({
  verifyVerifoneWebhook: vi.fn().mockResolvedValue(true),
}));

beforeEach(async () => {
  await env.DB.exec('DELETE FROM orders;');
  await env.DB.exec('DELETE FROM payment_events;');
  await env.DB.exec('DELETE FROM processed_webhooks;');
});

async function seedOrder(checkoutId: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, customer_email, items_json, verifone_checkout_id)
     VALUES (?, 'IRJA-20260725-HOOK', 'checkout_created', 'ISK', 18000, 'test@test.is', '[]', ?)`
  ).bind(id, checkoutId).run();
  return id;
}

function webhookPayload(eventType: string, checkoutId: string, contentId?: string) {
  return JSON.stringify({
    eventType,
    objectType: 'StandardEvents',
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    recordId: checkoutId,
    entityUid: 'test-entity',
    eventDateTime: new Date().toISOString(),
    source: 'Verifone',
    content: contentId ? { id: contentId, amount: 18000, currency_code: 'ISK', transaction_type: 'SALE', transaction_status: 'SETTLED' } : undefined,
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

    const order = await env.DB.prepare('SELECT status, paid_at, verifone_transaction_id FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('paid');
    expect(order!.paid_at).not.toBeNull();
    expect(order!.verifone_transaction_id).toBe('txn-paid-1');
  });

  it('updates order to failed on "Checkout - Transaction failed"', async () => {
    const checkoutId = 'chk-wh-fail';
    const orderId = await seedOrder(checkoutId);

    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('Checkout - Transaction failed', checkoutId),
    });

    expect(resp.status).toBe(200);

    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('failed');
  });

  it('updates order to refunded on "TxnRefundApproved"', async () => {
    const checkoutId = 'chk-wh-refund';
    const orderId = await seedOrder(checkoutId);
    // Set order to paid first
    await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind('paid', orderId).run();

    const resp = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: webhookPayload('TxnRefundApproved', checkoutId),
    });

    expect(resp.status).toBe(200);

    const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(order!.status).toBe('refunded');
  });

  it('returns 200 for duplicate eventId (idempotent skip)', async () => {
    const checkoutId = 'chk-wh-dup';
    const payload = webhookPayload('Checkout - Transaction succeeded', checkoutId, 'txn-dup-1');

    // First request
    await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: payload,
    });

    // Second request with same payload
    const resp2 = await SELF.fetch('https://test.example.com/api/webhooks/verifone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vfi-jws': 'valid.jws.sig' },
      body: payload,
    });

    expect(resp2.status).toBe(200);
    const data = await resp2.json() as { status: string };
    expect(data.status).toBe('already_processed');
  });
});
