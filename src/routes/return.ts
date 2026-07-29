import { Hono } from 'hono';
import type { Env } from '../types/env';
import { PaymentIntegrityError, assertCheckoutIntegrity } from '../lib/payment-integrity';

export const returnRoute = new Hono<{ Bindings: Env }>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storefrontOrderUrl(storefrontUrl: string, orderId: string, status: string): string {
  const url = new URL(`/order/${orderId}`, storefrontUrl);
  url.searchParams.set('status', status);
  return url.toString();
}

returnRoute.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  const checkoutId = c.req.query('checkout_id');
  const orderId = c.req.query('order_id');

  if (!orderId) {
    return c.json({ error: 'order_id is required', code: 'validation' }, 400);
  }
  if (!UUID_RE.test(orderId)) {
    return c.json({ error: 'Invalid order_id', code: 'validation' }, 400);
  }

  const { getOrderById, logPaymentEvent, processReturnAtomically, generateUUID } = await import('../lib/db');
  const { getCheckout, parseCheckoutResult } = await import('../lib/verifone');
  const order = await getOrderById(c.env.DB, orderId);

  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  const redirect = (status: string) => c.redirect(storefrontOrderUrl(c.env.STOREFRONT_URL, order.id, status), 303);

  if (['paid', 'refunded', 'settled'].includes(order.status)) {
    return redirect(order.status);
  }

  const storedCheckoutId = order.verifone_checkout_id;
  if (!storedCheckoutId) {
    return redirect('pending');
  }

  if (checkoutId && checkoutId !== storedCheckoutId) {
    await logPaymentEvent(c.env.DB, {
      id: generateUUID(),
      orderId: order.id,
      eventType: 'checkout_id_mismatch',
      source: 'verifone_return',
      rawPayload: JSON.stringify({ received_checkout_id: checkoutId }),
      verified: false,
    });
    return redirect('error');
  }

  try {
    const detail = await getCheckout(c.env, storedCheckoutId);
    const result = parseCheckoutResult(detail);

    try {
      assertCheckoutIntegrity(detail, {
        checkoutId: storedCheckoutId,
        amount: order.amount,
        currency: order.currency,
        merchantReference: order.order_number,
        requireTransactionId: result.status === 'success',
      });
    } catch (error) {
      if (!(error instanceof PaymentIntegrityError)) throw error;
      console.error(
        JSON.stringify({
          message: 'Verifone checkout integrity check failed',
          order_id: order.id,
          code: error.code,
        }),
      );
      await logPaymentEvent(c.env.DB, {
        id: generateUUID(),
        orderId: order.id,
        eventType: error.code,
        source: 'verifone_return',
        rawPayload: JSON.stringify(error.details),
        verified: true,
      });
      return redirect('error');
    }

    const verifiedTransactionId = detail.transaction_id;
    if (transactionId && transactionId !== verifiedTransactionId) {
      await logPaymentEvent(c.env.DB, {
        id: generateUUID(),
        orderId: order.id,
        eventType: 'transaction_id_mismatch',
        source: 'verifone_return',
        rawPayload: JSON.stringify({ received_transaction_id: transactionId }),
        verified: true,
      });
      return redirect('error');
    }

    if (result.status === 'success') {
      const applied = await processReturnAtomically(c.env.DB, {
        orderId: order.id,
        status: 'paid',
        eventType: 'transaction_success',
        transactionId: verifiedTransactionId,
        rawPayload: JSON.stringify({
          checkout_id: detail.id,
          amount: detail.amount,
          currency: detail.currency_code,
        }),
      });
      return redirect(applied ? 'paid' : ((await getOrderById(c.env.DB, order.id))?.status ?? 'pending'));
    }

    if (result.status === 'failed') {
      const applied = await processReturnAtomically(c.env.DB, {
        orderId: order.id,
        status: 'failed',
        eventType: 'transaction_failed',
        transactionId: verifiedTransactionId,
        rawPayload: JSON.stringify({
          checkout_id: detail.id,
          amount: detail.amount,
          currency: detail.currency_code,
        }),
      });
      return redirect(applied ? 'failed' : ((await getOrderById(c.env.DB, order.id))?.status ?? 'pending'));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Verifone return verification temporarily failed',
        order_id: order.id,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
  }

  return redirect('pending');
});
