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
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Env } from './types/env';
import { checkoutRoute } from './routes/checkout';
import { returnRoute } from './routes/return';
import { webhookRoute } from './routes/webhook';
import { orderRoute } from './routes/order';
import { reconcile } from './cron/reconcile';

const app = new Hono<{ Bindings: Env }>();

// ─── Security headers on all responses ───────────────────────────
app.use(
  '*',
  secureHeaders({
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'no-referrer',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  }),
);

app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

// ─── CORS: storefront origin only (webhooks are server-to-server, no CORS) ─
app.use('/api/checkout/*', async (c, next) => {
  const origin = c.env.STOREFRONT_URL;
  const middleware = cors({
    origin,
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Idempotency-Key'],
    maxAge: 86400,
  });
  return middleware(c, next);
});

app.use('/api/orders/*', async (c, next) => {
  const origin = c.env.STOREFRONT_URL;
  const middleware = cors({
    origin,
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Authorization'],
    maxAge: 86400,
  });
  return middleware(c, next);
});

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
  console.error(
    JSON.stringify({
      message: 'Unhandled request error',
      error: err instanceof Error ? err.name : 'unknown',
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      cf_ray: c.req.header('CF-Ray') ?? null,
    }),
  );
  return c.json({ error: 'Internal Server Error', code: 'internal_error' }, 500);
});

// ─── Export for Cloudflare Workers ───────────────────────────────
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(JSON.stringify({ message: 'Reconciliation cron triggered', cron: event.cron }));
    ctx.waitUntil(reconcile(env));
  },
};
