/**
 * Irja Payments Gateway — Worker entry point
 *
 * Routes:
 *   GET  /health                    — health check
 *   POST /api/checkout              — create Verifone checkout session
 *   GET  /api/return                — handle redirect back from Verifone
 *   POST /api/webhooks/verifone     — handle Verifone webhook notifications
 *   GET  /api/orders/:id            — order status lookup
 *
 * Cron: daily at 06:00 UTC — Landsbankinn settlement reconciliation
 */

import { Hono } from 'hono';
import type { Env } from './types/env';
import { checkoutRoute } from './routes/checkout';
import { returnRoute } from './routes/return';
import { webhookRoute } from './routes/webhook';
import { orderRoute } from './routes/order';
import { reconcile } from './cron/reconcile';

const app = new Hono<{ Bindings: Env }>();

// ─── Health check ───────────────────────────────────────────────
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT ?? 'unknown',
  });
});

// ─── API routes ──────────────────────────────────────────────────
app.route('/api/checkout', checkoutRoute);
app.route('/api/return', returnRoute);
app.route('/api/webhooks/verifone', webhookRoute);
app.route('/api/orders', orderRoute);

// ─── 404 handler ─────────────────────────────────────────────────
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// ─── Error handler ───────────────────────────────────────────────
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// ─── Export for Cloudflare Workers ───────────────────────────────
export default {
  fetch: app.fetch,

  // Cron trigger handler — Landsbankinn settlement reconciliation
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered:', event.cron, 'at', new Date().toISOString());
    ctx.waitUntil(reconcile(env));
  },
};
