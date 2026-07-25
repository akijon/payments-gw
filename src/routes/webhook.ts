import { Hono } from 'hono';
import type { Env } from '../types/env';
import type { VerifoneWebhookPayload } from '../types/api';

export const webhookRoute = new Hono<{ Bindings: Env }>();

webhookRoute.post('/', async (c) => {
  // 1. Get raw body for signature verification (do NOT parse JSON first)
  const rawBody = await c.req.text();

  // 2. Get JWS signature header
  const jwsHeader = c.req.header('x-vfi-jws');
  if (!jwsHeader) {
    return c.json({ error: 'Missing x-vfi-jws header' }, 401);
  }

  // 3. Verify JWS signature
  const { verifyVerifoneWebhook } = await import('../lib/crypto');

  let verified = false;
  try {
    verified = await verifyVerifoneWebhook(rawBody, jwsHeader, c.env);
  } catch (err) {
    console.error('Webhook signature verification error:', err);
    return c.json({ error: 'Signature verification failed' }, 401);
  }

  if (!verified) {
    console.error('Webhook signature invalid');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // 4. Parse JSON body
  const payload = JSON.parse(rawBody) as VerifoneWebhookPayload;

  // 5. Check idempotency
  const { isWebhookProcessed, markWebhookProcessed, logPaymentEvent, getOrderByCheckoutId, updateOrderStatus, generateUUID } = await import('../lib/db');

  const alreadyProcessed = await isWebhookProcessed(c.env.DB, payload.eventId);
  if (alreadyProcessed) {
    // Return 200 to stop retries
    return c.json({ status: 'already_processed' }, 200);
  }

  // 6. Mark as processed
  await markWebhookProcessed(c.env.DB, payload.eventId, payload.eventType);

  // 7. Determine event type and update order
  let eventType = payload.eventType;
  let orderStatus: 'paid' | 'failed' | 'refunded' | null = null;

  switch (payload.eventType) {
    case 'Checkout - Transaction succeeded':
    case 'TxnSaleApproved':
      orderStatus = 'paid';
      break;
    case 'Checkout - Transaction failed':
    case 'TxnSaleDeclined':
      orderStatus = 'failed';
      break;
    case 'TxnRefundApproved':
      orderStatus = 'refunded';
      break;
    default:
      // Log but don't update order for unknown events
      console.log('Unhandled webhook event type:', payload.eventType);
  }

  // 8. Find and update order if we have a checkout ID
  const checkoutId = payload.recordId;
  if (orderStatus && checkoutId) {
    const order = await getOrderByCheckoutId(c.env.DB, checkoutId);
    if (order) {
      const extra: { paidAt?: string; verifoneTransactionId?: string } = {};
      if (orderStatus === 'paid') {
        extra.paidAt = new Date().toISOString();
        if (payload.content?.id) extra.verifoneTransactionId = payload.content.id;
      }

      await updateOrderStatus(c.env.DB, order.id, orderStatus, extra);
      await logPaymentEvent(c.env.DB, {
        id: generateUUID(),
        orderId: order.id,
        eventType,
        source: 'verifone_webhook',
        verifoneEventId: payload.eventId,
        rawPayload: rawBody,
        verified: true,
      });
    }
  }

  // 9. Return 200
  return c.json({ status: 'processed' }, 200);
});
