import { Hono } from 'hono';
import type { Env } from '../types/env';
import { enforceCheckoutRateLimit } from '../lib/rate-limit';
import { acceptsJson, readTextBody, RequestBodyTooLargeError } from '../lib/http';
import { isValidKennitala } from '../lib/invoice-computation';
import { createCheckoutUseCase } from '../usecases/create-checkout';

const MAX_CHECKOUT_BODY_BYTES = 16 * 1024;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const checkoutRoute = new Hono<{ Bindings: Env }>();

checkoutRoute.post('/', async (c) => {
  const rateLimit = await enforceCheckoutRateLimit({
    environment: c.env.ENVIRONMENT,
    clientIp: c.req.header('CF-Connecting-IP'),
    limiter: c.env.CHECKOUT_RATE_LIMITER,
  });
  if (!rateLimit.allowed) {
    return c.json(
      { error: rateLimit.status === 429 ? 'Too many checkout attempts' : 'Checkout temporarily unavailable' },
      rateLimit.status!,
    );
  }

  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return c.json(
      {
        error: 'Idempotency-Key must be 16-128 characters using letters, numbers, dot, underscore, colon, or hyphen',
        code: 'idempotency_key_required',
      },
      400,
    );
  }

  if (!acceptsJson(c.req.raw)) {
    return c.json({ error: 'Content-Type must be application/json', code: 'unsupported_media_type' }, 415);
  }

  let body: {
    items?: unknown;
    customer_email?: unknown;
    customer_name?: unknown;
    buyer_kennitala?: unknown;
    unit_price?: unknown;
    total_amount?: unknown;
    amount?: unknown;
  };
  try {
    const rawBody = await readTextBody(c.req.raw, MAX_CHECKOUT_BODY_BYTES);
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return c.json({ error: 'JSON body must be an object', code: 'validation' }, 400);
    }
    body = parsed as typeof body;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ error: 'Request body too large', code: 'request_too_large' }, 413);
    }
    return c.json({ error: 'Invalid JSON body', code: 'validation' }, 400);
  }

  const allowedFields = new Set(['items', 'customer_email', 'customer_name', 'buyer_kennitala']);
  const unexpectedFields = Object.keys(body).filter((field) => !allowedFields.has(field));
  if (unexpectedFields.length > 0) {
    const moneyFields = unexpectedFields.filter((field) => ['amount', 'unit_price', 'total_amount'].includes(field));
    return c.json(
      {
        error:
          moneyFields.length > 0
            ? 'Client-controlled money fields are not allowed'
            : `Unexpected checkout field: ${unexpectedFields[0]}`,
        code: moneyFields.length > 0 ? 'price_manipulation' : 'validation',
      },
      400,
    );
  }

  let customerEmail: string | undefined;
  if (body.customer_email !== undefined && body.customer_email !== null) {
    const normalizedEmail = typeof body.customer_email === 'string' ? body.customer_email.trim() : '';
    if (normalizedEmail.length > 254 || !EMAIL_RE.test(normalizedEmail)) {
      return c.json({ error: 'Invalid customer_email', code: 'validation' }, 400);
    }
    customerEmail = normalizedEmail;
  }

  let customerName: string | undefined;
  if (body.customer_name !== undefined && body.customer_name !== null) {
    if (typeof body.customer_name !== 'string') {
      return c.json({ error: 'Invalid customer_name', code: 'validation' }, 400);
    }
    customerName = Array.from(body.customer_name.trim())
      .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 0x1f && codePoint !== 0x7f;
      })
      .join('')
      .slice(0, 120)
      .trim();
    if (!customerName) {
      return c.json({ error: 'Invalid customer_name', code: 'validation' }, 400);
    }
  }

  // The provider must return to the gateway, not directly to the storefront.
  // PUBLIC_API_URL is required when the storefront and Worker use different origins;
  // otherwise the origin serving this request is the correct callback origin.
  const publicApiOrigin = c.env.PUBLIC_API_URL ?? new URL(c.req.url).origin;

  // Validate buyer kennitala if provided
  let buyerKennitala: string | undefined;
  if (body.buyer_kennitala !== undefined && body.buyer_kennitala !== null) {
    if (typeof body.buyer_kennitala !== 'string') {
      return c.json({ error: 'Invalid buyer_kennitala', code: 'validation' }, 400);
    }
    const ktDigits = body.buyer_kennitala.replace(/\D/g, '');
    if (ktDigits.length !== 10 || !/^\d{10}$/.test(ktDigits)) {
      return c.json({ error: 'buyer_kennitala must be 10 digits', code: 'validation' }, 400);
    }
    // Validate the kennitala checksum before accepting payment — an invalid
    // kennitala means the order can never get an invoice (the invoice endpoint
    // returns 422). Reject early so the customer is never charged for an
    // order that can't be invoiced.
    if (!isValidKennitala(ktDigits)) {
      return c.json(
        { error: 'buyer_kennitala checksum is invalid', code: 'invalid_kennitala' },
        422,
      );
    }
    buyerKennitala = ktDigits;
  }

  const outcome = await createCheckoutUseCase(c.env, {
    idempotencyKey,
    items: body.items,
    customerEmail,
    customerName,
    buyerKennitala,
    publicApiOrigin,
    executionCtx: c.executionCtx,
  });
  return c.json(outcome.body, outcome.status, 'headers' in outcome ? outcome.headers : undefined);
});
