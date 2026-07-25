import { Hono } from 'hono';
import type { Env } from '../types/env';

export const orderRoute = new Hono<{ Bindings: Env }>();

orderRoute.get('/:id', async (c) => {
  const orderId = c.req.param('id');
  const { getOrderById } = await import('../lib/db');

  const order = await getOrderById(c.env.DB, orderId);
  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  return c.json({
    id: order.id,
    order_number: order.order_number,
    status: order.status,
    amount: order.amount,
    currency: order.currency,
    items: order.items,
    created_at: order.created_at,
    paid_at: order.paid_at,
  });
});
