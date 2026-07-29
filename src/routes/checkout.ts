import { Hono } from 'hono';
import type { Env } from '../types/env';
import { CatalogError, resolveCheckoutItems } from '../lib/catalog';
import { enforceCheckoutRateLimit } from '../lib/rate-limit';
import { acceptsJson, readTextBody, RequestBodyTooLargeError } from '../lib/http';

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

  const allowedFields = new Set(['items', 'customer_email', 'customer_name']);
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

  let resolved: Awaited<ReturnType<typeof resolveCheckoutItems>>;
  try {
    resolved = await resolveCheckoutItems(c.env.DB, body.items);
  } catch (error) {
    if (error instanceof CatalogError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
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

  const { items, totalAmount, currency } = resolved;
  const {
    claimCheckoutAttempt,
    completeCheckoutAttempt,
    createOrderWithAccessToken,
    deriveOrderAccessToken,
    failCheckoutAttempt,
    generateUUID,
    generateOrderNumber,
    getOrderById,
    hashIdempotencyValue,
    reclaimStaleCheckoutAttempt,
    recordCheckoutUrl,
    updateOrderStatus,
    logPaymentEvent,
  } = await import('../lib/db');

  const orderId = generateUUID();
  const orderNumber = generateOrderNumber();
  const keyHash = await hashIdempotencyValue(idempotencyKey);
  const requestHash = await hashIdempotencyValue(
    JSON.stringify({
      items,
      customer_email: customerEmail ?? null,
      customer_name: customerName ?? null,
    }),
  );
  const claim = await claimCheckoutAttempt(c.env.DB, { keyHash, requestHash, orderId });

  if (!claim.claimed) {
    if (claim.attempt.request_hash !== requestHash) {
      return c.json(
        {
          error: 'Idempotency-Key was already used for a different checkout',
          code: 'idempotency_conflict',
        },
        409,
      );
    }
    if (claim.attempt.checkout_url) {
      const existingOrder = await getOrderById(c.env.DB, claim.attempt.order_id);
      if (!existingOrder) throw new Error('Completed checkout attempt has no order');
      return c.json({
        checkout_url: claim.attempt.checkout_url,
        order_id: existingOrder.id,
        order_number: existingOrder.order_number,
        amount: existingOrder.amount,
        currency: existingOrder.currency,
        total_amount: existingOrder.amount,
        order_status_token: await deriveOrderAccessToken(idempotencyKey, existingOrder.id),
        idempotent_replay: true,
      });
    }

    // No checkout_url yet: either genuinely in flight, previously failed, or the
    // Worker died before a provider session could have been created (checkout_url
    // is written immediately once one exists — see recordCheckoutUrl). In the last
    // case it is safe to reclaim the row and retry as a fresh claim.
    const reclaim = await reclaimStaleCheckoutAttempt(c.env.DB, { keyHash, requestHash, orderId });
    if (!reclaim.reclaimed) {
      return c.json({ error: 'Checkout attempt is not reusable', code: `idempotency_${claim.attempt.status}` }, 409, {
        'Retry-After': claim.attempt.status === 'processing' ? '2' : '0',
      });
    }
    // Reclaimed: fall through and create a fresh checkout for `orderId`.
  }

  const orderAccessToken = await deriveOrderAccessToken(idempotencyKey, orderId);
  try {
    await createOrderWithAccessToken(c.env.DB, {
      id: orderId,
      orderNumber,
      currency,
      amount: totalAmount,
      customerEmail,
      customerName,
      items,
      accessToken: orderAccessToken,
    });
  } catch (error) {
    await failCheckoutAttempt(c.env.DB, keyHash);
    throw error;
  }

  const { createCheckout } = await import('../lib/verifone');
  // The provider must return to the gateway, not directly to the storefront.
  // PUBLIC_API_URL is required when the storefront and Worker use different origins;
  // otherwise the origin serving this request is the correct callback origin.
  const publicApiOrigin = c.env.PUBLIC_API_URL ?? new URL(c.req.url).origin;
  const returnUrl = new URL('/api/return', publicApiOrigin);
  returnUrl.searchParams.set('order_id', orderId);

  let checkoutResult: { checkoutId: string; checkoutUrl: string };
  try {
    checkoutResult = await createCheckout(c.env, {
      orderNumber,
      amount: totalAmount,
      currency,
      returnUrl: returnUrl.toString(),
    });
  } catch (error) {
    console.error(JSON.stringify({ message: 'Verifone checkout creation failed', order_id: orderId }));
    await updateOrderStatus(c.env.DB, orderId, 'failed', { allowedFrom: ['pending'] });
    await failCheckoutAttempt(c.env.DB, keyHash);
    await logPaymentEvent(c.env.DB, {
      id: generateUUID(),
      orderId,
      eventType: 'checkout_creation_failed',
      source: 'verifone_api',
      rawPayload: JSON.stringify({ error_type: error instanceof Error ? error.name : 'unknown' }),
      verified: false,
    });
    return c.json({ error: 'Failed to create checkout session', code: 'checkout_provider_unavailable' }, 502);
  }

  // Persist the provider URL immediately, before any other write, so a crash from
  // here on always leaves a checkout_url behind — the reclaim path above only ever
  // touches attempts where checkout_url is still null.
  await recordCheckoutUrl(c.env.DB, keyHash, checkoutResult.checkoutUrl);

  const applied = await updateOrderStatus(c.env.DB, orderId, 'checkout_created', {
    verifoneCheckoutId: checkoutResult.checkoutId,
    allowedFrom: ['pending'],
  });
  if (!applied) {
    await failCheckoutAttempt(c.env.DB, keyHash);
    throw new Error('Checkout order changed before session persistence');
  }

  await logPaymentEvent(c.env.DB, {
    id: generateUUID(),
    orderId,
    eventType: 'checkout_created',
    source: 'verifone_api',
    verifoneEventId: checkoutResult.checkoutId,
    rawPayload: JSON.stringify({
      checkoutId: checkoutResult.checkoutId,
      amount: totalAmount,
      currency,
      item_count: items.length,
    }),
    verified: true,
  });
  await completeCheckoutAttempt(c.env.DB, keyHash, checkoutResult.checkoutUrl);

  return c.json({
    checkout_url: checkoutResult.checkoutUrl,
    order_id: orderId,
    order_number: orderNumber,
    amount: totalAmount,
    currency,
    total_amount: totalAmount,
    order_status_token: orderAccessToken,
    idempotent_replay: false,
  });
});
