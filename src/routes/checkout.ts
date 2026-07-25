import { Hono } from 'hono';
import type { Env } from '../types/env';
import type { LineItem } from '../types/api';

export const checkoutRoute = new Hono<{ Bindings: Env }>();

checkoutRoute.post('/', async (c) => {
  // 1. Parse and validate request body
  const body = await c.req.json<{
    items?: LineItem[];
    customer_email?: string;
    customer_name?: string;
  }>();

  if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'items is required and must be a non-empty array' }, 400);
  }

  // 2. Calculate total server-side (never trust client amount)
  const totalAmount = body.items.reduce((sum, item) => {
    return sum + (item.total_amount ?? item.unit_price * item.quantity);
  }, 0);

  if (totalAmount <= 0) {
    return c.json({ error: 'Total amount must be positive' }, 400);
  }

  // 3. Create order in D1
  const { createOrder, generateUUID, generateOrderNumber, updateOrderStatus, logPaymentEvent } = await import('../lib/db');

  const orderId = generateUUID();
  const orderNumber = generateOrderNumber();

  await createOrder(c.env.DB, {
    id: orderId,
    orderNumber,
    currency: 'ISK',
    amount: totalAmount,
    customerEmail: body.customer_email,
    customerName: body.customer_name,
    items: body.items,
  });

  // 4. Create Verifone checkout session
  const { createCheckout } = await import('../lib/verifone');
  const returnUrl = `${c.env.STOREFRONT_URL}/api/return?order_id=${orderId}`;

  let checkoutResult;
  try {
    checkoutResult = await createCheckout(c.env, {
      orderNumber,
      amount: totalAmount,
      currency: 'ISK',
      returnUrl,
    });
  } catch (err) {
    console.error('Failed to create Verifone checkout:', err);
    await updateOrderStatus(c.env.DB, orderId, 'failed');
    await logPaymentEvent(c.env.DB, {
      id: generateUUID(),
      orderId,
      eventType: 'checkout_creation_failed',
      source: 'verifone_api',
      rawPayload: JSON.stringify({ error: String(err) }),
      verified: false,
    });
    return c.json({ error: 'Failed to create checkout session' }, 502);
  }

  // 5. Store checkout_id on order
  await updateOrderStatus(c.env.DB, orderId, 'checkout_created', {
    verifoneCheckoutId: checkoutResult.checkoutId,
  });

  await logPaymentEvent(c.env.DB, {
    id: generateUUID(),
    orderId,
    eventType: 'checkout_created',
    source: 'verifone_api',
    verifoneEventId: checkoutResult.checkoutId,
    rawPayload: JSON.stringify(checkoutResult),
    verified: true,
  });

  // 6. Return checkout URL to storefront
  return c.json({
    checkout_url: checkoutResult.checkoutUrl,
    order_id: orderId,
    order_number: orderNumber,
  });
});
