/**
 * Process-webhook use case — framework-free (no Hono). Given a Verifone
 * webhook body already authenticated by JWS signature verification, validates
 * the payload shape, enforces idempotency, re-verifies server-to-server, and
 * applies the resulting order transition. The route adapter
 * (src/routes/webhook.ts) owns JWS header/signature verification and body
 * reading — transport-level authentication concerns.
 */

import type { Env } from '../types/env';
import type { VerifoneWebhookPayload, PaymentMethod } from '../types/api';
import { PaymentIntegrityError, assertCheckoutIntegrity } from '../lib/payment-integrity';

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

type WebhookOrderStatus = 'paid' | 'failed' | 'refunded';

export interface WebhookOutcome {
  status: 200 | 400 | 401 | 503;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

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

/** `rawBody` is the JSON text of a webhook whose JWS signature has already been verified. */
export async function processWebhookUseCase(env: Env, rawBody: string): Promise<WebhookOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return { status: 400, body: { error: 'Invalid JSON payload', code: 'validation' } };
  }
  if (!validPayload(parsed)) {
    return { status: 400, body: { error: 'Malformed webhook payload', code: 'validation' } };
  }
  const payload = parsed;

  if (payload.entityUid !== env.VERIFONE_ENTITY_ID) {
    console.error(JSON.stringify({ message: 'Webhook entity mismatch', event_id: payload.eventId }));
    return { status: 401, body: { error: 'Webhook entity mismatch', code: 'unauthorized' } };
  }

  const {
    isWebhookProcessed,
    markWebhookProcessed,
    logPaymentEvent,
    getOrderByCheckoutId,
    processWebhookAtomically,
    generateUUID,
  } = await import('../lib/db');

  if (await isWebhookProcessed(env.DB, payload.eventId)) {
    return { status: 200, body: { status: 'already_processed' } };
  }

  const orderStatus = eventOrderStatus(payload.eventType);
  const checkoutId = payload.recordId;
  if (!orderStatus) {
    await markWebhookProcessed(env.DB, payload.eventId, payload.eventType);
    return { status: 200, body: { status: 'ignored' } };
  }

  const order = await getOrderByCheckoutId(env.DB, checkoutId);
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
    return {
      status: 503,
      body: { error: 'Order mapping not available yet', code: 'order_mapping_pending' },
      headers: { 'Retry-After': '5' },
    };
  }

  let verifiedTransactionId: string | undefined;
  let paymentMethod: PaymentMethod | undefined;
  if (orderStatus === 'paid' || orderStatus === 'refunded' || orderStatus === 'failed') {
    try {
      const { getCheckout, parseCheckoutResult, normalizePaymentMethod } = await import('../lib/verifone');
      const detail = await getCheckout(env, checkoutId);
      assertCheckoutIntegrity(detail, {
        checkoutId,
        amount: order.amount,
        currency: order.currency,
        merchantReference: order.order_number,
        requireTransactionId: orderStatus === 'paid',
      });

      // Extract payment method from provider response and webhook content
      const paymentMethodFromDetail = normalizePaymentMethod(detail.payment_product);
      const paymentMethodFromWebhook = normalizePaymentMethod(payload.content?.payment_product);
      paymentMethod = paymentMethodFromDetail !== 'card' ? paymentMethodFromDetail : paymentMethodFromWebhook;
      if (orderStatus === 'paid' || orderStatus === 'failed') {
        const result = parseCheckoutResult(detail);
        const expected = orderStatus === 'paid' ? 'success' : 'failed';
        if (result.status !== expected) {
          // Fail closed: a webhook claiming an outcome the provider does not yet
          // (or does not) confirm must not change order state. Do not mark the
          // event processed, so a legitimate confirmation can still apply later.
          return {
            status: 503,
            body: { error: `Checkout not yet confirmed ${orderStatus}`, code: 'verification_pending' },
          };
        }
        if (orderStatus === 'paid') {
          verifiedTransactionId = detail.transaction_id;
        }
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
          return {
            status: 503,
            body: { error: 'Refund verification pending', code: error.code },
            headers: { 'Retry-After': '10' },
          };
        }
        await logPaymentEvent(env.DB, {
          id: generateUUID(),
          orderId: order.id,
          eventType: error.code,
          source: 'verifone_webhook',
          verifoneEventId: payload.eventId,
          rawPayload: JSON.stringify(error.details),
          verified: true,
        });
        await markWebhookProcessed(env.DB, payload.eventId, payload.eventType);
        return { status: 200, body: { status: 'integrity_mismatch', code: error.code } };
      }

      console.error(
        JSON.stringify({
          message: 'Webhook server-to-server verification failed',
          order_id: order.id,
          event_id: payload.eventId,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return { status: 503, body: { error: 'Verification temporarily unavailable', code: 'verification_unavailable' } };
    }
  }

  const terminal = new Set(['paid', 'refunded', 'settled']);
  if (terminal.has(order.status) && orderStatus !== 'refunded') {
    await markWebhookProcessed(env.DB, payload.eventId, payload.eventType);
    return { status: 200, body: { status: 'already_terminal' } };
  }

  const outcome = await processWebhookAtomically(env.DB, {
    eventId: payload.eventId,
    eventType: payload.eventType,
    orderId: order.id,
    status: orderStatus,
    rawPayload: auditPayload(payload, checkoutId),
    verifoneTransactionId: verifiedTransactionId,
    paymentMethod,
  });
  return { status: 200, body: { status: outcome === 'applied' ? 'processed' : outcome } };
}
