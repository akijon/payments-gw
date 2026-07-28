import { Hono } from 'hono';
import type { Env } from '../types/env';
import { bearerToken } from '../lib/http';

export const orderRoute = new Hono<{ Bindings: Env }>();

orderRoute.get('/:id', async (c) => {
  const orderId = c.req.param('id');
  const { getOrderById, hasOrderAccess } = await import('../lib/db');
  const accessToken = bearerToken(c.req.header('Authorization'));

  if (!(await hasOrderAccess(c.env.DB, orderId, accessToken))) {
    return c.json({ error: 'Valid bearer token required', code: 'unauthorized' }, 401, {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Bearer',
    });
  }

  const order = await getOrderById(c.env.DB, orderId);
  if (!order) {
    return c.json({ error: 'Order not found' }, 404, { 'Cache-Control': 'no-store' });
  }

  const terminal = ['paid', 'failed', 'refunded', 'settled'].includes(order.status);
  return c.json(
    {
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      terminal,
      next_poll_ms: terminal ? null : 3000,
      can_retry: order.status === 'failed',
      amount: order.amount,
      currency: order.currency,
      items: order.items,
      created_at: order.created_at,
      updated_at: order.updated_at,
      paid_at: order.paid_at,
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
});
