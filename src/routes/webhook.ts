import { Hono } from 'hono';
import type { Env } from '../types/env';
import type { VerifoneWebhookPayload } from '../types/api';
import { acceptsJson, readTextBody, RequestBodyTooLargeError } from '../lib/http';
import { PaymentIntegrityError, assertCheckoutIntegrity } from '../lib/payment-integrity';

export const webhookRoute = new Hono<{ Bindings: Env }>();

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_JWS_HEADER_BYTES = 8 * 1024;
const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

type WebhookOrderStatus = 'paid' | 'failed' | 'refunded';

function eventOrderStatus(eventType: string): WebhookOrderStatus | null {
  switch (eventType) {
    case 'Checkout - Transaction succeeded':
    case 'TxnSaleApproved':
      return 'paid';
    case 'Checkout - Transaction failed':
    case 'TxnSaleDeclined':
      return 'failed';
    case 'TxnRefundApproved':
      return 'refunded';
    default:
      return null;
  }
}

function validPayload(value: unknown): value is VerifoneWebhookPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<VerifoneWebhookPayload>;
  return (
    typeof payload.eventId === 'string' &&
    ID_RE.test(payload.eventId) &&
    typeof payload.eventType === 'string' &&
    payload.eventType.length > 0 &&
    payload.eventType.length <= 128 &&
    typeof payload.recordId === 'string' &&
    ID_RE.test(payload.recordId) &&
    typeof payload.entityUid === 'string' &&
    payload.entityUid.length > 0 &&
    payload.entityUid.length <= 256
  );
}

function auditPayload(payload: VerifoneWebhookPayload, checkoutId: string): string {
  return JSON.stringify({
    event_id: payload.eventId,
    event_type: payload.eventType,
    checkout_id: checkoutId,
    event_datetime: payload.eventDateTime,
    transaction_id: payload.content?.id,
    transaction_type: payload.content?.transaction_type,
    transaction_status: payload.content?.transaction_status,
  });
}

webhookRoute.post('/', async (c) => {
  if (!acceptsJson(c.req.raw)) {
    return c.json({ error: 'Content-Type must be application/json', code: 'unsupported_media_type' }, 415);
  }

  const jwsHeader = c.req.header('x-vfi-jws');
  if (!jwsHeader || new TextEncoder().encode(jwsHeader).byteLength > MAX_JWS_HEADER_BYTES) {
    return c.json({ error: 'Valid x-vfi-jws header required', code: 'unauthorized' }, 401);
  }

  let rawBody: string;
  try {
    rawBody = await readTextBody(c.req.raw, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ error: 'Webhook payload too large', code: 'request_too_large' }, 413);
    }
    return c.json({ error: 'Invalid request body', code: 'validation' }, 400);
  }

  const { verifyVerifoneWebhook } = await import('../lib/crypto');
  let verified = false;
  try {
    verified = await verifyVerifoneWebhook(rawBody, jwsHeader, c.env);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Webhook signature verification failed',
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
  }
  if (!verified) {
    return c.json({ error: 'Invalid signature', code: 'unauthorized' }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return c.json({ error: 'Invalid JSON payload', code: 'validation' }, 400);
  }
  if (!validPayload(parsed)) {
    return c.json({ error: 'Malformed webhook payload', code: 'validation' }, 400);
  }
  const payload = parsed;

  if (payload.entityUid !== c.env.VERIFONE_ENTITY_ID) {
    console.error(JSON.stringify({ message: 'Webhook entity mismatch', event_id: payload.eventId }));
    return c.json({ error: 'Webhook entity mismatch', code: 'unauthorized' }, 401);
  }

  const {
    isWebhookProcessed,
    markWebhookProcessed,
    logPaymentEvent,
    getOrderByCheckoutId,
    processWebhookAtomically,
    generateUUID,
  } = await import('../lib/db');

  if (await isWebhookProcessed(c.env.DB, payload.eventId)) {
    return c.json({ status: 'already_processed' }, 200);
  }

  const orderStatus = eventOrderStatus(payload.eventType);
  const checkoutId = payload.recordId;
  if (!orderStatus) {
    await markWebhookProcessed(c.env.DB, payload.eventId, payload.eventType);
    return c.json({ status: 'ignored' }, 200);
  }

  const order = await getOrderByCheckoutId(c.env.DB, checkoutId);
  if (!order) {
    console.warn(
      JSON.stringify({
        message: 'Webhook has no matching order',
        event_id: payload.eventId,
        checkout_id: checkoutId,
      }),
    );
    // A recognized event can race with persistence of the checkout-to-order mapping.
    // Do not consume it: a retry can succeed after checkout creation finishes.
    return c.json({ error: 'Order mapping not available yet', code: 'order_mapping_pending' }, 503, {
      'Retry-After': '5',
    });
  }

  let verifiedTransactionId: string | undefined;
  if (orderStatus === 'paid' || orderStatus === 'refunded') {
    try {
      const { getCheckout, parseCheckoutResult } = await import('../lib/verifone');
      const detail = await getCheckout(c.env, checkoutId);
      assertCheckoutIntegrity(detail, {
        checkoutId,
        amount: order.amount,
        currency: order.currency,
        merchantReference: order.order_number,
        requireTransactionId: orderStatus === 'paid',
      });
      if (orderStatus === 'paid') {
        const result = parseCheckoutResult(detail);
        if (result.status !== 'success') {
          return c.json({ error: 'Checkout not yet confirmed paid', code: 'verification_pending' }, 503);
        }
        verifiedTransactionId = detail.transaction_id;
      } else {
        const refund = payload.content;
        const refundEvent = refund?.id
          ? detail.events?.some((event) => event.id === refund.id && /refund/i.test(event.type))
          : false;
        if (
          !refundEvent ||
          !Number.isSafeInteger(refund?.amount) ||
          refund?.amount !== order.amount ||
          refund?.currency_code !== order.currency
        ) {
          throw new PaymentIntegrityError('refund_verification_mismatch', {
            refund_transaction_id: refund?.id ?? null,
            received_amount: refund?.amount ?? null,
            received_currency: refund?.currency_code ?? null,
          });
        }
      }
    } catch (error) {
      if (error instanceof PaymentIntegrityError) {
        console.error(
          JSON.stringify({
            message: 'Webhook checkout integrity check failed',
            order_id: order.id,
            event_id: payload.eventId,
            code: error.code,
          }),
        );
        if (error.code === 'refund_verification_mismatch') {
          return c.json({ error: 'Refund verification pending', code: error.code }, 503, { 'Retry-After': '10' });
        }
        await logPaymentEvent(c.env.DB, {
          id: generateUUID(),
          orderId: order.id,
          eventType: error.code,
          source: 'verifone_webhook',
          verifoneEventId: payload.eventId,
          rawPayload: JSON.stringify(error.details),
          verified: true,
        });
        await markWebhookProcessed(c.env.DB, payload.eventId, payload.eventType);
        return c.json({ status: 'integrity_mismatch', code: error.code }, 200);
      }

      console.error(
        JSON.stringify({
          message: 'Webhook server-to-server verification failed',
          order_id: order.id,
          event_id: payload.eventId,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return c.json({ error: 'Verification temporarily unavailable', code: 'verification_unavailable' }, 503);
    }
  }

  const terminal = new Set(['paid', 'refunded', 'settled']);
  if (terminal.has(order.status) && orderStatus !== 'refunded') {
    await markWebhookProcessed(c.env.DB, payload.eventId, payload.eventType);
    return c.json({ status: 'already_terminal' }, 200);
  }

  const outcome = await processWebhookAtomically(c.env.DB, {
    eventId: payload.eventId,
    eventType: payload.eventType,
    orderId: order.id,
    status: orderStatus,
    rawPayload: auditPayload(payload, checkoutId),
    verifoneTransactionId: verifiedTransactionId,
  });
  return c.json({ status: outcome === 'applied' ? 'processed' : outcome }, 200);
});
