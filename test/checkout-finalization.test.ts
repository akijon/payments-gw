import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  failCheckoutCreationAtomically,
  finalizeCheckoutCreationAtomically,
  reclaimStaleCheckoutAttempt,
  recordCheckoutProviderResult,
} from '../src/lib/db';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_HASH = 'checkout-key-hash';

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events; DELETE FROM processed_webhooks; DELETE FROM orders;',
  );
  await env.DB.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
     VALUES (?, 'IRJA-20260815-ATOMIC', 'pending', 'ISK', 1000, '[]')`,
  )
    .bind(ORDER_ID)
    .run();
  await env.DB.prepare(
    `INSERT INTO checkout_attempts (key_hash, request_hash, order_id, status)
     VALUES (?, 'request-hash', ?, 'processing')`,
  )
    .bind(KEY_HASH, ORDER_ID)
    .run();
});

describe('checkout creation finalization', () => {
  it('keeps the provider result recoverable when finalization rolls back, then commits all state on retry', async () => {
    const checkoutId = 'checkout-atomic-1';
    const checkoutUrl = 'https://pay.example/checkout-atomic-1';
    const providerResultEventId = 'provider-result-event';
    const conflictingOrderId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    await recordCheckoutProviderResult(env.DB, {
      eventId: providerResultEventId,
      orderId: ORDER_ID,
      checkoutId,
      checkoutUrl,
      rawPayload: JSON.stringify({ checkoutUrl }),
    });
    await env.DB.prepare(
      `INSERT INTO orders (
         id, order_number, status, currency, amount, items_json, verifone_checkout_id
       ) VALUES (?, 'IRJA-20260815-CONFLICT', 'checkout_created', 'ISK', 1000, '[]', ?)`,
    )
      .bind(conflictingOrderId, checkoutId)
      .run();

    await expect(
      finalizeCheckoutCreationAtomically(env.DB, {
        keyHash: KEY_HASH,
        orderId: ORDER_ID,
        checkoutId,
        checkoutUrl,
        providerResultEventId,
      }),
    ).rejects.toThrow();

    const rolledBackOrder = await env.DB.prepare('SELECT status, verifone_checkout_id FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ status: string; verifone_checkout_id: string | null }>();
    const rolledBackAttempt = await env.DB.prepare(
      'SELECT status, checkout_url FROM checkout_attempts WHERE key_hash = ?',
    )
      .bind(KEY_HASH)
      .first<{ status: string; checkout_url: string | null }>();
    const recoverableEvent = await env.DB.prepare('SELECT event_type, verified FROM payment_events WHERE id = ?')
      .bind(providerResultEventId)
      .first<{ event_type: string; verified: number }>();
    expect(rolledBackOrder).toEqual({ status: 'pending', verifone_checkout_id: null });
    expect(rolledBackAttempt).toEqual({ status: 'processing', checkout_url: null });
    expect(recoverableEvent).toEqual({ event_type: 'checkout_provider_result', verified: 1 });

    await env.DB.prepare('UPDATE orders SET verifone_checkout_id = NULL WHERE id = ?').bind(conflictingOrderId).run();
    await expect(
      finalizeCheckoutCreationAtomically(env.DB, {
        keyHash: KEY_HASH,
        orderId: ORDER_ID,
        checkoutId,
        checkoutUrl,
        providerResultEventId,
      }),
    ).resolves.toBe(true);

    const committedOrder = await env.DB.prepare('SELECT status, verifone_checkout_id FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ status: string; verifone_checkout_id: string | null }>();
    const committedAttempt = await env.DB.prepare(
      'SELECT status, checkout_url FROM checkout_attempts WHERE key_hash = ?',
    )
      .bind(KEY_HASH)
      .first<{ status: string; checkout_url: string | null }>();
    const event = await env.DB.prepare('SELECT event_type, verified FROM payment_events WHERE id = ?')
      .bind(providerResultEventId)
      .first<{ event_type: string; verified: number }>();
    expect(committedOrder).toEqual({ status: 'checkout_created', verifone_checkout_id: checkoutId });
    expect(committedAttempt).toEqual({ status: 'completed', checkout_url: checkoutUrl });
    expect(event).toEqual({ event_type: 'checkout_created', verified: 1 });
  });

  it('does not reclaim a stale attempt after its provider result is recoverable', async () => {
    const checkoutUrl = 'https://pay.example/checkout-recoverable';
    await recordCheckoutProviderResult(env.DB, {
      eventId: 'recoverable-provider-event',
      orderId: ORDER_ID,
      checkoutId: 'checkout-recoverable',
      checkoutUrl,
      rawPayload: JSON.stringify({ checkoutUrl }),
    });
    await env.DB.prepare("UPDATE checkout_attempts SET updated_at = '2000-01-01 00:00:00' WHERE key_hash = ?")
      .bind(KEY_HASH)
      .run();

    const result = await reclaimStaleCheckoutAttempt(env.DB, {
      keyHash: KEY_HASH,
      requestHash: 'request-hash',
      orderId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });

    expect(result.reclaimed).toBe(false);
    expect(result.attempt.order_id).toBe(ORDER_ID);
  });

  it('rolls back provider-failure state when its audit insert fails, then commits all failure state on retry', async () => {
    await env.DB.prepare(
      `INSERT INTO payment_events (id, order_id, event_type, source, verified)
       VALUES ('failure-event-conflict', ?, 'preexisting', 'test', 0)`,
    )
      .bind(ORDER_ID)
      .run();

    await expect(
      failCheckoutCreationAtomically(env.DB, {
        keyHash: KEY_HASH,
        orderId: ORDER_ID,
        eventId: 'failure-event-conflict',
        rawPayload: '{"attempt":1}',
      }),
    ).rejects.toThrow();

    const rolledBackOrder = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ status: string }>();
    const rolledBackAttempt = await env.DB.prepare('SELECT status FROM checkout_attempts WHERE key_hash = ?')
      .bind(KEY_HASH)
      .first<{ status: string }>();
    expect(rolledBackOrder?.status).toBe('pending');
    expect(rolledBackAttempt?.status).toBe('processing');

    await expect(
      failCheckoutCreationAtomically(env.DB, {
        keyHash: KEY_HASH,
        orderId: ORDER_ID,
        eventId: 'failure-event-success',
        rawPayload: '{"attempt":2}',
      }),
    ).resolves.toBe(true);

    const committedOrder = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ status: string }>();
    const committedAttempt = await env.DB.prepare('SELECT status FROM checkout_attempts WHERE key_hash = ?')
      .bind(KEY_HASH)
      .first<{ status: string }>();
    const event = await env.DB.prepare('SELECT event_type, verified FROM payment_events WHERE id = ?')
      .bind('failure-event-success')
      .first<{ event_type: string; verified: number }>();
    expect(committedOrder?.status).toBe('failed');
    expect(committedAttempt?.status).toBe('failed');
    expect(event).toEqual({ event_type: 'checkout_creation_failed', verified: 0 });
  });
});
