import { Hono } from 'hono';
import type { Env } from '../types/env';

export const returnRoute = new Hono<{ Bindings: Env }>();

returnRoute.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  const checkoutId = c.req.query('checkout_id');
  const orderId = c.req.query('order_id');

  if (!orderId) {
    return c.json({ error: 'order_id is required' }, 400);
  }

  const { getOrderById, updateOrderStatus, logPaymentEvent, generateUUID } = await import('../lib/db');
  const { getCheckout, parseCheckoutResult } = await import('../lib/verifone');

  // 1. Look up order
  const order = await getOrderById(c.env.DB, orderId);
  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  // 2. If we have checkout_id, verify server-to-server
  if (checkoutId || order.verifone_checkout_id) {
    const effectiveCheckoutId = checkoutId || order.verifone_checkout_id!;

    try {
      const detail = await getCheckout(c.env, effectiveCheckoutId);
      const result = parseCheckoutResult(detail);

      // 3. Verify transaction_id matches (anti-tampering) if both present
      if (transactionId && detail.transaction_id && transactionId !== detail.transaction_id) {
        console.error('Transaction ID mismatch:', transactionId, 'vs', detail.transaction_id);
        await logPaymentEvent(c.env.DB, {
          id: generateUUID(),
          orderId: order.id,
          eventType: 'transaction_id_mismatch',
          source: 'verifone_api',
          rawPayload: JSON.stringify({ redirect: transactionId, api: detail.transaction_id }),
          verified: true,
        });
        return c.redirect(`${c.env.STOREFRONT_URL}/order/${order.id}?status=error`, 302);
      }

      // 4. Update order based on result
      if (result.status === 'success') {
        await updateOrderStatus(c.env.DB, order.id, 'paid', {
          verifoneTransactionId: result.transactionId,
          paidAt: new Date().toISOString(),
        });
        await logPaymentEvent(c.env.DB, {
          id: generateUUID(),
          orderId: order.id,
          eventType: 'transaction_success',
          source: 'verifone_api',
          verifoneEventId: result.transactionId,
          rawPayload: JSON.stringify(detail),
          verified: true,
        });
        return c.redirect(`${c.env.STOREFRONT_URL}/order/${order.id}?status=paid`, 302);
      } else if (result.status === 'failed') {
        await updateOrderStatus(c.env.DB, order.id, 'failed', {
          verifoneTransactionId: result.transactionId,
        });
        await logPaymentEvent(c.env.DB, {
          id: generateUUID(),
          orderId: order.id,
          eventType: 'transaction_failed',
          source: 'verifone_api',
          verifoneEventId: result.transactionId,
          rawPayload: JSON.stringify(detail),
          verified: true,
        });
        return c.redirect(`${c.env.STOREFRONT_URL}/order/${order.id}?status=failed`, 302);
      }
    } catch (err) {
      console.error('Failed to verify checkout:', err);
      // Don't expose internal errors to customer
      return c.redirect(`${c.env.STOREFRONT_URL}/order/${order.id}?status=pending`, 302);
    }
  }

  // 5. Fallback: redirect to order page with pending status
  return c.redirect(`${c.env.STOREFRONT_URL}/order/${order.id}?status=pending`, 302);
});
