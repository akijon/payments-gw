import { Hono } from 'hono';
import type { Env } from '../types/env';
import { acceptsJson, readTextBody, RequestBodyTooLargeError } from '../lib/http';
import { processWebhookUseCase } from '../usecases/process-webhook';

export const webhookRoute = new Hono<{ Bindings: Env }>();

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_JWS_HEADER_BYTES = 8 * 1024;

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

  const outcome = await processWebhookUseCase(c.env, rawBody);
  return c.json(outcome.body, outcome.status, outcome.headers);
});
