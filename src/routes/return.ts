import { Hono } from 'hono';
import type { Env } from '../types/env';
import { processReturnUseCase } from '../usecases/process-return';

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

  const outcome = await processReturnUseCase(c.env, { orderId, transactionId, checkoutId });
  if (!outcome.found) {
    return c.json({ error: 'Order not found' }, 404);
  }
  return c.redirect(storefrontOrderUrl(c.env.STOREFRONT_URL, orderId, outcome.status), 303);
});
